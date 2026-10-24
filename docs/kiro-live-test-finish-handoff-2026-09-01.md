---
title: "Creative Claw live-test finish handoff"
summary: "September 1, 2026 Kiro handoff for turning the working Creative Claw engines into a testable content-creator product"
---

# Creative Claw Live-Test Finish Handoff

**Date:** September 1, 2026  
**Owner for next implementation pass:** Kiro  
**Repository:** `C:\Users\billk\projects\nepa-ai-monorepo.BAK\_product-repos\creative-claw`  
**Status:** Engines and direct agent execution work; the creator product loop is not release-ready.

Read this with [the complete content-creator framework specification](./creative-claw-content-creator-framework-spec-2026-09-01.md). The specification defines the target product. This document records what the live application actually did on September 1 and gives Kiro the immediate execution queue.

## Preserve the current work

The worktree contains extensive modified and untracked implementation, including Creative Studio, dynamic Codex tools, engine composition, GPU broker, launcher tests, UI assets, `packages/creative-contracts/`, and the product specification. Treat all of it as active user work. Inspect diffs before editing, make additive changes where practical, and do not reset or replace unrelated changes.

## What was proven in the live app

The gateway and Creative Studio ran locally at `http://127.0.0.1:18789/creative`.

- Studio reported **155 image**, **45 audio**, **46 video**, and **34 vector** operations.
- All four native engine families reported available.
- GPU status rendered and reported the local GPU without requiring a resident model.
- A Studio-driven image `invert` operation executed successfully and wrote a real image artifact.
- A second image `invert` was requested through Creative Claw agent chat. The agent invoked `image_apply`, returned success, and wrote a verified 946,468-byte PNG.
- Codex CLI OAuth fallback successfully supplied the model session when local OAuth was unavailable.
- Engine RPCs such as `image.list_ops`, `audio.list_ops`, `video.list_ops`, and `vector.list_ops` worked.

This proves the native execution layer and the basic agent-to-engine bridge. It does not prove a complete content-production workflow.

## Release blockers found in the live test

### P0 — generate usable operation forms from the capability contract

Studio currently renders only input path, operation selector, and output path. Parameterized operations are therefore advertised but not practically runnable. For example, `video.cut_clip` needs start/end and related options, but Studio displayed no controls for them.

Implement one canonical capability descriptor and JSON-schema-compatible parameter contract. It must drive:

- Agent discovery.
- Studio field generation, labels, help, defaults, enums, bounds, and conditional fields.
- Request validation.
- Graph node ports and inspector controls.
- Test fixture generation.

Do not create separate handwritten parameter catalogs for the UI and agent.

**Acceptance test:** select `video.cut_clip`, receive validated start and end controls, execute against a fixture video, preview the result, and verify its duration and artifact record.

### P0 — restore compact agent capability discovery

The coding-profile tool policy removed 38 creative discovery tools during the live agent run, including the family `list_ops`, `op_info`, batch, chain, and media-understanding tools. Direct `*.apply` remained, so a known operation worked, but the agent cannot reliably discover or plan an unfamiliar creator workflow.

Expose a compact, safe discovery surface rather than injecting hundreds of operation schemas:

- `creative.capabilities.search`
- `creative.capabilities.get`
- `creative.graph.validate`
- `creative.preflight`
- Project/artifact queries

Keep mutating execution tools approval-aware. Verify the Codex profile does not filter the compact discovery tools.

**Acceptance test:** from a fresh session, ask the agent to shorten and caption an unknown video. It must discover the relevant operations, inspect the input, produce a valid plan, and explain the plan before execution without operation names in the prompt.

### P0 — finish one durable project-to-export vertical slice

Implement the smallest real creator workflow before expanding breadth:

1. Create/open a project.
2. Import source media without modifying it.
3. Inspect and register the source as an asset.
4. Ask the agent for a transformation.
5. Present an editable typed graph.
6. Validate and preflight it.
7. Execute with visible progress and cancellation.
8. Preview the output.
9. Register lineage and parameters as an artifact.
10. Export a final file and run manifest.

Use an image workflow first if necessary, then prove the same contracts with a video edit.

**Acceptance test:** restart the gateway after execution and reopen the project with its source, graph, output preview, run status, and lineage intact.

### P0 — repair the media search/understanding boundary

Creative Studio called `media_search` during initial load, but the gateway returned `unknown method: media_search`. Either register the supported method or update the Studio to use the actual versioned RPC. Do not silently swallow an unavailable capability.

**Acceptance test:** Studio can index/search a fixture media folder and the agent can locate a requested asset by metadata or visual description. When indexing is disabled, Studio presents an honest unavailable state and does not spam failed RPCs.

### P1 — make Studio a creator workspace

The current Studio is a very large operation list. Add the product surfaces required by the framework specification:

- Project and asset browser.
- Brief/chat panel.
- Typed graph canvas.
- Node inspector generated from capability schemas.
- Media preview/review panel.
- Artifact history and lineage.
- Job progress, cancel, retry, and failure details.
- Export and approval boundaries.

Keep the direct-operation screen as an advanced engine workbench; do not confuse it with the finished Studio.

### P1 — integrate Video AI/VFX as the second video system

The 46 native video operations are deterministic Video Edit. They are not the separate Video AI/VFX system. Integrate the sibling `video-agent-ai` service through the adapter defined in the framework specification before considering a rewrite.

**Acceptance test:** a typed graph can perform a deterministic edit, pass its artifact into one AI/VFX node, return progress, cancel safely, and register the final output with complete lineage.

### P1 — reduce startup and first-turn latency

Observed behavior:

- Runtime plugin prewarm took roughly 14 seconds.
- Provider authentication prewarm took roughly 19 seconds.
- A first response took roughly 42 seconds.
- A later tool turn reloaded a catalog of about 139 plugins and took over a minute.
- The process working set was observed around 1.1 GB.
- The UI logged long-animation-frame warnings.

Profile before optimizing. Cache the runtime plugin catalog across turns, avoid repeated full scans, move nonessential prewarm behind readiness, and distinguish gateway-ready from model/provider-ready.

**Acceptance test:** publish cold-start, warm-start, first-agent-turn, warm-agent-turn, and peak-memory measurements in the release report with explicit targets and regressions.

### P1 — production authentication and readiness

The live test intentionally used loopback `--auth none` with insecure control-UI authentication. That is acceptable only for local testing.

- Add a documented local-dev command.
- Add a secure production/default launch path.
- Report gateway, engines, agent runtime, model authentication, media search, GPU broker, and VFX readiness independently.
- Never label the whole product ready because the gateway socket is accepting connections.

## Creator workflows Kiro must ship as end-to-end tests

### Source video to social package

Import a horizontal source video; inspect scenes, speech, and silence; generate a proposed cut; allow graph edits; remove dead space; clean dialogue; add captions and brand overlay; export 16:9, 9:16, and thumbnail artifacts with one lineage graph.

### Talking-head cleanup

Detect useful takes, cut mistakes, normalize audio, generate/burn captions, apply deterministic color/export settings, preview, revise one parameter, and re-render only affected nodes.

### AI/VFX enhancement

Import footage, run deterministic preparation, execute a Video AI/VFX node such as matting or relighting, composite the result, preview a low-resolution proxy, then approve the final render.

### Podcast clip package

Import long audio/video, transcribe, identify a candidate segment with evidence, create the clip, add caption styling and a vector title card, mix/normalize audio, and export platform variants.

### Thumbnail variants

Extract candidate frames, apply native image operations, combine vector/text overlays, optionally call a configured image provider, retain all candidates, and select one final artifact without overwriting sources.

## Required verification command

Create one root command that reports pass, fail, supported skip, and not configured for:

- Contracts/schema validation.
- Unit, integration, and launcher tests.
- Engine availability and operation-count regression.
- Parameter-form generation.
- Agent capability discovery under the real Codex tool profile.
- Project restart/resume and artifact lineage.
- Job progress, cancellation, retry, and child-process cleanup.
- Image, audio, vector, deterministic video, and Video AI/VFX fixture workflows.
- Studio browser tests and preview rendering.
- Secure-default configuration checks.
- Cold/warm latency and memory measurements.

Do not count a listed operation as working unless its required parameters can be supplied and its output is verified. Do not count a mocked provider as a live provider test.

## Kiro implementation order

1. Preserve and inventory the current diff; run the existing tests before edits.
2. Make the capability descriptor the single source for tools, forms, graph nodes, and validation.
3. Fix Codex-profile discovery and the broken `media_search` RPC.
4. Complete a durable image project-to-export slice.
5. Complete a deterministic video project-to-export slice with parameterized controls.
6. Add the Studio project/graph/preview/artifact/job surfaces around those slices.
7. Integrate one Video AI/VFX node through the managed adapter.
8. Add the five creator workflow fixtures.
9. Remove repeated plugin loading and publish performance measurements.
10. Lock down secure defaults and run the consolidated release report.

## Definition of ready to test

Creative Claw is ready for a serious creator test when a new user can import real media, ask for an outcome without knowing operation names, inspect and edit the proposed graph, execute it with progress and cancellation, preview/revise the result, export multiple final artifacts, restart, and recover the complete project and lineage. Image, audio, vector, deterministic Video Edit, and at least one Video AI/VFX operation must participate in proven end-to-end workflows.
