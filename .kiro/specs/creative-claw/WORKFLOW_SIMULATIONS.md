# Creative Claw — Workflow Simulations & Interaction Model

Simulated real creator workflows mapped to the spec'd tool surfaces. This documents what the Unified Agent says, what fires silently, tool call order, and UX friction points for each persona.

---

## Workspace Convention (all workflows assume this)

```
~/creative/
├── content/          ← finished, brand-owned (warn_on_edit=true)
│   ├── brand-a/
│   │   ├── posts/   ← published IG/TikTok stills
│   │   ├── reels/   ← published short-form video
│   │   └── audio/   ← shipped podcast/voiceover
│   └── brand-b/
├── input/            ← raw source material
│   ├── photos/      ← camera rolls, screenshots
│   ├── footage/     ← raw video clips
│   ├── audio/       ← raw recordings, stems
│   └── vectors/     ← SVG source files, logos
├── output/           ← agent-generated results (safe to overwrite)
│   ├── drafts/
│   ├── exports/
│   └── batch-runs/
└── archive/          ← old versions, superseded
```

---

## WORKFLOW 1: Social Media Creator — Static Image Posts

**Persona:** Instagram/Pinterest content creator. Daily workflow: take raw photos, apply brand-consistent edits, resize for platforms, batch export.

### Scenario 1A: "Make my latest photo post-ready"

**Creator says:** "Take the photo I just shot (input/photos/product-flat-lay-raw.jpg), make it warmer, boost saturation, add a slight grain, and export at 1080x1080 for Instagram."

**Agent interaction:**

| Step | Agent says (visible) | Tool calls (silent) | Notes |
|------|---------------------|--------------------|----|
| 1 | "I'll set up an edit session for that photo." | `image.edit_session.plan` — sends the NL instruction + image path to the planner | Planner (the agent itself per OQ3) decides: color_temperature → adjust_vibrance → film_grain → crop+scale |
| 2 | _(silent)_ | `gpu.status` — check if broker needs VRAM for any model pass | Pure C++ ops here, no GPU claim needed |
| 3 | "Here's my plan: warm the color temperature, boost vibrance, add subtle film grain, then crop to 1:1 at 1080px. Applying now..." | `image.edit_session.preview` — executes the chain on the C++ engine | Calls `image.apply_chain(input, [{filter: "color_temperature", params: {shift: 15}}, {filter: "adjust_vibrance", params: {amount: 25}}, {filter: "film_grain", params: {intensity: 0.15}}, {filter: "crop", params: {aspect: "1:1"}}, {filter: "scale", params: {width: 1080, height: 1080}}], output/drafts/product-flat-lay-edit.jpg)` |
| 4 | "Preview ready — [shows result in studio viewer]. Confirm or adjust?" | Studio UI shows before/after | **UX DECISION:** does the agent auto-confirm or wait? Per edit_session spec: user confirms. |
| 5 | **Creator:** "Looks good, confirm it" | `image.edit_session.confirm` | Result becomes the working image (stacking). Version saved. |
| 6 | "Done. Saved to `output/drafts/product-flat-lay-edit.jpg`. Engine: C++ (color_temperature + adjust_vibrance + film_grain + crop + scale). All local." | _(none)_ | Honest reporting per Req 7.4 |

**Tool call sequence:** `image.edit_session.plan` → `gpu.status` → `image.apply_chain` (inside preview) → `image.edit_session.confirm`

---

### Scenario 1B: "Batch resize my latest 20 photos for Pinterest"

**Creator says:** "Take everything in input/photos/june-shoot/ and export them all as 1000x1500 Pinterest pins with the vintage style applied."

| Step | Agent says | Tool calls | Notes |
|------|-----------|-----------|-------|
| 1 | "I'll batch process the 20 photos in that folder. Pipeline: apply vintage style transfer + scale to 1000×1500." | `image.batch` with input_set=`input/photos/june-shoot/*.{jpg,png}`, pipeline=[{filter: "apply_style_transfer", params: {style: "vintage"}}, {filter: "scale", params: {width: 1000, height: 1500}}], output_dir=`output/batch-runs/pinterest-june/` | Single batch call |
| 2 | _(running, may take 30-60s for 20 images)_ | `gpu.status` → `gpu.release` if style_transfer uses a model pass | Style transfer may need GPU. Broker coordinates. |
| 3 | "Batch complete. 18/20 succeeded, 2 skipped (corrupt EXIF). Results in `output/batch-runs/pinterest-june/`. Run manifest saved." | `gpu.reclaim` if claimed | Reports per-item honestly |
| 4 | "Would you like me to index these into your visual memory so you can search them later?" | _(awaiting)_ | Agent suggests but doesn't auto-index |
| 5 | **Creator:** "Yeah index them" | `media_index` path=`output/batch-runs/pinterest-june/` | Pathmeta: workspace=output, intent=post, brand inferred from parent |

**UX friction points:**
- Batch progress: no streaming progress in v1 (batch returns when done). Consider a progress callback in the node-graph later.
- The 2 skipped items: agent reports the filenames + reasons (e.g. "product-07.jpg: EXIF read error, file may be truncated").

---

### Scenario 1C: "Find that brand-a product shot from last month and upscale it"

**Creator says:** "Find that clean product shot I did for brand-a, the one with the white background. Upscale it 4x."

| Step | Agent says | Tool calls | Notes |
|------|-----------|-----------|-------|
| 1 | "Searching your visual memory..." | `media_search` query="clean product shot white background brand-a" | CLIP semantic search if available, hash fallback otherwise |
| 2 | "Found 3 matches. Top result: `content/brand-a/posts/product-white-bg-march.jpg` (score: 0.87). Is this the one?" | _(shows thumbnail in studio)_ | |
| 3 | **Creator:** "That's it, upscale it" | | |
| 4 | "⚠️ That file is in `content/brand-a/` — finished, brand-owned work. I'll upscale to a NEW file rather than overwriting. OK?" | _(warn_on_edit triggered by pathmeta)_ | **KEY UX:** agent respects warn_on_edit |
| 5 | **Creator:** "Yeah output it separately" | `gpu.status` → `gpu.release` (Real-ESRGAN needs VRAM) → `image.apply` op="upscale" with Real-ESRGAN binary → `gpu.reclaim` | GPU broker coordinates the model-heavy upscale |
| 6 | "Upscaled 4x. Saved to `output/exports/product-white-bg-march-4x.png`. Engine: Real-ESRGAN (model pass, local GPU). Original untouched." | | Honest: reports model pass, not C++ |

**Tool call sequence:** `media_search` → (user confirms) → `gpu.release` → `image.apply(upscale)` → `gpu.reclaim`

---

## WORKFLOW 2: Video Creator — Short-Form Content

**Persona:** YouTube Shorts / TikTok / Reels creator. Workflow: import raw clips, trim/cut, apply effects, mix audio, export.

### Scenario 2A: "Cut my raw footage into a 30-second reel"

**Creator says:** "I have a 5-minute raw clip at input/footage/gym-session-raw.mp4. Pull out the best 30 seconds, add a speed ramp in the middle, and slap a bass-boosted version of input/audio/beat-drop.wav on it."

| Step | Agent says | Tool calls | Notes |
|------|-----------|-----------|-------|
| 1 | "Let me analyze the footage for interesting segments..." | `video.apply_op` op="detect_scenes" input=`input/footage/gym-session-raw.mp4` | Scene detection is a C++ op |
| 2 | "Found 8 scenes. I'll select the 3 most dynamic (scenes 2, 5, 7 based on motion scores) and assemble a 30s cut." | `video.apply_chain` steps=[{op: "trim", params: {scenes: [2,5,7]}}, {op: "speed_ramp", params: {ramp_at: 0.5, factor: 2.0}}, {op: "concat"}] input=raw, output=`output/drafts/gym-reel-cut.mp4` | Chain: trim+speed_ramp+concat in one pass |
| 3 | "Now processing the audio..." | `audio.apply_effect` effect="bass_boost" input=`input/audio/beat-drop.wav` output=`output/drafts/beat-drop-boosted.wav` params={gain_db: 6, freq_hz: 80} | Audio engine, separate |
| 4 | "Mixing audio onto the video..." | `video.apply_op` op="mix_audio" input=`output/drafts/gym-reel-cut.mp4` params={audio_path: "output/drafts/beat-drop-boosted.wav", volume: 0.8} output=`output/drafts/gym-reel-final.mp4` | Video engine handles mux |
| 5 | "Done. 30-second reel at `output/drafts/gym-reel-final.mp4`. All processed locally via C++ video engine + C++ audio engine. No cloud." | | Honest multi-engine reporting |

**Tool call sequence:** `video.apply_op(detect_scenes)` → `video.apply_chain(trim+speed_ramp+concat)` → `audio.apply_effect(bass_boost)` → `video.apply_op(mix_audio)`

**UX friction points:**
- Scene detection quality: pure C++ motion heuristics, no AI model. Good enough for cuts; won't understand "the best moments" semantically. Agent should be honest: "I selected based on motion/scene-change scores, not content understanding."
- No real-time preview: file-path in/out means the creator sees the result after processing, not during.

---

### Scenario 2B: "Batch add subtitles to all my reels this week"

**Creator says:** "I have 7 reels in input/footage/week-28-reels/. Add burned-in subtitles to all of them."

| Step | Agent says | Tool calls | Notes |
|------|-----------|-----------|-------|
| 1 | "I'll batch process all 7 clips. Pipeline: extract speech → generate SRT → burn subtitles." | `video.batch` input_set=`input/footage/week-28-reels/*.mp4`, pipeline=[{op: "extract_audio"}, {op: "transcribe"}, {op: "burn_subtitles"}], output_dir=`output/batch-runs/subtitled-week28/` | |
| 2 | _(processing)_ | `gpu.status` — transcription may need Whisper model | If Whisper model absent: skip-with-reason |
| 3 | "5/7 complete. 2 skipped: 'reel-04.mp4' — no speech detected; 'reel-06.mp4' — Whisper model not installed (transcription unavailable, would need `whisper-base` in models/)." | | Honest degradation: names exact missing dep |
| 4 | "Manifests and results in `output/batch-runs/subtitled-week28/`." | | |

**Key honest-degradation example:** The agent doesn't fake subtitles. It names the exact model needed.

---

## WORKFLOW 3: Brand Designer — Vector + Image Combined

**Persona:** Freelance designer making logos, icon sets, brand kits. Works across vector (SVG/path ops) and image (rasterization, compositing).

### Scenario 3A: "Create an icon set from my logo"

**Creator says:** "Take the brand-b logo at input/vectors/brand-b-logo.svg, create 5 size variants (16, 32, 64, 128, 512px), and export each as both SVG and PNG."

| Step | Agent says | Tool calls | Notes |
|------|-----------|-----------|-------|
| 1 | "I'll process the SVG through the vector engine for scaling, then rasterize each to PNG via the image engine." | | Cross-engine workflow |
| 2 | _(silent)_ | `vector.apply_chain` steps=[{op: "scale", params: {target: 16}}, {op: "export_svg"}] × 5 sizes | Vector engine: SVG path operations, true vector scaling |
| 3 | _(silent)_ | `image.batch` input_set=exported SVGs, pipeline=[{filter: "scale", params: {width: N, height: N}}] → PNG output | Image engine: rasterization |
| 4 | "Icon set generated. 5 sizes × 2 formats = 10 files in `output/exports/brand-b-icons/`. Vector scaling via C++ vector engine, rasterization via C++ image engine." | | |

**Tool call sequence:** `vector.apply_chain` ×5 → `image.batch` (rasterize)

---

### Scenario 3B: "That old logo needs the curves smoothed and colors tweaked"

**Creator says:** "Smooth out the curves on input/vectors/brand-b-logo-draft.svg — it's too jaggy. Then adjust the fill color to our brand blue (#1a73e8)."

| Step | Agent says | Tool calls | Notes |
|------|-----------|-----------|-------|
| 1 | "I'll smooth the path curves and update the fill color." | `vector.list_ops` (verify smooth/color ops available) | |
| 2 | _(silent)_ | `vector.apply_chain` input=`input/vectors/brand-b-logo-draft.svg` steps=[{op: "smooth_paths", params: {factor: 0.7}}, {op: "recolor", params: {from: "#333333", to: "#1a73e8"}}] output=`output/drafts/brand-b-logo-smooth.svg` | |
| 3 | "Smoothed and recolored. Saved to `output/drafts/brand-b-logo-smooth.svg`. Engine: C++ vector (smooth_paths + recolor)." | | |

---

### Scenario 3C: "Composite the logo onto a product mockup"

**Creator says:** "Put the brand-b logo (the one with removed background) on top of that product mockup photo at input/photos/tshirt-mockup.jpg"

| Step | Agent says | Tool calls | Notes |
|------|-----------|-----------|-------|
| 1 | "I'll find the logo with transparency and composite it onto the mockup." | `media_search` query="brand-b logo transparent background" | Visual memory finds the right asset |
| 2 | "Found: `content/brand-b/assets/logo-nobg.png`. ⚠️ This is finished brand work — I'll read it but not modify it." | | warn_on_edit respected |
| 3 | _(silent)_ | `image.apply_chain` input=`input/photos/tshirt-mockup.jpg` steps=[{filter: "composite_layer", params: {overlay: "content/brand-b/assets/logo-nobg.png", position: "center", scale: 0.3, blend: "normal"}}] output=`output/drafts/tshirt-branded.jpg` | Image engine compositing |
| 4 | "Composited. Logo placed center at 30% scale on the mockup. Saved to `output/drafts/tshirt-branded.jpg`." | | |

**Tool call sequence:** `media_search` → `image.apply_chain(composite_layer)`

---

## WORKFLOW 4: Cross-Media Project — All Engines + Memory + Broker

**Persona:** Full content pipeline. Making a brand launch package: video trailer + static posts + audio jingle + logo on everything.

### Scenario 4A: "Full brand launch package"

**Creator says:** "I'm launching brand-c. I need: (1) take the logo SVG and make icon variants, (2) create 5 Instagram posts from the product photos, (3) add a cinematic grade + the jingle to the launch video, (4) index everything into memory when done."

This is the master spec's unified end-to-end (Req 8.1):

| Step | Agent says | Tool calls | Notes |
|------|-----------|-----------|-------|
| **Phase 1: Vector — logo variants** | | | |
| 1 | "Starting with the logo. Creating icon variants from the SVG." | `vector.apply_chain` ×5 sizes, `image.batch` for PNG rasterization | Same as 3A |
| **Phase 2: Image — Instagram posts** | | | |
| 2 | "Processing the 5 product photos for Instagram..." | `image.batch` input=`input/photos/brand-c-launch/*.jpg`, pipeline=[{filter: "apply_style_transfer", params: {style: "cinematic"}}, {filter: "crop", params: {aspect: "1:1"}}, {filter: "scale", params: {width: 1080}}], output=`output/batch-runs/brand-c-posts/` | |
| 3 | `gpu.release` → (style transfer model) → `gpu.reclaim` | | Broker manages GPU for the model pass |
| **Phase 3: Audio — process jingle** | | | |
| 4 | "Processing the launch jingle..." | `audio.apply_chain` input=`input/audio/brand-c-jingle-raw.wav` steps=[{effect: "normalize", params: {target_db: -14}}, {effect: "compress", params: {threshold: -20, ratio: 4}}, {effect: "fade", params: {in_ms: 500, out_ms: 1000}}] output=`output/drafts/brand-c-jingle-master.wav` | Audio engine |
| **Phase 4: Video — launch trailer** | | | |
| 5 | "Now the launch video. Adding cinematic grade + the mastered jingle..." | `video.apply_chain` input=`input/footage/brand-c-trailer-raw.mp4` steps=[{op: "color_grade", params: {lut: "cinematic"}}, {op: "mix_audio", params: {audio_path: "output/drafts/brand-c-jingle-master.wav"}}] output=`output/drafts/brand-c-trailer-final.mp4` | Video engine |
| **Phase 5: Memory — index everything** | | | |
| 6 | "All assets generated. Indexing into visual memory..." | `media_index` path=`output/batch-runs/brand-c-posts/` + `media_index` path=`output/drafts/` (brand-c items) | CLIP indexing for future recall |
| 7 | `gpu.release` (CLIP needs VRAM) → index → `gpu.reclaim` | | Broker manages CLIP's GPU use |
| **Done** | | | |
| 8 | "Brand-c launch package complete. Summary:\n- 10 icon files (5 SVG + 5 PNG)\n- 5 Instagram posts (cinematic, 1080×1080)\n- 1 mastered jingle (normalized, compressed, faded)\n- 1 launch trailer (graded + jingle)\n- All indexed in visual memory (24 assets)\n\nEngines used: vector (C++), image (C++ + model for style_transfer), audio (C++), video (C++). All local." | | Full honest report |

**Complete tool call sequence:**
```
vector.apply_chain ×5 → image.batch (rasterize) →
image.batch (style+crop+scale) → gpu.release → [model] → gpu.reclaim →
audio.apply_chain (normalize+compress+fade) →
video.apply_chain (color_grade+mix_audio) →
gpu.release → media_index ×2 → gpu.reclaim
```

---

### Scenario 4B: "User claims GPU mid-session"

**Creator says:** _(opens DaVinci Resolve while the agent is working)_

| Step | What happens | Tool calls | Notes |
|------|-------------|-----------|-------|
| 1 | Broker detects VRAM spike (Resolve loaded) | `gpu.status` poll detects external pressure → Ghost_Claim auto-taken | Silent broker behavior |
| 2 | Agent was about to run style_transfer (needs GPU) | Agent_Run_Gate blocks the model-heavy op | |
| 3 | Agent says: "I notice DaVinci Resolve (or another app) just claimed your GPU. I'll defer GPU-heavy operations. The C++ ops that don't need VRAM will continue." | | Honest, not blocked on everything |
| 4 | Pure C++ ops (crop, scale, color_temperature) keep running | | Req 8.3: pure C++ needs no broker claim |
| 5 | _(creator closes Resolve)_ | Broker detects pressure drop → auto-releases Ghost_Claim | |
| 6 | "GPU is free again. Resuming the style transfer batch..." | `gpu.release` → model pass → `gpu.reclaim` | |

---

## INTERACTION MODEL — Summary

### What the agent says vs. what fires silently

| Category | Agent says (user-visible) | Fires silently |
|----------|--------------------------|----------------|
| **Planning** | "Here's my plan: [ops]" | `*.list_ops` / `gpu.status` |
| **Execution** | "Applying now..." / "Processing..." | `*.apply` / `*.apply_chain` / `*.batch` |
| **GPU** | Only when blocked: "GPU claimed by X, deferring" | `gpu.release` / `gpu.reclaim` / ghost-claim |
| **Memory** | "Searching your catalog..." / "Found N matches" | `media_search` / `media_index` |
| **Warnings** | "⚠️ That's finished work (content/). I'll output separately." | `warn_on_edit` check from pathmeta |
| **Honesty** | "2 items skipped: [reasons]" / "Whisper model not installed" | Anti_Fake_Guard / skip-with-reason |
| **Done** | "Saved to [path]. Engine: [C++ / model]. All local." | _(nothing)_ |

### Tool call ordering rules

1. **Always check GPU first** for model-heavy ops (upscale, style_transfer, CLIP, transcription)
2. **Never claim GPU** for pure C++ ops (color, crop, blur, filters, vector path ops)
3. **Visual memory search before edit** when the creator references an asset by description
4. **warn_on_edit before any write to content/** — always offer an alternative output path
5. **Batch returns honestly** — one failure never aborts; skipped items get reasons
6. **Report engine path at the end** — which engine, C++ vs model, local vs API

### UX Friction Points Identified

| Friction | Severity | Mitigation |
|----------|----------|-----------|
| No streaming progress for batch/chain ops | Medium | Could add a progress hook in node-graph v2; for now agent says "processing..." |
| Edit session requires explicit confirm | Low | Good UX — prevents accidental overwrites. Agent can suggest "confirm" |
| GPU claim blocks model ops entirely | Medium | Agent continues C++ ops; honest message about what's deferred |
| No real-time video preview | Medium | File-path architecture means playback happens in the studio viewer after processing |
| Hash embedder in visual memory (no CLIP weights) | High | Agent clearly states "non-semantic search — results may not match meaning, only filename/path patterns" |
| Scene detection is motion-based, not content-aware | Low | Agent is honest: "selected by motion scores" not "best moments" |
| warn_on_edit may be overly cautious | Low | Agent can say "override? I'll still save to output/" — never blocks permanently |

### Silent vs. Prompted decisions

| Decision | Silent (agent decides) | Prompted (asks creator) |
|----------|----------------------|------------------------|
| Which engine to route to | ✅ (based on file type + op) | |
| GPU claim/release for model ops | ✅ | |
| Output path (respects workspace convention) | ✅ (outputs to output/) | |
| Edit confirmation (edit_session) | | ✅ |
| Overwriting content/ files | | ✅ (warn_on_edit) |
| Indexing results into memory | | ✅ (suggests, doesn't auto-index unless auto-capture is on) |
| Choosing between C++ op and model pass | ✅ (Cpp_First: always prefers C++) | |
| Handling missing dependency | ✅ (skip-with-reason) | |

---

## NODE-GRAPH: Cross-Engine Pipeline (Advanced)

For the brand-launch scenario (4A), the entire workflow could be expressed as a single node-graph:

```json
{
  "name": "brand-c-launch",
  "nodes": [
    {"id": "logo-scale", "engine": "vector", "op": "scale", "params": {"sizes": [16,32,64,128,512]}},
    {"id": "logo-rasterize", "engine": "image", "op": "batch_scale", "depends": ["logo-scale"]},
    {"id": "posts-style", "engine": "image", "op": "batch_chain", "pipeline": ["cinematic","crop_1:1","scale_1080"]},
    {"id": "jingle-master", "engine": "audio", "op": "chain", "pipeline": ["normalize","compress","fade"]},
    {"id": "trailer-grade", "engine": "video", "op": "chain", "pipeline": ["color_grade","mix_audio"], "depends": ["jingle-master"]},
    {"id": "index-all", "engine": "memory", "op": "media_index", "depends": ["logo-rasterize","posts-style","trailer-grade"]}
  ]
}
```

Called via: `creative.graph.run` with this graph definition. The PipelineExecutor handles dependency ordering (topo-sort), per-node status reporting, and failure isolation (one node failing doesn't abort unrelated branches).

---

## MAPPING TO SPEC REQUIREMENTS

| Workflow | Validates Requirements |
|----------|----------------------|
| 1A (single image edit) | Engines Req 3 (edit_session), Req 7 (honesty) |
| 1B (batch resize) | Engines Req 4 (batch), GPU Req 8 (cooperation) |
| 1C (find + upscale) | Visual Memory Req 4 (media_search), Req 3 (warn_on_edit), GPU Req 2 (tools) |
| 2A (video + audio) | Engines Req 2 (multi-engine ops), Req 1 (long-lived runtime) |
| 2B (batch subtitles) | Engines Req 4 (batch honesty), Req 7 (honest degradation) |
| 3A (vector + image cross) | Engines Req 2 (op catalog), Req 6 (provider registration) |
| 3C (memory + composite) | Visual Memory Req 4 + Engines Req 2 + Umbrella Req 4 (unified agent) |
| 4A (full launch) | **Umbrella Req 8** (end-to-end acceptance), Req 4 (unified agent) |
| 4B (GPU mid-claim) | GPU Req 3 (agent-run gate), Req 4 (ghost-claim), Engines Req 8 |
