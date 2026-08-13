# Creative Claw

Creative Claw is an AI agent runtime with compiled C++ media engines and a local
perception layer running **inside the agent process**. There is no media
sidecar, no co-process, and no MCP boundary between the agent and the engines:
the agent calls native image, audio, video, and vector code directly over
[koffi](https://koffi.dev) FFI.

The design in one line: **a paid frontier model orchestrates, a local model
perceives, and C++ engines execute.** The frontier model decides what to do, a
local vision/speech model turns pixels and audio into text the agent can reason
over, and the native engines do the pixel-level work in-process.

Creative Claw is a fork of [OpenClaw](https://github.com/openclaw/openclaw). It
keeps OpenClaw's multi-agent gateway and adds the media stack described below.
See [Credit and license](#credit-and-license).

## What it adds

Three bundled plugins ship the media stack. The surface counts below are the
tool and operation counts exposed by each plugin.

### `creative-engines`

- **24 agent tools** over four native C++ engines (image, audio, video, vector).
- **280 operations total**: 155 image, 45 audio, 46 video, 34 vector.
- A `creative` operator CLI (`list-ops`, `apply`, `batch`, `graph`,
  `onnx-status`).
- A `describeVideo` media-understanding provider. It extracts real keyframes and
  folds in a transcript, so spoken words and seen frames share one timeline. The
  timestamps it produces feed engine ops such as `cut_clip {start_sec, end_sec}`
  and `thumbnail {time_sec}` — that linkage between understanding and editing is
  the point of the plugin.

Neural image ops run through ONNX Runtime: real U2Net background removal, Depth
Anything v2 depth maps, colorization, and compression-artifact restoration. They
run on CPU by default and use the GPU when a CUDA 12 / cuDNN 9 runtime is
present. Not every op named `neural_*` uses a model — some are pure C++ CPU
loops. See `extensions/creative-engines/binaries/README.md` for the exact
mapping.

### `gpu-broker`

- **4 agent tools** and a `gpu` operator CLI.
- Grants short-lived VRAM leases and evicts resident Ollama models to make room,
  so neural image ops and the local vision model do not fight over the GPU.

### `visual-memory`

- **4 agent tools** and a `media` operator CLI.
- A SQLite vector store for media, with a protected-content guard.

## Local perception

- **Vision:** local, via Ollama running `qwen2.5vl:7b`.
- **Speech:** local, via faster-whisper.

Both are optional. When they are absent the affected tools report it honestly
rather than failing silently.

## Requirements

- **Node 24 recommended** (Node 22.19+ minimum).
- **ffmpeg** on `PATH` for video ops.
- **Native engine binaries** — ~1 GB of compiled engines, ONNX Runtime, and
  model weights. They are **gitignored** and must be provisioned on each machine.
  With an empty binaries directory every engine reports `available: false` and
  the rest of the runtime still works. See
  `extensions/creative-engines/binaries/README.md` for exactly what to place
  where.
- **Optional CUDA 12 + cuDNN 9** for GPU acceleration of the neural ops. This is
  Windows-only today and is an optimization, never a requirement: without it the
  neural ops run on the CPU provider, same result. On the development machine the
  GPU path costs ~771 MB of VRAM and is roughly 1.4x faster end-to-end on a large
  photo (much faster on the inference itself; most of a single call is JPEG
  decode and PNG encode that both providers pay identically).
- **Optional Ollama** for the local vision model, and a faster-whisper install
  for local speech.

## Build

Use the tsdown build entry point directly:

```bash
node scripts/tsdown-build.mjs
```

Plain `pnpm build` currently fails on an unrelated upstream extension; use the
command above until that is resolved.

## Run the gateway

Install dependencies with pnpm, then start the gateway from the source checkout:

```bash
pnpm install
node openclaw.mjs gateway --port 18789 --verbose
```

The CLI binary is named `creativeclaw` when the package is linked or installed
locally, but the package is **not published to npm** — from a source checkout you
invoke everything through the launcher, `node openclaw.mjs ...`.

Creative Claw stores its config under `~/.creativeclaw` and reads
`creativeclaw.json`, separate from any upstream OpenClaw install.

## Drive the engines from the CLI

The `creative` command is a subcommand of the main CLI. All output is JSON.

List every operation each engine exposes and whether it is available:

```bash
node openclaw.mjs creative list-ops
```

Apply a single operation to a file (grayscale an image):

```bash
node openclaw.mjs creative apply image input.jpg grayscale output.png
```

Report the ONNX Runtime and CUDA provider state — which libraries were found,
where, and what is missing:

```bash
node openclaw.mjs creative onnx-status
```

`onnx-status` reports a capability (ORT can load the CUDA provider), not a claim
that a given session ran on the GPU. It never loads a native library to answer.

Other subcommands: `creative batch` runs a pipeline over many inputs, and
`creative graph <file>` executes a node-graph of operations from JSON. Run
`node openclaw.mjs creative <command> --help` for arguments.

The sibling plugins expose their own CLIs the same way: `node openclaw.mjs gpu
...` and `node openclaw.mjs media ...`.

## Inherited from upstream

The gateway, channel integrations, companion apps, and voice features come from
OpenClaw. They are largely untested in this fork and are not part of what
Creative Claw adds. Treat anything not documented above as inherited-from-upstream
and unverified here.

## Credit and license

Creative Claw is a fork of **[OpenClaw](https://github.com/openclaw/openclaw)**,
created by Peter Steinberger and the OpenClaw community. The gateway,
multi-channel runtime, and plugin system are their work. Thank you to that
project and its contributors.

Creative Claw is released under the **MIT License**, the same license as
upstream OpenClaw. See [`LICENSE`](LICENSE) and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
