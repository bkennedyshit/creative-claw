// GPU Broker types for the state machine, config, and snapshot model.

/** The five states of the GPU broker state machine. */
export type GpuBrokerState = "idle" | "agent-active" | "user-claimed" | "draining" | "dormant";

/** Plugin configuration for the GPU broker. */
export interface GpuBrokerConfig {
  /** Base URL for the Ollama API (e.g. http://127.0.0.1:11434). */
  ollamaUrl: string;
  /** Interval in milliseconds between GPU snapshot polls. */
  pollMs: number;
  /** VRAM usage threshold (MB) above which external pressure triggers a ghost-claim. */
  externalClaimThresholdMb: number;
  /** Default lease hold duration in milliseconds before auto-expiry. */
  defaultHoldMs: number;
  /** When true the broker skips all polling and permits all agent runs. */
  dormant: boolean;
}

/** A point-in-time GPU VRAM snapshot. */
export interface GpuSnapshot {
  /** Total GPU VRAM in megabytes, or null if not available (e.g. Ollama-only). */
  totalMb: number | null;
  /** Used GPU VRAM in megabytes. */
  usedMb: number;
  /** Free GPU VRAM in megabytes, or null if not available (e.g. Ollama-only). */
  freeMb: number | null;
  /** Timestamp when this snapshot was captured. */
  timestamp: number;
}

/** Opaque lease token returned by claim(). */
export type LeaseToken = string;
