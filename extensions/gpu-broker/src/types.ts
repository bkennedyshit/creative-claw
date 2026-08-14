/** Broker state machine states */
export enum BrokerState {
  /** No active claims, GPU available */
  Idle = "idle",
  /** Agent is actively using GPU (local model inference) */
  AgentActive = "agent-active",
  /** User has explicitly claimed GPU via lease */
  UserClaimed = "user-claimed",
  /** Evicting models before handing off */
  Draining = "draining",
  /** Cloud LLM detected, broker inactive */
  Dormant = "dormant",
}

/** A lease token representing a user's GPU claim */
export interface Lease {
  /** ULID token identifying this lease */
  token: string;
  /** Who owns the lease */
  owner: string;
  /** When the lease was granted (epoch ms) */
  grantedAt: number;
  /** When the lease expires (epoch ms) */
  expiresAt: number;
  /** Reason for the lease */
  reason?: string;
}

/** Snapshot of GPU memory state from nvidia-smi */
export interface GpuSnapshot {
  /** VRAM currently used (MB) */
  usedMb: number;
  /** Total VRAM available (MB) */
  totalMb: number;
  /** Timestamp of this reading */
  timestamp: number;
}

/** Plugin configuration */
export interface BrokerConfig {
  /** Base URL for Ollama API */
  ollamaBaseUrl: string;
  /** Polling interval for nvidia-smi in ms */
  pollIntervalMs: number;
  /** VRAM pressure threshold to trigger ghost claim (MB) */
  externalClaimThresholdMb: number;
  /** Default lease duration in ms */
  defaultLeaseHoldMs: number;
  /** Force dormant mode */
  dormantOverride: boolean;
}

/** Ollama model info from /api/ps */
export interface OllamaModelInfo {
  name: string;
  size: number;
  /** Size in VRAM in bytes */
  size_vram: number;
}

/** History entry for state transitions */
export interface StateTransition {
  from: BrokerState;
  to: BrokerState;
  reason: string;
  timestamp: number;
}
