// GpuBroker state machine: manages GPU VRAM arbitration between agents and user claims.
import crypto from "node:crypto";
import type { GpuBrokerConfig, GpuBrokerState, GpuSnapshot, LeaseToken } from "./types.js";

/** Minimal logger interface compatible with OpenClaw's plugin logger. */
export interface BrokerLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

/** Result of canAgentRun() check. */
export interface AgentRunGateResult {
  allowed: boolean;
  reason?: string;
}

/** Injectable GPU snapshot function for testability. */
export type SnapshotGpuFn = (ollamaUrl: string) => Promise<GpuSnapshot | null>;

const DEFAULT_CONFIG: GpuBrokerConfig = {
  ollamaUrl: "http://127.0.0.1:11434",
  pollMs: 2000,
  externalClaimThresholdMb: 512,
  defaultHoldMs: 30000,
  dormant: false,
};

/**
 * GpuBroker implements a five-state state machine for VRAM arbitration:
 * idle -> agent-active -> user-claimed -> draining -> dormant
 *
 * Ported from Polymathes core-node/src/gpu/broker.ts with minimal adaptations.
 */
export class GpuBroker {
  private state: GpuBrokerState = "idle";
  private config: GpuBrokerConfig;
  private logger: BrokerLogger;
  private snapshotFn: SnapshotGpuFn;

  private leaseToken: LeaseToken | null = null;
  private leaseExpiry: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private baselineUsedMb = 0;
  private lastSnapshot: GpuSnapshot | null = null;
  private ghostClaimed = false;

  constructor(opts: {
    config?: Partial<GpuBrokerConfig>;
    logger: BrokerLogger;
    snapshotFn: SnapshotGpuFn;
  }) {
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    this.logger = opts.logger;
    this.snapshotFn = opts.snapshotFn;

    if (this.config.dormant) {
      this.state = "dormant";
    }
  }

  /** Start the broker: capture baseline and begin polling. */
  async init(): Promise<void> {
    if (this.config.dormant) {
      this.state = "dormant";
      this.logger.info("gpu-broker: initialized in dormant mode");
      return;
    }
    await this.recalibrateBaseline();
    this.startPoll();
    this.logger.info(`gpu-broker: initialized (baseline=${String(this.baselineUsedMb)}MB)`);
  }

  /** Shut down the broker, cleaning up timers and releasing any lease. */
  shutdown(): void {
    this.stopPoll();
    this.clearLease();
    this.state = "idle";
    this.logger.info("gpu-broker: shutdown");
  }

  /** Claim the GPU with an optional hold duration. Returns a lease token. */
  claim(holdMs?: number): LeaseToken | null {
    if (this.state === "user-claimed" || this.state === "draining") {
      this.logger.warn(`gpu-broker: claim rejected in state '${this.state}'`);
      return null;
    }
    if (this.state === "dormant") {
      this.logger.warn("gpu-broker: claim rejected in dormant mode");
      return null;
    }

    const token = crypto.randomUUID();
    this.leaseToken = token;
    this.state = "user-claimed";
    this.ghostClaimed = false;

    const expiryMs = holdMs ?? this.config.defaultHoldMs;
    this.leaseExpiry = setTimeout(() => {
      this.autoExpireLease();
    }, expiryMs);

    this.logger.info(
      `gpu-broker: claimed (token=${token.slice(0, 8)}..., hold=${String(expiryMs)}ms)`,
    );
    return token;
  }

  /** Release a claim with the matching token. Returns true on success. */
  release(token: LeaseToken): boolean {
    if (this.leaseToken === null) {
      this.logger.warn("gpu-broker: release called but no active lease");
      return false;
    }
    if (this.leaseToken !== token) {
      this.logger.warn("gpu-broker: release rejected - token mismatch");
      return false;
    }

    this.clearLease();
    this.state = "idle";
    this.logger.info("gpu-broker: released");
    return true;
  }

  /** Check whether the agent is allowed to run a local-LLM job. */
  canAgentRun(): AgentRunGateResult {
    switch (this.state) {
      case "idle":
      case "agent-active":
      case "dormant":
        return { allowed: true };
      case "user-claimed":
        return { allowed: false, reason: "GPU is claimed by user" };
      case "draining":
        return { allowed: false, reason: "GPU is draining" };
    }
  }

  /** Transition to agent-active state (agent is currently running). */
  enterAgentActive(): void {
    if (this.state === "idle") {
      this.state = "agent-active";
      this.logger.info("gpu-broker: state -> agent-active");
    }
  }

  /** Transition back to idle from agent-active. */
  exitAgentActive(): void {
    if (this.state === "agent-active") {
      this.state = "idle";
      this.logger.info("gpu-broker: state -> idle");
    }
  }

  /**
   * Evacuate Ollama models by posting to /api/generate with keep_alive=0.
   * This is a best-effort operation.
   */
  async evacuateOllama(ollamaUrl?: string): Promise<boolean> {
    const url = ollamaUrl ?? this.config.ollamaUrl;
    try {
      const psResponse = await fetch(`${url}/api/ps`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!psResponse.ok) return false;

      const data = (await psResponse.json()) as { models?: Array<{ name?: string }> };
      const models = data.models;
      if (!Array.isArray(models) || models.length === 0) return true;

      for (const model of models) {
        if (!model.name) continue;
        await fetch(`${url}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: model.name, keep_alive: 0 }),
          signal: AbortSignal.timeout(5000),
        });
      }
      this.logger.info("gpu-broker: evacuated Ollama models");
      return true;
    } catch (err) {
      this.logger.error(
        `gpu-broker: evacuateOllama failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Wait for VRAM usage to drop below a threshold.
   * Polls snapshotGpu until free or timeout.
   */
  async waitForVramFree(thresholdMb: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const snapshot = await this.snapshotFn(this.config.ollamaUrl);
      if (snapshot && snapshot.usedMb <= thresholdMb) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, this.config.pollMs)));
    }
    return false;
  }

  /** Recalibrate the baseline VRAM measurement (after warmup). */
  async recalibrateBaseline(): Promise<void> {
    const snapshot = await this.snapshotFn(this.config.ollamaUrl);
    if (snapshot) {
      this.baselineUsedMb = snapshot.usedMb;
      this.lastSnapshot = snapshot;
      this.logger.info(`gpu-broker: baseline recalibrated to ${String(this.baselineUsedMb)}MB`);
    }
  }

  /** Get the latest GPU snapshot (cached from last poll). */
  getLastSnapshot(): GpuSnapshot | null {
    return this.lastSnapshot;
  }

  /** Poll once: check for external pressure (ghost-claim logic). */
  async poll(): Promise<void> {
    if (this.config.dormant) return;

    const snapshot = await this.snapshotFn(this.config.ollamaUrl);
    if (!snapshot) return;
    this.lastSnapshot = snapshot;

    const externalPressure = snapshot.usedMb - this.baselineUsedMb;

    // Ghost-claim: if external pressure exceeds threshold and no explicit claim
    if (externalPressure > this.config.externalClaimThresholdMb) {
      if (this.state === "idle" || this.state === "agent-active") {
        this.ghostClaimed = true;
        this.state = "user-claimed";
        this.logger.warn(
          `gpu-broker: ghost-claim triggered (pressure=${String(Math.round(externalPressure))}MB > threshold=${String(this.config.externalClaimThresholdMb)}MB)`,
        );
      }
    }

    // Auto-release ghost-claim when pressure drops below half the threshold
    if (this.ghostClaimed && externalPressure < this.config.externalClaimThresholdMb / 2) {
      this.ghostClaimed = false;
      this.state = "idle";
      this.logger.info("gpu-broker: ghost-claim auto-released (pressure subsided)");
    }
  }

  /** Apply a new config (e.g. on reload). */
  applyConfig(config: Partial<GpuBrokerConfig>): void {
    const wasDormant = this.config.dormant;
    this.config = { ...this.config, ...config };

    if (this.config.dormant && !wasDormant) {
      this.stopPoll();
      this.clearLease();
      this.state = "dormant";
      this.logger.info("gpu-broker: entered dormant mode via config reload");
    } else if (!this.config.dormant && wasDormant) {
      this.state = "idle";
      this.startPoll();
      this.logger.info("gpu-broker: exited dormant mode via config reload");
    } else if (!this.config.dormant) {
      // Restart poll with new interval
      this.stopPoll();
      this.startPoll();
    }
  }

  /** Return the current broker state for operator introspection. */
  getState(): {
    state: GpuBrokerState;
    leaseActive: boolean;
    ghostClaimed: boolean;
    baselineUsedMb: number;
    lastSnapshot: GpuSnapshot | null;
    config: GpuBrokerConfig;
  } {
    return {
      state: this.state,
      leaseActive: this.leaseToken !== null,
      ghostClaimed: this.ghostClaimed,
      baselineUsedMb: this.baselineUsedMb,
      lastSnapshot: this.lastSnapshot,
      config: this.config,
    };
  }

  /** Get the raw state value (for testing and gate checks). */
  getCurrentState(): GpuBrokerState {
    return this.state;
  }

  // -- Private helpers --

  private startPoll(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.config.pollMs);
  }

  private stopPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private clearLease(): void {
    this.leaseToken = null;
    if (this.leaseExpiry) {
      clearTimeout(this.leaseExpiry);
      this.leaseExpiry = null;
    }
  }

  private autoExpireLease(): void {
    this.leaseToken = null;
    this.leaseExpiry = null;
    this.state = "idle";
    this.logger.info("gpu-broker: lease auto-expired -> idle");
  }
}
