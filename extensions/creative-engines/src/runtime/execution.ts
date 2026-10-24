export type ExecutionProgress = {
  stage: string;
  frames?: number;
  totalFrames?: number;
  nodeId?: string;
  nodeIndex?: number;
  totalNodes?: number;
};
export type ExecutionContext = {
  signal?: AbortSignal;
  onProgress?: (progress: ExecutionProgress) => void;
};
