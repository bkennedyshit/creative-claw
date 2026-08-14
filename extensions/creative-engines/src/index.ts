/**
 * Internal barrel — re-exports for in-plugin use.
 * The plugin entry point is at ../index.ts (extension root).
 */

export type {
  OpCatalog,
  OpInfo,
  OpParamDef,
  Step,
  ApplyResult,
  BatchItemResult,
  RunManifest,
  EditSessionVersion,
  GraphPlan,
  GraphPlanNode,
  GraphPlanConnection,
  EngineConfig,
  CodecConfig,
  CreativeEnginesConfig,
} from "./types.js";

export { EngineRuntime } from "./runtime/engine-runtime.js";
export { ImageEngineRuntime } from "./runtime/image.js";
export { AudioEngineRuntime } from "./runtime/audio.js";
export { VideoEngineRuntime } from "./runtime/video.js";
export { VectorEngineRuntime } from "./runtime/vector.js";

// Native FFI layer.
export {
  loadEngine,
  unloadEngine,
  resolveBinaryPath,
  preloadOnnxRuntime,
  ortSidecarStatus,
  isOnnxRuntimeReady,
  onnxUnavailableReason,
  CUDA_PROVIDER_DEPENDENCIES,
  configureCudaProviderDependencies,
  ensureCudaProviderDependencies,
  cudaCandidateDirectories,
  cudaProviderDependencyStatus,
  cudaProviderDependenciesResolved,
  describeCudaProviderDependencies,
} from "./ffi/loader.js";
export type {
  KoffiLib,
  LoadResult,
  OrtSidecarStatus,
  CudaDiscoveryConfig,
  CudaDependencyStatus,
  CudaLibraryResolution,
} from "./ffi/loader.js";
export { NativeDispatch } from "./ffi/dispatch.js";
export { imageBindings, ONNX_OPS } from "./ffi/image-bindings.js";
export { audioBindings } from "./ffi/audio-bindings.js";
export { videoBindings } from "./ffi/video-bindings.js";
export { vectorBindings } from "./ffi/vector-bindings.js";
export type {
  EngineBindingModule,
  OpBinding,
  OpKind,
  FfiParam,
  OnnxOpSpec,
} from "./ffi/binding-types.js";

export {
  createVideoUnderstandingProvider,
  formatVideoDescription,
  parseVisionModelRef,
  planKeyframeTimestamps,
  resolveVisionModelRef,
  CREATIVE_ENGINES_MEDIA_PROVIDER_ID,
} from "./media/video-understanding.js";
export type {
  DescribeImageFileWithModelFn,
  FrameFailure,
  FrameObservation,
  KeyframePlan,
  VideoEngineSeam,
  VideoUnderstandingDeps,
  VideoUnderstandingPluginConfig,
  VisionModelRef,
} from "./media/video-understanding.js";

export { registerOpsTools } from "./tools/ops.js";
export { registerBatchTools } from "./tools/batch.js";
export { registerEditSessionTools } from "./image/edit-session.js";
export { registerProviders } from "./providers.js";

export {
  registerCreativeSurface,
  buildCreativeCommand,
  collectEngineOps,
  collectAcceleratorStatus,
  CREATIVE_STUDIO_DESCRIPTOR,
} from "./surface.js";
export type {
  AcceleratorStatus,
  CreativeSurfaceApi,
  CreativeEngineRecord,
  CreativeSurfaceRegistration,
  EngineOpsSummary,
} from "./surface.js";

export { PipelineExecutor } from "./graph/executor.js";
export type {
  GraphNode,
  Connection,
  Graph,
  GraphResult,
  NodeResult,
  NodeStatus,
} from "./graph/types.js";

export { withGpuClaim, withoutGpuClaim, setGpuBroker } from "./gpu-coop.js";
