# Product Invariants — Creative Claw

**Scope:** Master spec, Task 9.1 (Requirements 6.1–6.5).
Three invariants are asserted at the product level; every integration inherits
them. Each is backed by a concrete enforcement site in code.

## 1. Honesty

The suite never fakes work, never silently substitutes a different backend, and
always reports what actually ran.

- **Anti_Fake_Guard on edits.** An edit that produces no change must be reported
  as no change, not as a success. The image edit session hashes the input and
  the output (`sha256`) and compares them; identical hashes mean the op produced
  nothing.
  - _Enforced:_ `extensions/creative-engines/src/image/edit-session.ts`
    (`hashFile`, `input_hash` / `output_hash` on each `EditSessionVersion`;
    documented as "Anti_Fake_Guard: if input hash === output hash, the op
    produced no change").
- **Honest skip-with-reason.** A capability that cannot run reports
  `available: false` with a reason instead of fabricating output.
  - _Enforced:_ engine tools surface `available` + `reason`; the browser shell
    controller `extensions`/`ui/src/ui/controllers/creative-studio.ts` treats a
    missing/rejecting RPC as an **unavailable engine, not fabricated data**
    (`loadEngine` → `emptyEngine(reason)`), and GPU errors degrade to
    `defaultGpu("unavailable")`.
- **Truthful backend / engine-path reporting.** Operations report which engine /
  path executed them and whether the result is semantic or a fallback.
  - _Enforced:_ visual-memory's `Embedder` contract carries a `semantic` flag
    (`extensions/visual-memory/src/embedder/index.ts`), so a `hash` fallback is
    never presented as a real CLIP semantic recall; `getEmbedder` resolves the
    configured backend explicitly (`clip` vs `hash`).

## 2. Cpp_First

Any operation that has a C++ equivalent runs on the real C++ engine. The host
does not reimplement engine ops in TypeScript.

- **Enforced:** `extensions/creative-engines/` loads the native libraries
  in-process via koffi FFI — `ImageEngineRuntime`, `AudioEngineRuntime`,
  `VideoEngineRuntime`, `VectorEngineRuntime` (`extensions/creative-engines/index.ts`,
  `src/runtime/*`). Tools (`*.apply`, `*.apply_chain`, `*.batch`,
  `image.edit_session.*`) dispatch to these runtimes; there is no host-side pixel
  reimplementation. ffmpeg is used only to decode/encode audio & video — the
  operations themselves run in the C++ engines (see `codec` config in
  `extensions/creative-engines/openclaw.plugin.json`).
- **Observable:** when an engine's native library is absent, the tool reports
  unavailable-with-reason rather than falling back to a fake in-process
  substitute (Honesty).

## 3. Local_First

Local models are the default; data stays on the creator's machine. API keys are
optional/secondary.

- **Enforced (compute):** engines run in-process on local C++ libraries; the GPU
  broker arbitrates the **local** GPU. VRAM state comes from real `nvidia-smi`
  polling (`spawnSync` in `extensions/gpu-broker/src/broker.ts`), not an assumed
  or remote value — so "GPU busy/free" reflects the actual local device.
- **Enforced (data):** visual-memory stores vectors in a local SQLite DB under
  `~/.openclaw/visual-memory/visual-memory.sqlite`
  (`extensions/visual-memory/index.ts`); the default embedder backend is `hash`
  (fully local, no network), with `clip` as the local semantic upgrade.
- **Enforced (models):** the default embedding/CLIP backend and engine binaries
  are local; API-backed providers are opt-in secondary paths, not the default.

## Suite-wide degradation posture

When a GPU, engine binary, or model is absent, the affected step
**skips-with-reason** and the rest of the suite continues (master design
Property 5, Error Handling table). Honest degradation is always preferred over
faking a result or silently reaching for a cloud API.
