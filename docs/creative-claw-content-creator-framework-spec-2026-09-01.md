---
summary: "Normative product and technical specification for Creative Claw as an agentic content-creator framework"
read_when:
  - Implementing Creative Claw product surfaces, tools, graphs, projects, artifacts, or workflows
  - Deciding whether a Creative Claw feature belongs in the runtime, an engine, or Creative Studio
  - Writing release tests for the complete creator experience
title: "Creative Claw content-creator framework specification"
sidebarTitle: "Creative Claw framework spec"
---

# Creative Claw Content-Creator Framework Specification

**Specification date:** September 1, 2026  
**Status:** Implementation target  
**Repository:** `C:\Users\billk\projects\nepa-ai-monorepo.BAK\_product-repos\creative-claw`  
**Implementation handoff:** [Creative Claw implementation handoff](./creative-claw-handoff-2026-08-31.md)

## 1. Product definition

Creative Claw is a local-first, agentic content-production framework built on the OpenClaw runtime. It turns a creator's intent and source assets into visible, editable, repeatable production workflows spanning text, image, audio, vector, conventional video editing, AI/VFX video processing, and provider-backed generation.

Creative Claw is not merely:

- A chat UI that calls media APIs.
- A collection of C++ operations.
- A node editor without an agent.
- A one-click template generator.
- A renamed OpenClaw dashboard.

It is the integration of all five:

1. **Creator agent** — understands the brief, media, audience, brand, and delivery requirements.
2. **Typed workflow graph** — exposes the proposed production plan for inspection and editing.
3. **Media engines** — execute deterministic and model-driven operations locally or through configured providers.
4. **Project and artifact system** — preserves sources, versions, lineage, results, and reusable templates.
5. **Creative Studio** — provides a visual workspace for chat, graph editing, media review, execution, and export.

## 2. Normative language

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative requirements.

- **MUST** identifies a release requirement.
- **SHOULD** identifies the expected design unless evidence supports an exception.
- **MAY** identifies an optional extension.

## 3. Product goals

Creative Claw MUST:

- Accept a natural-language creative brief and one or more source assets.
- Understand relevant text, image, audio, and video content before proposing destructive or expensive changes.
- Produce a visible graph that the creator can inspect and edit.
- Execute real operations and return usable media artifacts.
- Support image, audio, vector, Video Edit, and Video AI/VFX as coherent capability families.
- Incorporate configured text, image, music, speech, and video-generation providers as graph nodes.
- Preserve original source files by default.
- Track artifact lineage and operation parameters.
- Support progress, cancellation, retry, and recovery.
- Ask for approval at meaningful cost, overwrite, upload, and publish boundaries.
- Run useful workflows with local engines when no paid provider is configured.
- Allow workflows to be saved as reusable creator skills/templates.
- Produce machine-readable execution reports suitable for testing and support.

Creative Claw SHOULD:

- Prefer deterministic local operations for tasks they can perform well.
- Use model-driven processing only when it materially improves the result.
- Explain why each proposed node exists in the graph.
- Estimate required providers, models, runtime, disk usage, and likely cost before execution.
- Degrade honestly when CUDA, models, provider credentials, or optional runtimes are unavailable.

## 4. Non-goals for the first complete release

The first complete release does not need:

- A full nonlinear editor that replaces DaVinci Resolve or Premiere.
- Real-time multi-user project collaboration.
- A cloud render farm.
- Training foundation models.
- Automatic publishing to every social network.
- A marketplace for third-party workflows.
- Destructive editing of source media.
- Guaranteed pixel-identical output across different codec, driver, or provider versions.

The architecture MUST leave room for those capabilities without making them release blockers.

## 5. Primary users

### 5.1 Solo creator

Needs to transform raw footage, recordings, images, and ideas into platform-ready content without manually moving between many applications.

### 5.2 Technical creator

Needs node-level control, local models, native operations, parameter inspection, repeatability, and automation.

### 5.3 Content operator

Needs templates, batch execution, brand consistency, approval gates, artifact manifests, and predictable exports.

### 5.4 Developer or plugin author

Needs typed tool and node contracts, capability discovery, test fixtures, lifecycle hooks, and stable versioning.

## 6. Required capability model

### 6.1 Text and campaign planning

The framework MUST support non-media production work required to finish content:

- Brief extraction and clarification.
- Audience, platform, tone, and objective modeling.
- Script, outline, shot list, and storyboard creation.
- Titles, descriptions, chapters, captions, tags, and calls to action.
- Variant generation with provenance.
- Brand-voice and delivery-constraint checks.

Text outputs MUST be artifacts and MAY feed media nodes.

### 6.2 Image

Image capability MUST include:

- Native C++ editing and transformation operations.
- ONNX-backed neural operations where available.
- Provider-backed image generation and editing where configured.
- Batch processing.
- Non-destructive edit sessions with preview, confirm, and revert.
- Format conversion and platform export.
- Metadata and dimension inspection.

### 6.3 Audio

Audio capability MUST include:

- Native DSP and transformation operations.
- Extraction from and replacement into video.
- Silence detection and silence-aware editing.
- Speech transcription.
- Narration/text-to-speech through configured providers.
- Music generation through configured providers.
- Dialogue cleanup, level normalization, mixing, and export where supported.
- Waveform or equivalent review data for the Studio.

### 6.4 Vector

Vector capability MUST include:

- Existing native vector operations.
- SVG input, inspection, transformation, and export.
- Agent-created SVG artifacts that pass a strict sanitization boundary.
- Raster preview generation.
- Use in thumbnails, overlays, captions, diagrams, and brand assets.

### 6.5 Video Edit — video system one

Video Edit is the deterministic post-production system backed by the existing Creative Claw video engine and FFmpeg codec boundary.

It MUST support the catalogued operations exposed by the current engine, including:

- Probe and media inspection.
- Scene and silence detection.
- Cut and trim.
- Silence removal.
- Stabilization.
- Speed changes and ramps.
- Subtitles and caption burn-in.
- Audio extraction and replacement.
- Transitions, blends, effects, and transforms.
- Thumbnail extraction.
- Platform-specific export.

### 6.6 Video AI/VFX — video system two

Video AI/VFX is the typed node system currently implemented in the sibling `video-agent-ai` repository.

It MUST be integrated through a supported adapter before any rewrite is considered. Its capability family includes:

- Matting and background removal.
- Depth estimation.
- Normal generation.
- Relighting.
- VFX passes.
- Compositing.
- Color grading and LUT workflows.
- Video-to-video providers.
- Local and API model providers.

### 6.7 Provider-backed generation

Configured OpenClaw media providers SHOULD appear as graph nodes for:

- Text-to-image and image editing.
- Text/image/video-to-video.
- Music generation.
- Speech generation.
- Embeddings and semantic retrieval where required.

Provider-backed generation MUST use the shared job, progress, artifact, cost-estimate, and approval contracts. Provider credentials MUST remain in supported credential stores and MUST NOT be serialized into graphs or projects.

## 7. System architecture

```text
Creator
  |
  v
Creative Studio
  chat | project | graph | inspector | preview | artifacts | jobs
  |
  v
OpenClaw agent runtime
  model routing | tools | skills | sessions | approvals | task lifecycle
  |
  +----------------------+----------------------+--------------------+
  |                      |                      |                    |
  v                      v                      v                    v
Project service     Graph service         Artifact service     Job service
  |                      |                      |                    |
  +----------------------+----------------------+--------------------+
                         |
        +----------------+-----------------+----------------+
        |                |                 |                |
        v                v                 v                v
 Creative engines   Video AI/VFX      Media providers   Publishing adapters
 image/audio/       managed adapter   generation and    optional and approval-
 video/vector                        understanding      gated
```

### 7.1 Runtime ownership

The OpenClaw runtime MUST own:

- Agent sessions and model routing.
- Tool discovery and invocation.
- Skills/workflow discovery.
- Approval delivery.
- Background-task coordination.
- Credential resolution.
- Channel and client integration.

Creative Claw product services MUST own:

- Creative projects.
- Assets and artifacts.
- Workflow graphs and graph versions.
- Media-specific execution semantics.
- Preview and review state.
- Creator presets and brand profiles.
- Export manifests.

Engines and providers MUST own only their operation execution and capability-specific lifecycle.

## 8. Project model

A project is the durable unit of creator work.

```ts
interface CreativeProject {
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  rootDirectory: string;
  brief?: CreativeBrief;
  brandProfileId?: string;
  assetIds: string[];
  graphIds: string[];
  artifactIds: string[];
  activeGraphId?: string;
  tags: string[];
}
```

Project requirements:

- Project IDs MUST be stable and path-independent.
- User-facing names MAY change without invalidating references.
- Project files MUST use relative or content-addressed references rather than machine-specific absolute paths.
- Moving a project directory MUST NOT corrupt the graph.
- Sources MUST be read-only by default.
- Writes MUST go to a project-managed working or artifact directory.
- A project MUST be portable with a manifest describing missing external assets and dependencies.

## 9. Asset and artifact model

### 9.1 Asset

An asset is creator-supplied or externally acquired source material.

```ts
interface CreativeAsset {
  schemaVersion: 1;
  id: string;
  kind: "text" | "image" | "audio" | "video" | "vector" | "project-file";
  uri: string;
  contentHash: string;
  byteLength: number;
  mediaType: string;
  importedAt: string;
  metadata: Record<string, unknown>;
  source: "user" | "capture" | "download" | "generated";
}
```

Importing an asset MUST calculate identity and basic metadata without changing the source.

### 9.2 Artifact

An artifact is a versioned result or intermediate output.

```ts
interface CreativeArtifact {
  schemaVersion: 1;
  id: string;
  projectId: string;
  kind: "text" | "image" | "audio" | "video" | "vector" | "manifest" | "graph";
  role: "intermediate" | "preview" | "candidate" | "final" | "diagnostic";
  uri: string;
  mediaType: string;
  contentHash: string;
  byteLength: number;
  createdAt: string;
  createdBy: "user" | "agent" | "engine" | "provider";
  graphId?: string;
  graphRunId?: string;
  nodeId?: string;
  parentArtifactIds: string[];
  sourceAssetIds: string[];
  operation?: {
    capability: string;
    version?: string;
    parameters: Record<string, unknown>;
  };
  metadata: Record<string, unknown>;
}
```

Artifact requirements:

- Every engine or provider result MUST be registered as an artifact.
- Artifact lineage MUST identify source assets and parent artifacts.
- A final artifact MUST be reproducible when all declared runtimes, versions, and providers remain available.
- Artifact content hashes MUST be calculated after the file is finalized.
- Partial files MUST NOT be registered as successful artifacts.
- Deleting an artifact MUST require an explicit action and MUST report downstream references.
- Preview artifacts MAY have shorter retention than final artifacts.

## 10. Canonical graph contract

The typed-port model from `video-agent-ai` is the starting point. The existing Creative Claw graph is a compatible legacy subset and MUST receive an importer/migrator.

```ts
interface CreativeGraph {
  schemaVersion: 1;
  id: string;
  projectId: string;
  name: string;
  description?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  nodes: CreativeGraphNode[];
  edges: CreativeGraphEdge[];
  inputs: GraphInterfacePort[];
  outputs: GraphInterfacePort[];
  metadata: Record<string, unknown>;
}

interface CreativeGraphNode {
  id: string;
  capability: string;
  capabilityVersion?: string;
  label?: string;
  parameters: Record<string, unknown>;
  position?: { x: number; y: number };
  disabled?: boolean;
  cachePolicy?: "auto" | "always" | "never";
}

interface CreativeGraphEdge {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
}

interface GraphInterfacePort {
  name: string;
  dataType: CreativeDataType;
  required: boolean;
  description?: string;
}
```

### 10.1 Data types

The first release MUST recognize:

- `text`
- `json`
- `number`
- `boolean`
- `timecode`
- `image`
- `image-mask`
- `audio`
- `video`
- `video-mask`
- `depth-map`
- `normal-map`
- `vector`
- `subtitle-track`
- `timeline`
- `artifact-ref`
- `artifact-list`

Data types MAY carry constraints such as codec, pixel format, dimensions, frame rate, channels, sample rate, duration, alpha support, color space, or platform profile.

### 10.2 Capability descriptor

Every node type MUST be discoverable through a capability descriptor:

```ts
interface CreativeCapabilityDescriptor {
  id: string;
  version: string;
  family:
    | "text"
    | "image"
    | "audio"
    | "video-edit"
    | "video-vfx"
    | "vector"
    | "provider"
    | "utility"
    | "publish";
  label: string;
  description: string;
  inputs: Record<string, CreativePortDescriptor>;
  outputs: Record<string, CreativePortDescriptor>;
  parametersSchema: Record<string, unknown>;
  execution: {
    runtime: "native" | "node" | "python" | "provider" | "external";
    supportsProgress: boolean;
    supportsCancellation: boolean;
    deterministic: boolean;
    cacheable: boolean;
  };
  requirements: {
    binaries?: string[];
    models?: string[];
    provider?: string;
    gpu?: "none" | "optional" | "required";
  };
  risk: {
    writesFiles: boolean;
    mayOverwrite: boolean;
    externalUpload: boolean;
    publishes: boolean;
    estimatedCost?: boolean;
  };
}
```

The descriptor MUST drive agent discovery, graph validation, Studio forms, preflight, approvals, and test generation. Those consumers MUST NOT maintain separate handwritten operation catalogs.

### 10.3 Validation

Graph validation MUST detect before execution:

- Unknown capability or unsupported version.
- Missing required port or parameter.
- Type-incompatible connection.
- Cycle.
- Duplicate node or edge identifier.
- Unreachable required output.
- Invalid path or unavailable source asset.
- Missing binary, model, provider, or credential.
- Unsupported media constraint.
- Unsafe overwrite or publish target.
- Invalid subgraph interface.

Validation MUST return structured errors with node, port, parameter, severity, and suggested resolution.

### 10.4 Execution semantics

- The executor MUST use deterministic topological ordering.
- Independent nodes MAY run concurrently when resource policy permits.
- A node MUST enter exactly one terminal state: `completed`, `failed`, `cancelled`, `skipped`, or `cached`.
- Downstream nodes MUST NOT execute when required upstream inputs fail.
- Cancellation MUST propagate to child processes and providers where supported.
- A cancelled run MUST retain its trace and completed artifacts.
- Retry MUST be node-aware and MUST NOT blindly repeat non-idempotent publish actions.
- A graph run MUST capture the exact graph revision.
- The executor MUST write outputs atomically where the filesystem permits.
- Cache hits MUST verify content hashes and capability versions.

## 11. Job and progress contract

Long operations MUST use a shared job lifecycle:

```ts
type CreativeJobStatus =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "completed"
  | "failed"
  | "cancelling"
  | "cancelled";

interface CreativeProgressEvent {
  jobId: string;
  graphRunId?: string;
  nodeId?: string;
  sequence: number;
  timestamp: string;
  phase: string;
  progress?: number;
  message?: string;
  artifactId?: string;
}
```

Requirements:

- Event sequence numbers MUST be monotonic per job.
- Progress MUST NOT move backward unless a new retry attempt is identified.
- Unknown progress MUST be represented as unknown, not a fake percentage.
- Job status MUST survive Studio reconnects.
- The Studio MUST be able to cancel a running job.
- Process-backed adapters MUST prove child-process cleanup.

## 12. Video AI/VFX adapter

The first adapter MUST manage the existing `video-agent-ai` Python service and native bridge.

Required tool surface:

- `vfx.list_nodes`
- `vfx.node_info`
- `vfx.health`
- `vfx.graph_validate`
- `vfx.graph_run`
- `vfx.job_status`
- `vfx.job_cancel`

Adapter requirements:

- Discover a configured service or start a managed local service.
- Negotiate API/schema version.
- Perform readiness checks separate from process liveness.
- Translate canonical Creative Claw graph nodes to the VFX service contract.
- Translate outputs into Creative Claw artifacts.
- Stream progress through the shared job service.
- Redact provider credentials and sensitive configuration.
- Stop managed services during clean shutdown.
- Detect and report ABI incompatibility with `omni_video_bridge.dll`.

Porting Python logic into TypeScript is out of scope until adapter integration is complete and measured.

## 13. Agent behavior contract

### 13.1 Required phases

For a non-trivial creator request, the agent MUST:

1. **Interpret** — identify desired outputs, audience, platform, constraints, and available assets.
2. **Inspect** — use read-only media understanding and metadata tools.
3. **Propose** — produce a graph or a graph change set.
4. **Validate** — validate types, capabilities, resources, estimates, and risks.
5. **Present** — show the graph, expected outputs, tradeoffs, and approval boundaries.
6. **Execute** — run after required approvals.
7. **Review** — inspect outputs technically and, where possible, perceptually.
8. **Deliver** — register artifacts and summarize results, limitations, and next revisions.

The agent MAY collapse phases for an obviously safe, cheap, reversible single operation. It MUST NOT skip inspection when the request depends on media content.

### 13.2 Graph change sets

Agent proposals MUST be represented as structured changes:

- Add, remove, or replace node.
- Change parameter.
- Add or remove edge.
- Change graph input or output.
- Change export target.

The Studio MUST show these changes before applying them to an existing user-authored graph. Agent edits MUST NOT silently destroy manual layout or unrelated nodes.

### 13.3 Agent tool access

The agent MUST receive compact discovery tools rather than all 280 operation schemas in its base prompt. It SHOULD use:

- Family-level capability search.
- Operation detail lookup on demand.
- Graph validation.
- Preflight and estimate.
- Project and artifact queries.

Dynamic runtime tool identifiers MUST obey the Codex identifier contract. Dotted public tool names MAY be mapped to stable runtime-safe identifiers, with collisions and reserved names rejected deterministically.

### 13.4 Quality review

The framework MUST perform machine-verifiable checks appropriate to the artifact:

- File exists and is non-empty.
- Decoder/probe succeeds.
- Duration and dimensions match requested tolerances.
- Required audio/video streams exist.
- No unexpected clipping, silence, blank frames, or transparent output where detectable.
- Subtitle timing is valid.
- Platform profile is satisfied.

Perceptual model review MAY supplement these checks but MUST NOT replace decoding and metadata validation.

## 14. Approval policy

Approval is based on consequence, not on whether the agent or user initiated the graph.

### 14.1 No approval normally required

- Read-only inspection.
- Graph drafting and validation.
- Writing previews or new artifacts inside the project workspace.
- Reversible local transformations below configured cost limits.

### 14.2 Approval required

- Overwriting or deleting a source or final artifact.
- Starting a provider job with material cost.
- Downloading a large model or runtime.
- Uploading creator media outside the machine.
- Publishing or sending content.
- Using a new destination account.
- Executing an untrusted external plugin or binary.

Approval requests MUST state the action, exact target, provider/destination, estimated cost where available, reversibility, and affected artifacts.

## 15. Creative Studio specification

Creative Studio is the primary product surface. It MUST contain:

### 15.1 Project rail

- Project list and recent projects.
- Import assets.
- Search assets and artifacts.
- Saved workflows and brand profiles.
- Job history.

### 15.2 Creator conversation

- Natural-language brief and revisions.
- Inline references to assets, graph nodes, time ranges, and artifacts.
- Agent plan and approval cards.
- Streamed responses and job updates.
- Open-in-graph and open-in-preview actions.

### 15.3 Graph canvas

- Searchable capability palette.
- Typed ports and compatible-connection guidance.
- Pan, zoom, selection, grouping, copy/paste, undo, and redo.
- Node validation and runtime status.
- Subgraphs and reusable templates.
- Agent-proposed change visualization.
- Stable manual layout across agent edits.

The existing `video-agent-ai` ReactFlow implementation SHOULD be adapted rather than discarded.

### 15.4 Inspector

- Schema-generated controls.
- Parameter descriptions and defaults.
- Input/output media constraints.
- Runtime/provider/model requirements.
- Cost and performance indicators where available.
- Reset, compare, and revert.

### 15.5 Preview and review

- Image/vector zoom and before/after comparison.
- Audio playback and waveform.
- Video playback, scrubbing, timecode, frame capture, and before/after comparison.
- Subtitle preview.
- Intermediate-pass inspection for masks, depth, normals, and composites.
- Technical metadata.

### 15.6 Execution controls

- Validate.
- Dry run/preflight.
- Run selection.
- Run graph.
- Cancel.
- Retry failed node.
- Resume eligible run.
- Clear indication of local, GPU, provider, and cached work.

### 15.7 Artifact browser

- Thumbnail/preview.
- Role and media type.
- Source and parent lineage.
- Producing graph/node.
- Open location.
- Compare versions.
- Mark candidate/final.
- Export/download.
- Safe deletion with reference warning.

## 16. Creator workflows required at release

Every workflow MUST be an editable graph template with a natural-language invocation, fixture assets, expected artifacts, and an end-to-end test.

### 16.1 BMX long-form footage to riding selects

- Understand a long horizontal clip.
- Find all riding segments.
- Preserve the horizontal source frame.
- Cut separate selects.
- Optionally stabilize and normalize audio.
- Produce a contact sheet and machine-readable manifest.

### 16.2 Talking head to social package

- Transcribe and identify strong segments.
- Remove silence.
- Add captions.
- Reframe for 9:16 while preserving the speaker.
- Normalize dialogue and optionally mix music.
- Export Shorts/Reels/TikTok variants and thumbnails.
- Generate titles, descriptions, and captions as text artifacts.

### 16.3 AI-relit action or product clip

- Choose a frame or range.
- Generate matte, depth, and normals.
- Relight and composite.
- Grade the result.
- Preserve diagnostic passes.
- Export comparison and final video.

### 16.4 Podcast to campaign package

- Transcribe an episode.
- Identify self-contained moments.
- Create horizontal and vertical clips.
- Clean audio and add branded captions.
- Generate thumbnail candidates.
- Generate titles, descriptions, chapters, and a delivery manifest.

### 16.5 Image campaign batch

- Import a set of images.
- Apply a consistent edit profile.
- Generate or adapt brand overlays.
- Produce platform aspect ratios.
- Export web-ready variants with a manifest.

### 16.6 Prompt-directed mixed-engine workflow

Required acceptance prompt:

> Find the BMX riding sections, stabilize them, relight the dark footage, add readable captions, make vertical social versions, and create thumbnails. Show me the graph, required models, estimated work, and external costs before running it.

The result MUST use both Video Edit and Video AI/VFX, present an editable graph, request applicable approval, execute real media operations, and return playable artifacts with lineage.

## 17. Workflow templates and creator skills

A reusable workflow package MUST contain:

- Stable identifier and semantic version.
- Human description and trigger examples.
- Graph template.
- Declared inputs and outputs.
- Required and optional capabilities.
- Default parameter profile.
- Approval points.
- Validation rules.
- Fixture and expected-result assertions.
- Migration metadata.

Skills MAY include agent instructions, but critical execution behavior MUST remain represented in typed graph/tool contracts rather than prose alone.

## 18. Brand profiles

A brand profile SHOULD capture reusable creative constraints:

- Display name and voice guidance.
- Logo/vector assets.
- Colors and typography.
- Caption styles.
- Intro/outro assets.
- Safe zones and layout rules.
- Platform-specific defaults.
- Prohibited claims or content.

Brand profiles MUST reference project or library assets by stable ID. They MUST NOT contain provider credentials.

## 19. Publishing and delivery

The first release MUST produce delivery-ready local artifacts and manifests. Direct publishing is optional.

A delivery manifest SHOULD include:

- Artifact IDs and file paths.
- Platform and account intent.
- Title, description, captions, tags, and scheduled time where applicable.
- Media constraints and validation results.
- Source/project/graph lineage.
- Required approvals and approval status.

Publishing adapters MUST be separate capabilities. They MUST require explicit approval immediately before external submission and MUST return an external identifier or a structured failure.

## 20. Security and trust boundaries

- Source assets MUST be immutable by default.
- User-provided project paths MUST be normalized and constrained to explicit project/import/export roots.
- Graphs and templates MUST be treated as untrusted input until validated.
- SVG MUST be sanitized before inline rendering.
- Provider credentials MUST use supported credential stores.
- Tool results and traces MUST redact secrets.
- Child processes MUST use fixed executables and structured arguments, not shell-built command strings.
- Plugin capabilities MUST declare filesystem, network, provider, and publish effects.
- External media uploads MUST be approval-gated.
- Downloaded models and binaries SHOULD be checksum-verified.
- Project archives MUST exclude credentials and machine-local secret state.
- Agent-generated text MUST NOT be treated as executable instructions by adapters.

## 21. Resource and GPU management

The GPU broker MUST provide one authoritative resource view for native ONNX operations and AI/VFX models.

It MUST expose:

- Available device and runtime.
- Total, available, and reserved memory where measurable.
- Loaded/resident models.
- Active owner/job.
- Queue state.
- CPU fallback availability.
- Reason for a denied or delayed allocation.

The scheduler SHOULD avoid loading competing large models simultaneously. It MUST NOT report CPU fallback as GPU execution. Model unloading and job cancellation MUST release resources predictably.

## 22. Packaging and bootstrap

The supported Windows package MUST account for:

- Node application runtime.
- Creative Claw/OpenClaw runtime assets.
- Native image, audio, video, and vector DLLs.
- `omni_video_bridge.dll` and ABI version.
- Managed Python runtime and locked `video-agent-ai` dependencies.
- FFmpeg and ffprobe.
- ONNX Runtime.
- Optional CUDA/cuDNN acceleration.
- Whisper runtime and model configuration.
- Optional AI/VFX weights.
- Optional Ollama connection.
- Third-party notices and licenses.

Preflight MUST report:

- Missing or incompatible runtime.
- Missing DLL or codec.
- GPU support and CPU fallback.
- Missing model and required download size.
- Provider configuration without exposing secret values.
- Writable project/temp/export directories.
- Available disk space.

The application MUST NOT depend on accidental globally installed Python or npm packages.

## 23. Observability and support

Every graph run MUST produce a redacted trace containing:

- Project, graph, and graph revision identifiers.
- Job and node lifecycle events.
- Capability and runtime versions.
- Sanitized parameters.
- Input and output artifact IDs.
- Timing and resource data.
- Cache decisions.
- Approval decisions.
- Structured errors and retry attempts.

Support bundles MUST exclude source media and credentials by default. Inclusion of media samples MUST require explicit user choice.

## 24. Performance expectations

- Opening an existing local project SHOULD not require an LLM call.
- Browsing assets and graph metadata SHOULD remain responsive while jobs run.
- Validation SHOULD complete without executing media operations.
- Cancellation acknowledgement SHOULD be immediate even when underlying cleanup continues.
- Preview generation SHOULD use bounded-resolution proxies where appropriate.
- Large source files SHOULD be streamed or referenced, not copied repeatedly.
- The UI SHOULD remain usable when a provider or optional engine is offline.

No hard cross-machine render-time target is specified because operation, codec, model, and hardware costs vary. The framework MUST measure and report actual duration.

## 25. Compatibility and migration

- Existing `creative graph` JSON MUST remain executable during migration or receive a documented converter.
- Existing public tools such as `image.apply`, `audio.apply`, `video.apply`, and `vector.apply` MUST remain available until a versioned deprecation path exists.
- Saved projects MUST declare schema versions.
- Migrations MUST be deterministic, backup the original, and be covered by fixtures.
- Capability removal or incompatible parameter change MUST increment the capability version.
- A graph with unavailable legacy capability MUST remain inspectable and report a precise resolution path.

## 26. Test specification

### 26.1 Contract tests

- Capability descriptor validation.
- Graph serialization and migration.
- Port-type compatibility.
- Structured validation errors.
- Tool-name runtime mapping, collision, reserved-name, and length behavior.
- Job/progress ordering.
- Artifact lineage.
- Approval state transitions.

### 26.2 Native and codec tests

- Load each bundled native engine.
- Execute representative image, audio, video, and vector operations.
- Decode and inspect every produced fixture artifact.
- Verify CPU fallback and honest GPU status.
- Verify FFmpeg/ffprobe discovery.

### 26.3 Video AI/VFX tests

- Service start, health, readiness, and shutdown.
- Node discovery and schema translation.
- Graph validation.
- Live native bridge execution.
- At least one real model-backed path when configured.
- Progress and cancellation.
- ABI mismatch and missing-weight errors.
- No orphan process after success, failure, or cancellation.

### 26.4 Agent tests

- Brief-to-graph proposal with deterministic fake model.
- Required inspection before content-dependent edit.
- Approval before cost/upload/publish.
- Safe recovery from tool and provider errors.
- Graph change set preserves unrelated manual nodes and layout.
- Dynamic capability discovery without embedding the entire catalog.

### 26.5 Studio tests

- Project creation/import.
- Node search, connection, validation, and inspector editing.
- Agent graph proposal and diff application.
- Preview of image, audio, video, vector, and VFX passes.
- Run, progress, cancel, retry, and reconnect.
- Artifact comparison and export.
- Keyboard and accessibility coverage for core flows.

### 26.6 Real workflow tests

- Real MP4 Video Edit graph.
- Mixed Video Edit and Video AI/VFX graph.
- Talking-head social package.
- Podcast package.
- Image batch.
- Prompt-directed BMX acceptance workflow.

Tests MUST distinguish `pass`, `fail`, `supported skip`, and `not configured`. A missing model, GPU, or credential MUST NOT appear as a pass.

## 27. Implementation sequence

1. Freeze this specification and record intentional deviations as architecture decisions.
2. Define canonical capability, graph, job, project, asset, and artifact schemas.
3. Implement import/migration for the current Creative Claw graph.
4. Register existing native operations through capability descriptors.
5. Build the read-only Video AI/VFX adapter, then lifecycle and execution.
6. Implement mixed-engine validation and execution without Studio changes.
7. Complete supported Codex OAuth and dynamic-tool invocation.
8. Add project/artifact persistence and redacted run traces.
9. Adapt the ReactFlow canvas into Creative Studio.
10. Add preview, graph diff, execution, and artifact panels.
11. Ship the prompt-directed BMX workflow as the first complete vertical slice.
12. Add remaining release workflows, brand profiles, and delivery manifests.
13. Lock the Windows package and consolidated release command.

Every stage MUST end with a runnable vertical slice and tests. Avoid a large integration branch that changes schemas, engines, UI, and packaging without producing a real artifact.

## 28. Release definition of done

Creative Claw is a full content-creator framework when all of the following are true:

- A clean user can install, launch, and authenticate through the supported Codex OAuth flow.
- A creator can start from a prompt, source assets, or a saved workflow.
- Text, image, audio, vector, Video Edit, and Video AI/VFX capabilities are discoverable through one framework.
- The agent inspects relevant media and proposes a typed, visible graph.
- The creator can modify or approve the graph.
- One graph can execute across native Creative Claw nodes and `video-agent-ai` nodes.
- Provider-backed generation participates in the same job and artifact lifecycle.
- Progress, cancellation, retry, and reconnect work.
- Source assets remain unchanged by default.
- Every output has lineage, parameters, runtime/provider identity, and validation results.
- Costly, destructive, upload, and publish actions require meaningful approval.
- The required creator workflows execute against real fixtures and produce decoded, playable outputs.
- The Studio exposes projects, chat, graph, inspector, preview, jobs, and artifacts as one coherent workspace.
- The Windows package passes preflight and the consolidated release report on a clean user profile.
- There are no unexplained skips or UI-only claims of media success.

That is the boundary between “OpenClaw with creative tools” and the complete Creative Claw product.
