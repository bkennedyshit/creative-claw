import { spawnSync } from "node:child_process";
import {
  BrokerState,
  type BrokerConfig,
  type GpuSnapshot,
  type Lease,
  type OllamaModelInfo,
  type StateTransition,
} from "./types.js";

/** Generate a ULID-like token (monotonic sortable unique ID) */
function generateUlid(): string {
  const timestamp = Date.now().toString(36).padStart(10, "0");
  const random = Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join(
    "",
  );
  return `${timestamp}${random}`.toUpperCase();
}

const DEFAULT_CONFIG: BrokerConfig = {
  ollamaBaseUrl: "http://127.0.0.1:11434",
  pollIntervalMs: 15000,
  externalClaimThresholdMb: 10000,
  defaultLeaseHoldMs: 3600000,
  dormantOverride: false,
};

/**
 * GpuBroker — cooperative single-GPU VRAM arbiter.
 *
 * Polls nvidia-smi for memory usage, tracks Ollama model residency,
 * manages leases for user claims, and detects external VRAM pressure
 * (ghost claims).
 *
 * `canAgentRun()` is a *decision function*, not an enforcement point: nothing in
 * this plugin can currently refuse an agent run (see the note on `canAgentRun`
 * and HONESTY_FIXES.md Task 5).
 */
export class GpuBroker {
  private config: BrokerConfig;
  private state: BrokerState = BrokerState.Idle;
  private currentLease: Lease | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private baselineVramMb = 0;
  private lastSnapshot: GpuSnapshot | null = null;
  private history: StateTransition[] = [];
  private ghostClaimActive = false;

  constructor(config?: Partial<BrokerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Start the broker polling loop */
  start(): void {
    if (this.config.dormantOverride) {
      this.transition(BrokerState.Dormant, "dormant override enabled");
      return;
    }
    this.calibrateBaseline();
    this.pollTimer = setInterval(() => this.poll(), this.config.pollIntervalMs);
    this.poll();
  }

  /** Stop the broker and clean up timers */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  /** Get the current broker state */
  getState(): BrokerState {
    return this.state;
  }

  /** Get the current lease, if any */
  getLease(): Lease | null {
    return this.currentLease;
  }

  /** Get the latest GPU snapshot */
  getSnapshot(): GpuSnapshot | null {
    return this.lastSnapshot;
  }

  /** Get state transition history (last 50) */
  getHistory(): StateTransition[] {
    return this.history.slice(-50);
  }

  /** Get the current baseline VRAM */
  getBaselineVramMb(): number {
    return this.baselineVramMb;
  }

  /** Whether a ghost claim is currently active */
  isGhostClaimActive(): boolean {
    return this.ghostClaimActive;
  }

  /**
   * Advisory GPU-availability check — returns false when the GPU is
   * user-claimed or draining, meaning the agent should not attempt local GPU
   * inference.
   *
   * ADVISORY ONLY. This value is reported through `gpu.status` and the CLI and
   * appended as a bootstrap notice; it does not and cannot block a run from
   * where it is consumed today. Enforcing it requires the `before_agent_run`
   * gate hook or a trusted tool policy — see HONESTY_FIXES.md Task 5.
   */
  canAgentRun(): boolean {
    return this.state !== BrokerState.UserClaimed && this.state !== BrokerState.Draining;
  }

  /**
   * Release GPU for user: evict Ollama models, create lease.
   * Returns the lease token.
   */
  async release(owner: string, reason?: string, holdMs?: number): Promise<Lease> {
    this.transition(BrokerState.Draining, `release requested by ${owner}`);

    await this.evictAllModels();

    const hold = holdMs ?? this.config.defaultLeaseHoldMs;
    const now = Date.now();
    const lease: Lease = {
      token: generateUlid(),
      owner,
      grantedAt: now,
      expiresAt: now + hold,
      reason,
    };
    this.currentLease = lease;
    this.transition(BrokerState.UserClaimed, `lease granted to ${owner}`);

    this.scheduleExpiry(hold);
    return lease;
  }

  /**
   * Reclaim GPU from user: end lease, return to idle.
   * Returns true if a lease was active and reclaimed.
   */
  reclaim(token?: string): boolean {
    if (!this.currentLease) {
      return false;
    }
    if (token && this.currentLease.token !== token) {
      return false;
    }

    this.currentLease = null;
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    this.ghostClaimActive = false;
    this.transition(BrokerState.Idle, "lease reclaimed");
    return true;
  }

  /**
   * Handoff: evict models, call a peer, then reclaim.
   */
  async handoff(owner: string, peerFn: () => Promise<void>, reason?: string): Promise<void> {
    const lease = await this.release(owner, reason);
    try {
      await peerFn();
    } finally {
      this.reclaim(lease.token);
    }
  }

  /** Enter dormant mode (e.g., when cloud LLM detected) */
  enterDormant(reason = "cloud LLM detected"): void {
    this.transition(BrokerState.Dormant, reason);
  }

  /** Exit dormant mode */
  exitDormant(): void {
    if (this.state === BrokerState.Dormant) {
      this.transition(BrokerState.Idle, "exiting dormant mode");
    }
  }

  /** Recalibrate the VRAM baseline from current snapshot */
  calibrateBaseline(): void {
    const snapshot = this.readGpuSnapshot();
    if (snapshot) {
      this.baselineVramMb = snapshot.usedMb;
      this.lastSnapshot = snapshot;
    }
  }

  /** Set config dynamically */
  updateConfig(config: Partial<BrokerConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.dormantOverride) {
      this.transition(BrokerState.Dormant, "dormant override set");
    }
  }

  // --- Internal ---

  private poll(): void {
    if (this.state === BrokerState.Dormant || this.state === BrokerState.Draining) {
      return;
    }

    const snapshot = this.readGpuSnapshot();
    if (!snapshot) {
      return;
    }
    this.lastSnapshot = snapshot;

    this.evaluateGhostClaim(snapshot);
  }

  private async evaluateGhostClaim(snapshot: GpuSnapshot): Promise<void> {
    const ollamaFootprint = await this.getOllamaFootprintMb();
    const externalPressure = snapshot.usedMb - this.baselineVramMb - ollamaFootprint;
    const threshold = this.config.externalClaimThresholdMb;

    if (!this.ghostClaimActive && externalPressure > threshold) {
      this.ghostClaimActive = true;
      this.transition(
        BrokerState.UserClaimed,
        `ghost claim: external pressure ${Math.round(externalPressure)}MB > ${threshold}MB threshold`,
      );
    } else if (this.ghostClaimActive && externalPressure < threshold / 2) {
      this.ghostClaimActive = false;
      this.currentLease = null;
      this.transition(
        BrokerState.Idle,
        `ghost claim released: pressure ${Math.round(externalPressure)}MB < ${threshold / 2}MB`,
      );
    }
  }

  /** Read GPU memory via nvidia-smi */
  readGpuSnapshot(): GpuSnapshot | null {
    const result = spawnSync("nvidia-smi", [
      "--query-gpu=memory.used,memory.total",
      "--format=csv,noheader,nounits",
    ]);

    if (result.status !== 0 || result.error) {
      return null;
    }

    const output = result.stdout.toString().trim();
    const [usedStr, totalStr] = output.split(",").map((s) => s.trim());
    const usedMb = Number.parseInt(usedStr, 10);
    const totalMb = Number.parseInt(totalStr, 10);

    if (Number.isNaN(usedMb) || Number.isNaN(totalMb)) {
      return null;
    }

    return { usedMb, totalMb, timestamp: Date.now() };
  }

  /** Get total Ollama model VRAM footprint in MB */
  async getOllamaFootprintMb(): Promise<number> {
    try {
      const res = await fetch(`${this.config.ollamaBaseUrl}/api/ps`);
      if (!res.ok) {
        return 0;
      }
      const data = (await res.json()) as { models?: OllamaModelInfo[] };
      if (!data.models || data.models.length === 0) {
        return 0;
      }
      // Prefer the real per-model `size_vram` reported by /api/ps (bytes → MB).
      // Heuristic fallback: a model missing `size_vram` contributes 0 rather
      // than a guessed size, so we never over-subtract phantom Ollama usage and
      // mistake genuine external pressure for our own footprint.
      return data.models.reduce((sum, m) => sum + (m.size_vram ?? 0) / (1024 * 1024), 0);
    } catch {
      return 0;
    }
  }

  /** Get list of currently loaded Ollama models */
  async getResidentModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.config.ollamaBaseUrl}/api/ps`);
      if (!res.ok) {
        return [];
      }
      const data = (await res.json()) as { models?: OllamaModelInfo[] };
      return data.models?.map((m) => m.name) ?? [];
    } catch {
      return [];
    }
  }

  /** Evict all resident Ollama models by sending keep_alive:0 */
  async evictAllModels(): Promise<void> {
    const models = await this.getResidentModels();
    await Promise.allSettled(models.map((model) => this.evictModel(model)));
  }

  private async evictModel(model: string): Promise<void> {
    try {
      await fetch(`${this.config.ollamaBaseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, keep_alive: 0 }),
      });
    } catch {
      // Best-effort eviction
    }
  }

  /** Transition state and record history */
  private transition(to: BrokerState, reason: string): void {
    if (this.state === to) {
      return;
    }
    const entry: StateTransition = {
      from: this.state,
      to,
      reason,
      timestamp: Date.now(),
    };
    this.history.push(entry);
    if (this.history.length > 100) {
      this.history = this.history.slice(-50);
    }
    this.state = to;
  }

  /** Schedule lease auto-expiry */
  private scheduleExpiry(holdMs: number): void {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
    }
    this.expiryTimer = setTimeout(() => {
      if (this.state === BrokerState.UserClaimed && this.currentLease) {
        this.currentLease = null;
        this.ghostClaimActive = false;
        this.transition(BrokerState.Idle, "lease expired");
      }
    }, holdMs);
  }
}
