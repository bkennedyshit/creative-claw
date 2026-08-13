/**
 * Media codec helpers — decode/encode only. The actual image/audio/video
 * OPERATIONS run in-process on the C++ engines via koffi; this module just
 * turns files into raw buffers and back.
 *
 * - Images : `sharp` decodes to a raw RGBA Buffer and encodes RGBA back to
 *            PNG/JPEG, preserving the alpha channel for PNG output.
 * - Audio  : `ffmpeg` transcodes to/from raw 32-bit float PCM (mono). ffmpeg is
 *            a codec, not a separate "app" orchestrated for the effect itself —
 *            the DSP runs on the C++ audio engine in-process.
 * - Video  : `ffmpeg` transcodes to/from raw RGBA frames. The per-frame effect
 *            runs on the C++ video engine in-process; ffmpeg only handles the
 *            container/codec (decode → raw frames, raw frames → encoded file).
 *
 * This keeps Creative Claw ONE app: no Python, no engine co-processes, no
 * separate servers. ffmpeg is the sole external codec dependency.
 */

import { spawn } from "node:child_process";
import { extname, isAbsolute, join } from "node:path";
import sharp from "sharp";

/** Codec configuration from plugin config. */
export interface CodecConfig {
  /** ffmpeg binary path, or a directory containing ffmpeg/ffprobe. */
  ffmpegPath?: string;
  /** ffprobe binary path (defaults alongside ffmpeg). */
  ffprobePath?: string;
}

const IS_WIN = process.platform === "win32";

function exeName(base: string): string {
  return IS_WIN ? `${base}.exe` : base;
}

/** Resolve the ffmpeg executable from config (file, directory, or PATH). */
export function resolveFfmpeg(config: CodecConfig | undefined): string {
  const p = config?.ffmpegPath;
  if (!p) {
    return "ffmpeg";
  }
  // If it points at a directory, assume the standard binary name inside it.
  if (!extname(p) && isAbsolute(p)) {
    return join(p, exeName("ffmpeg"));
  }
  return p;
}

/** Resolve the ffprobe executable, mirroring the ffmpeg location. */
export function resolveFfprobe(config: CodecConfig | undefined): string {
  if (config?.ffprobePath) {
    return config.ffprobePath;
  }
  const p = config?.ffmpegPath;
  if (p && !extname(p) && isAbsolute(p)) {
    return join(p, exeName("ffprobe"));
  }
  return "ffprobe";
}

export interface RunCaptureOptions {
  /**
   * Include stderr in the resolved buffer.
   *
   * REQUIRED FOR ffmpeg ANALYSIS FILTERS. `showinfo`, `silencedetect`,
   * `blackdetect` and friends are *logging* filters: they emit their findings
   * through ffmpeg's log, i.e. STDERR, while stdout carries the (here
   * discarded) `-f null` muxer output. Capturing stdout only yields an empty
   * buffer on a SUCCESSFUL run, so a regex over it finds nothing and the
   * analysis silently reports "no scene cuts" for every input. Verified
   * directly: this clip prints `pts_time:7.925` on stderr and exits 0, while
   * the stdout-only capture returned 0 bytes.
   */
  includeStderr?: boolean;
  /** Resolve with whatever was captured instead of rejecting on a non-zero exit. */
  allowNonZeroExit?: boolean;
}

/**
 * Run an external command, optionally feeding stdin and capturing stdout as a
 * Buffer. Rejects with a trimmed stderr message on non-zero exit unless
 * `allowNonZeroExit` is set.
 */
export function runCapture(
  bin: string,
  args: string[],
  stdin?: Buffer,
  options?: RunCaptureOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => reject(new Error(`${bin} failed to start: ${e.message}`)));
    child.on("close", (code) => {
      const captured = options?.includeStderr
        ? Buffer.concat([...out, ...err])
        : Buffer.concat(out);
      if (code === 0 || options?.allowNonZeroExit) {
        resolve(captured);
      } else {
        reject(
          new Error(`${bin} exited ${code}: ${Buffer.concat(err).toString("utf8").slice(-500)}`),
        );
      }
    });
    if (stdin) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

// ── IMAGE ────────────────────────────────────────────────────────────────

export interface RawImage {
  data: Buffer; // RGBA, length = width*height*4
  width: number;
  height: number;
  channels: 4;
}

/** Decode any image file to a raw RGBA buffer (channels forced to 4). */
export async function decodeImageRGBA(path: string): Promise<RawImage> {
  const img = sharp(path).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  // sharp with ensureAlpha() yields 4 channels.
  return { data, width: info.width, height: info.height, channels: 4 };
}

/**
 * Encode a raw RGBA buffer to a file. PNG (and other alpha-capable formats)
 * preserve alpha; JPEG is flattened onto black since it has no alpha channel.
 */
export async function encodeImageRGBA(
  data: Buffer,
  width: number,
  height: number,
  outPath: string,
): Promise<void> {
  const ext = extname(outPath).toLowerCase();
  let pipeline = sharp(data, { raw: { width, height, channels: 4 } });
  if (ext === ".jpg" || ext === ".jpeg") {
    pipeline = pipeline.flatten({ background: { r: 0, g: 0, b: 0 } }).jpeg();
  } else if (ext === ".webp") {
    pipeline = pipeline.webp();
  } else {
    pipeline = pipeline.png(); // preserves alpha
  }
  await pipeline.toFile(outPath);
}

/** Encode a single-channel `w*h` mask buffer to a grayscale PNG. */
export async function encodeMaskPNG(
  mask: Buffer,
  width: number,
  height: number,
  outPath: string,
): Promise<void> {
  await sharp(mask, { raw: { width, height, channels: 1 } })
    .png()
    .toFile(outPath);
}

// ── AUDIO ────────────────────────────────────────────────────────────────

export interface RawAudio {
  samples: Float32Array; // mono
  sampleRate: number;
}

/** Decode audio to mono 32-bit float PCM at its native sample rate. */
export async function decodeAudioF32(
  path: string,
  config: CodecConfig | undefined,
): Promise<RawAudio> {
  const sampleRate = await probeSampleRate(path, config);
  const raw = await runCapture(resolveFfmpeg(config), [
    "-v",
    "error",
    "-i",
    path,
    "-ac",
    "1",
    "-ar",
    String(sampleRate),
    "-f",
    "f32le",
    "-",
  ]);
  // Copy into an aligned ArrayBuffer: a concatenated Buffer's byteOffset is not
  // guaranteed to be a multiple of 4, which Float32Array requires.
  const floatCount = Math.floor(raw.byteLength / 4);
  const aligned = new ArrayBuffer(floatCount * 4);
  new Uint8Array(aligned).set(raw.subarray(0, floatCount * 4));
  const samples = new Float32Array(aligned);
  return { samples, sampleRate };
}

/** Encode mono float PCM back to a media file (format inferred from extension). */
export async function encodeAudioF32(
  samples: Float32Array,
  sampleRate: number,
  outPath: string,
  config: CodecConfig | undefined,
): Promise<void> {
  const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  await runCapture(
    resolveFfmpeg(config),
    ["-y", "-v", "error", "-f", "f32le", "-ar", String(sampleRate), "-ac", "1", "-i", "-", outPath],
    pcm,
  );
}

/** Probe a media file's audio sample rate (Hz); defaults to 44100 on failure. */
export async function probeSampleRate(
  path: string,
  config: CodecConfig | undefined,
): Promise<number> {
  try {
    const out = await runCapture(resolveFfprobe(config), [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=sample_rate",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
    ]);
    const rate = Number.parseInt(out.toString("utf8").trim(), 10);
    return Number.isFinite(rate) && rate > 0 ? rate : 44100;
  } catch {
    return 44100;
  }
}

// ── VIDEO ──────────────────────────────────────────────────────────────────

export interface VideoInfo {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
}

/** Probe basic video stream info via ffprobe. */
export async function probeVideo(
  path: string,
  config: CodecConfig | undefined,
): Promise<VideoInfo> {
  const out = await runCapture(resolveFfprobe(config), [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,r_frame_rate,nb_read_frames",
    "-count_frames",
    "-of",
    "default=noprint_wrappers=1",
    path,
  ]);
  const text = out.toString("utf8");
  const width = Number(/width=(\d+)/.exec(text)?.[1] ?? 0);
  const height = Number(/height=(\d+)/.exec(text)?.[1] ?? 0);
  const fpsRaw = /r_frame_rate=(\d+)\/(\d+)/.exec(text);
  const fps = fpsRaw ? Number(fpsRaw[1]) / Math.max(1, Number(fpsRaw[2])) : 30;
  const frameCount = Number(/nb_read_frames=(\d+)/.exec(text)?.[1] ?? 0);
  return { width, height, fps, frameCount };
}

/**
 * Probe a media container's duration in seconds, or undefined when ffprobe
 * cannot report it.
 *
 * Deliberately separate from {@link probeVideo}: that helper passes
 * `-count_frames`, which decodes every frame to count them. Keyframe sampling
 * only needs the container duration, so this reads `format=duration` and stays
 * O(header).
 */
export async function probeDurationSec(
  path: string,
  config: CodecConfig | undefined,
): Promise<number | undefined> {
  const out = await runCapture(resolveFfprobe(config), [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    path,
  ]);
  const duration = Number.parseFloat(out.toString("utf8").trim());
  return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

/**
 * Decode a video to raw RGBA frames. Returns one Buffer per frame
 * (`width*height*4` bytes each). Heavy for long videos — callers should keep
 * clips short or downscale first.
 */
export async function decodeVideoRGBA(
  path: string,
  config: CodecConfig | undefined,
): Promise<{ frames: Buffer[]; info: VideoInfo }> {
  const info = await probeVideo(path, config);
  const raw = await runCapture(resolveFfmpeg(config), [
    "-v",
    "error",
    "-i",
    path,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-",
  ]);
  const frameSize = info.width * info.height * 4;
  const frames: Buffer[] = [];
  if (frameSize > 0) {
    for (let off = 0; off + frameSize <= raw.byteLength; off += frameSize) {
      frames.push(raw.subarray(off, off + frameSize));
    }
  }
  return { frames, info };
}

/**
 * Encode raw RGBA frames back to a video file at the given fps. Audio from the
 * original source is muxed back in when `audioFrom` is provided.
 */
export async function encodeVideoRGBA(
  frames: Buffer[],
  width: number,
  height: number,
  fps: number,
  outPath: string,
  config: CodecConfig | undefined,
  audioFrom?: string,
): Promise<void> {
  const args = [
    "-y",
    "-v",
    "error",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-s",
    `${width}x${height}`,
    "-r",
    String(fps),
    "-i",
    "-",
  ];
  if (audioFrom) {
    args.push("-i", audioFrom, "-map", "0:v", "-map", "1:a?", "-c:a", "aac", "-shortest");
  }
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", outPath);
  await runCapture(resolveFfmpeg(config), args, Buffer.concat(frames));
}
