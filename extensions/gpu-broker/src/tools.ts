import type { GpuBroker } from "./broker.js";

/**
 * gpu.status — returns current GPU broker state, VRAM info, loaded models, and history.
 */
export async function handleGpuStatus(broker: GpuBroker): Promise<string> {
  const state = broker.getState();
  const lease = broker.getLease();
  const snapshot = broker.getSnapshot();
  const history = broker.getHistory();
  const models = await broker.getResidentModels();

  const result = {
    state,
    ghostClaimActive: broker.isGhostClaimActive(),
    canAgentRun: broker.canAgentRun(),
    vram: snapshot
      ? {
          usedMb: snapshot.usedMb,
          totalMb: snapshot.totalMb,
          freeMb: snapshot.totalMb - snapshot.usedMb,
          baselineMb: broker.getBaselineVramMb(),
          lastPollAt: new Date(snapshot.timestamp).toISOString(),
        }
      : null,
    lease: lease
      ? {
          token: lease.token,
          owner: lease.owner,
          grantedAt: new Date(lease.grantedAt).toISOString(),
          expiresAt: new Date(lease.expiresAt).toISOString(),
          reason: lease.reason,
        }
      : null,
    residentModels: models,
    recentHistory: history.slice(-10).map((h) => ({
      from: h.from,
      to: h.to,
      reason: h.reason,
      at: new Date(h.timestamp).toISOString(),
    })),
  };

  return JSON.stringify(result, null, 2);
}

/**
 * gpu.release — evacuate Ollama models and grant a lease to the caller.
 */
export async function handleGpuRelease(
  broker: GpuBroker,
  args: { owner?: string; reason?: string; holdMs?: number },
): Promise<string> {
  const owner = args.owner ?? "user";
  const lease = await broker.release(owner, args.reason, args.holdMs);

  return JSON.stringify(
    {
      success: true,
      message: `GPU released. All Ollama models evicted. Lease granted to "${owner}".`,
      lease: {
        token: lease.token,
        owner: lease.owner,
        expiresAt: new Date(lease.expiresAt).toISOString(),
      },
    },
    null,
    2,
  );
}

/**
 * gpu.reclaim — end the current lease and return GPU to idle.
 */
export function handleGpuReclaim(broker: GpuBroker, args: { token?: string }): string {
  const success = broker.reclaim(args.token);

  if (success) {
    return JSON.stringify({
      success: true,
      message: "GPU reclaimed. Broker returned to idle.",
      state: broker.getState(),
    });
  }

  return JSON.stringify({
    success: false,
    message: args.token
      ? "No matching lease found for the provided token."
      : "No active lease to reclaim.",
    state: broker.getState(),
  });
}

/**
 * gpu.handoff — evacuate models, call peer workflow, then reclaim.
 */
export async function handleGpuHandoff(
  broker: GpuBroker,
  args: { owner?: string; reason?: string; peerDurationMs?: number },
): Promise<string> {
  const owner = args.owner ?? "peer";
  const duration = args.peerDurationMs ?? 0;

  const peerFn = async () => {
    if (duration > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, duration);
      });
    }
  };

  await broker.handoff(owner, peerFn, args.reason);

  return JSON.stringify({
    success: true,
    message: `Handoff complete. GPU evacuated for "${owner}", peer work done, lease reclaimed.`,
    state: broker.getState(),
  });
}
