#!/usr/bin/env python3
"""
Local ASR shim for the HOST's media-understanding CLI seam.

WHAT THIS IS
------------
A stdout-only transcriber that the OpenClaw host runs as a `type: "cli"` audio
model entry (`MediaUnderstandingModelConfig` in `src/config/types.tools.ts`,
executed by `runCliEntry` in `src/media-understanding/runner.entries.ts`). The
host already supports local transcription this way and even auto-discovers
`whisper`, `whisper-cli` (whisper.cpp) and `sherpa-onnx-offline` on PATH. None of
those binaries exist on every machine, but `faster-whisper` is frequently already
installed as a LIBRARY with CTranslate2 model weights already in the Hugging Face
cache. This script is the missing console entry point for that case.

WHAT THIS IS NOT
----------------
It is NOT part of the creative engines. The engines are compiled C++ libraries
loaded in-process via koffi; the audio engine has 45 DSP ops and none of them is
ASR. The `creative-engines` media-understanding provider deliberately does NOT
implement `transcribeAudio` — see `src/providers.ts`. Nothing in the plugin
imports or spawns this file. It exists so the USER can point
`tools.media.audio.models[]` at a real local transcriber; the plugin then reads
the resulting transcript back through the host runtime like any other caller.

HONESTY RULES
-------------
  * Never prints a fabricated or placeholder transcript.
  * A missing model, a missing dependency, or a decode failure exits NON-ZERO
    with the missing piece named on stderr. `runExec` turns that into a failed
    attempt the host records with the reason attached.
  * Genuinely silent / speechless audio prints NOTHING and exits 0. The host
    records that as `skipped: empty output`, which is the truth — it is not an
    error, and it must not become an empty "success".
  * `local_files_only` by default: it will not silently download gigabytes.
    Pass `--allow-download` to opt in.

OUTPUT FORMAT
-------------
One line per speech segment, seconds first:

    [t=8.53s | 00:08.530] If you liked the bunny hop from this video, ...

Seconds are the unit the video engine takes (`video.apply cut_clip
{start_sec,end_sec}`, `video.apply thumbnail {time_sec}`), which is the point:
the orchestrator can act on a quoted line directly. `--format plain` drops the
timestamps, `--format json` emits one JSON object with a `text` field (the shape
the host's `sherpa-onnx-offline` extractor understands).

USAGE (as a host audio model entry)
-----------------------------------
    {
      "type": "cli",
      "command": "python",
      "args": [
        "<abs path to this file>",
        "--model", "base",
        "--language", "en",
        "{{MediaPath}}"
      ]
    }

Templating (`{{MediaPath}}`, `{{Prompt}}`, `{{Language}}`, `{{OutputDir}}`,
`{{OutputBase}}`) is applied by the host before exec.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

EXIT_OK = 0
EXIT_BAD_USAGE = 2
EXIT_MISSING_DEPENDENCY = 3
EXIT_MISSING_MODEL = 4
EXIT_TRANSCRIBE_FAILED = 5

DEFAULT_MODEL = "base"


def fail(exit_code: int, message: str) -> "None":
    print(f"faster-whisper-cli: {message}", file=sys.stderr)
    raise SystemExit(exit_code)


def format_clock(seconds: float) -> str:
    minutes = int(seconds // 60)
    remainder = seconds - minutes * 60
    return f"{minutes:02d}:{remainder:06.3f}"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="faster-whisper-cli",
        description="Transcribe one media file locally with faster-whisper and print the transcript to stdout.",
    )
    parser.add_argument("media", help="Path to the audio or video file to transcribe.")
    parser.add_argument(
        "--model",
        default=os.environ.get("CREATIVE_ENGINES_WHISPER_MODEL", DEFAULT_MODEL),
        help="faster-whisper model size or a local CTranslate2 model directory. Default 'base'.",
    )
    parser.add_argument(
        "--device",
        default=os.environ.get("CREATIVE_ENGINES_WHISPER_DEVICE", "auto"),
        choices=("auto", "cuda", "cpu"),
        help="'auto' tries CUDA and falls back to CPU, reporting the fallback on stderr.",
    )
    parser.add_argument(
        "--compute",
        default=os.environ.get("CREATIVE_ENGINES_WHISPER_COMPUTE", ""),
        help="CTranslate2 compute type. Default float16 on CUDA, int8 on CPU.",
    )
    parser.add_argument(
        "--language",
        default=os.environ.get("CREATIVE_ENGINES_WHISPER_LANGUAGE", ""),
        help="Language hint, e.g. 'en'. Empty means auto-detect.",
    )
    parser.add_argument("--beam-size", type=int, default=1, help="Beam size. Default 1 (greedy).")
    parser.add_argument(
        "--no-vad",
        action="store_true",
        help="Disable the voice-activity filter (keeps more, hallucinates more on music).",
    )
    parser.add_argument(
        "--format",
        default="timestamped",
        choices=("timestamped", "plain", "json"),
        help="Output shape. Default 'timestamped'.",
    )
    parser.add_argument(
        "--allow-download",
        action="store_true",
        help="Permit fetching the model from Hugging Face. Off by default so no multi-GB surprise.",
    )
    return parser


def resolve_compute(device: str, requested: str) -> str:
    if requested.strip():
        return requested.strip()
    return "float16" if device == "cuda" else "int8"


def import_whisper_model():
    try:
        from faster_whisper import WhisperModel
    except Exception as err:  # noqa: BLE001 - reported verbatim, never swallowed
        fail(
            EXIT_MISSING_DEPENDENCY,
            "faster_whisper is not importable in this interpreter "
            f"({sys.executable}): {type(err).__name__}: {err}. "
            "Install it with: pip install faster-whisper",
        )
    return WhisperModel


def transcribe_on_device(params: dict):
    """
    Load the model AND fully materialize its segments on one device.

    Load and inference are deliberately in the same unit of work. CTranslate2
    resolves its CUDA BLAS library lazily at the first GEMM, not at model
    construction, so a machine whose only `cublas64_12.dll` comes from a
    third-party directory on PATH (e.g. Ollama's bundled CUDA runtime) can build
    the model on CUDA and only then raise
    `Library cublas64_12.dll is not found or cannot be loaded`. Observed on the
    verification machine under GPU contention. Materializing here means the CPU
    fallback below actually catches that case instead of letting it escape as a
    hard failure.
    """
    WhisperModel = params["model_class"]
    args = params["args"]
    model = WhisperModel(
        args.model,
        device=params["device"],
        compute_type=params["compute"],
        local_files_only=not args.allow_download,
    )
    segments, info = model.transcribe(
        args.media,
        beam_size=args.beam_size,
        vad_filter=not args.no_vad,
        language=args.language.strip() or None,
    )
    collected = [
        (float(segment.start), float(segment.end), segment.text.strip()) for segment in segments
    ]
    return collected, info


def main(argv: "list[str]") -> int:
    args = build_parser().parse_args(argv)

    if not os.path.isfile(args.media):
        fail(EXIT_BAD_USAGE, f"media file not found: {args.media}")

    model_class = import_whisper_model()
    if not args.allow_download:
        # Belt and braces: `local_files_only` covers faster-whisper's own
        # download path, HF_HUB_OFFLINE covers anything it delegates.
        os.environ.setdefault("HF_HUB_OFFLINE", "1")

    devices = ("cuda", "cpu") if args.device == "auto" else (args.device,)
    collected: "list[tuple[float, float, str]] | None" = None
    info = None
    device = ""
    compute = ""
    last_error: "Exception | None" = None
    for candidate in devices:
        device = candidate
        compute = resolve_compute(candidate, args.compute)
        try:
            collected, info = transcribe_on_device(
                {"model_class": model_class, "args": args, "device": candidate, "compute": compute}
            )
            break
        except Exception as err:  # noqa: BLE001
            last_error = err
            if candidate != devices[-1]:
                print(
                    f"faster-whisper-cli: {candidate}/{compute} failed "
                    f"({type(err).__name__}: {err}); falling back to the next device",
                    file=sys.stderr,
                )

    if collected is None:
        fail(
            EXIT_MISSING_MODEL if isinstance(last_error, (OSError, ValueError)) else EXIT_TRANSCRIBE_FAILED,
            f"could not transcribe {args.media} with model '{args.model}' on "
            f"{'/'.join(devices)}: {type(last_error).__name__}: {last_error}. "
            "If the weights are not in the Hugging Face cache yet, re-run once with "
            "--allow-download (faster-whisper 'base' is ~139 MB, 'small.en' ~461 MB).",
        )

    spoken = [entry for entry in collected if entry[2]]
    print(
        f"faster-whisper-cli: model={args.model} device={device} compute={compute} "
        f"language={getattr(info, 'language', '?')} duration={getattr(info, 'duration', 0):.2f}s "
        f"segments={len(spoken)}",
        file=sys.stderr,
    )

    if not spoken:
        # Truthful empty result. The host records `skipped: empty output`; it must
        # not be dressed up as a transcript.
        print(
            "faster-whisper-cli: no speech detected - emitting no transcript",
            file=sys.stderr,
        )
        return EXIT_OK

    if args.format == "json":
        print(
            json.dumps(
                {
                    "text": " ".join(text for _start, _end, text in spoken),
                    "segments": [
                        {"start": round(start, 3), "end": round(end, 3), "text": text}
                        for start, end, text in spoken
                    ],
                }
            )
        )
        return EXIT_OK

    for start, _end, text in spoken:
        if args.format == "plain":
            print(text)
        else:
            print(f"[t={round(start, 3)}s | {format_clock(start)}] {text}")
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
