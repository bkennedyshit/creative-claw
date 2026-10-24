import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ExecutionContext } from "../runtime/execution.js";
import { resolveFfmpeg, resolveFfprobe, runCapture, type CodecConfig } from "./codec.js";

export async function probeVideoStream(input: string, codec?: CodecConfig) {
  const probe = JSON.parse(
    (
      await runCapture(resolveFfprobe(codec), [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,avg_frame_rate,r_frame_rate:stream_side_data=rotation:format=duration",
        "-of",
        "json",
        input,
      ])
    ).toString("utf8"),
  ) as {
    streams?: {
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      side_data_list?: { rotation?: number }[];
    }[];
    format?: { duration?: string };
  };
  const stream = probe.streams?.[0];
  const rate = (value?: string) => {
    const [a, b] = (value ?? "0/0").split("/").map(Number);
    return a / b;
  };
  const fps = rate(stream?.avg_frame_rate) || rate(stream?.r_frame_rate);
  let width = stream?.width ?? 0;
  let height = stream?.height ?? 0;
  if (
    Math.abs(stream?.side_data_list?.find((side) => side.rotation !== undefined)?.rotation ?? 0) %
      180 ===
    90
  ) {
    [width, height] = [height, width];
  }
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 16777216 ||
    !Number.isFinite(fps) ||
    fps <= 0 ||
    fps > 240
  ) {
    throw new Error("Unsupported video dimensions or frame rate (maximum 16 megapixels, 240 fps)");
  }
  const duration = Number(probe.format?.duration);
  return {
    width,
    height,
    fps,
    totalFrames:
      Number.isFinite(duration) && duration > 0
        ? Math.max(1, Math.round(duration * fps))
        : undefined,
  };
}

function completion(child: ChildProcess, name: string) {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4096);
  });
  const promise = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${name} exited ${code}: ${stderr}`)),
    );
  });
  // Attach rejection handlers immediately; either process can fail while the
  // other is still processing a native frame, before its promise is awaited.
  void promise.catch(() => {});
  return promise;
}

/** Bounded frame pipeline: one assembled input and one processed frame, with pipe backpressure. */
export async function transformVideoFrames(
  input: string,
  output: string,
  process: (frame: Buffer, width: number, height: number, index: number) => Promise<Buffer>,
  codec?: CodecConfig,
  context: ExecutionContext = {},
  outputSize?: (width: number, height: number) => { width: number; height: number },
) {
  context.signal?.throwIfAborted();
  const info = await probeVideoStream(input, codec);
  const size = outputSize?.(info.width, info.height) ?? info;
  if (
    !Number.isInteger(size.width) ||
    !Number.isInteger(size.height) ||
    size.width < 1 ||
    size.height < 1 ||
    size.width * size.height > 16777216
  ) {
    throw new Error("Unsupported output video dimensions");
  }
  context.signal?.throwIfAborted();
  const temp = join(dirname(output), `.${basename(output)}.${randomUUID()}.partial.mp4`);
  const ffmpeg = resolveFfmpeg(codec);
  const decoder = spawn(
    ffmpeg,
    [
      "-v",
      "error",
      "-i",
      input,
      "-map",
      "0:v:0",
      "-vf",
      `fps=${info.fps}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const encoder = spawn(
    ffmpeg,
    [
      "-v",
      "error",
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      `${size.width}x${size.height}`,
      "-r",
      String(info.fps),
      "-i",
      "pipe:0",
      "-i",
      input,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0?",
      "-vf",
      "pad=ceil(iw/2)*2:ceil(ih/2)*2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-movflags",
      "+faststart",
      temp,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  const decoded = completion(decoder, "Video decoder");
  const encoded = completion(encoder, "Video encoder");
  const abort = () => {
    decoder.kill();
    encoder.kill();
  };
  context.signal?.addEventListener("abort", abort, { once: true });
  encoder.stdin.on("error", () => {});
  let frames = 0;
  try {
    const frameBytes = info.width * info.height * 4;
    let frame = Buffer.allocUnsafe(frameBytes);
    let offset = 0;
    for await (const part of decoder.stdout) {
      const chunk = part as Buffer;
      let cursor = 0;
      while (cursor < chunk.length) {
        context.signal?.throwIfAborted();
        const count = Math.min(frameBytes - offset, chunk.length - cursor);
        chunk.copy(frame, offset, cursor, cursor + count);
        cursor += count;
        offset += count;
        if (offset !== frameBytes) {
          continue;
        }
        const result = await process(frame, info.width, info.height, frames);
        context.signal?.throwIfAborted();
        if (result.length !== size.width * size.height * 4) {
          throw new Error("Frame processor changed dimensions without declaring an output size");
        }
        // Wait for this buffer to be consumed before reusing/mutating its memory.
        await new Promise<void>((resolve, reject) => {
          encoder.stdin.write(result, (error) => (error ? reject(error) : resolve()));
        });
        frames++;
        context.onProgress?.({ stage: "processing", frames, totalFrames: info.totalFrames });
        frame = Buffer.allocUnsafe(frameBytes);
        offset = 0;
      }
    }
    context.signal?.throwIfAborted();
    if (offset) {
      throw new Error("Decoder returned a truncated video frame");
    }
    if (!frames) {
      throw new Error("Video contains no decodable frames");
    }
    await decoded;
    context.onProgress?.({ stage: "encoding", frames, totalFrames: info.totalFrames });
    encoder.stdin.end();
    await encoded;
    context.signal?.throwIfAborted();
    await copyFile(temp, output, constants.COPYFILE_EXCL);
    return { ...info, frames };
  } finally {
    context.signal?.removeEventListener("abort", abort);
    abort();
    await Promise.allSettled([decoded, encoded]);
    await rm(temp, { force: true });
  }
}
