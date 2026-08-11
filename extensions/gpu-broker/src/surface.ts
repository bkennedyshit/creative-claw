import type { GpuBroker } from "./broker.js";
import { handleGpuStatus, handleGpuRelease, handleGpuReclaim } from "./tools.js";

/** Minimal chainable commander-style command used by the CLI registrar. */
export interface CliCommandLike {
  command: (name: string) => CliCommandLike;
  description: (text: string) => CliCommandLike;
  option: (flags: string, description?: string, defaultValue?: unknown) => CliCommandLike;
  action: (fn: (...args: unknown[]) => unknown) => CliCommandLike;
}

/** Minimal root program handed to the CLI registrar. */
export interface CliProgramLike {
  command: (name: string) => CliCommandLike;
}

/** Control UI descriptor shape (id + surface + label). */
export interface ControlUiDescriptor {
  id: string;
  surface: "session" | "tool" | "run" | "settings";
  label: string;
  description?: string;
}

/**
 * Structural view of the plugin API surfaces the operator surface uses.
 *
 * Both registrations are optional so the surface degrades honestly: a host
 * that lacks `registerCli` or `registerControlUiDescriptor` simply gets the
 * subset it supports, with no throw.
 */
export interface GpuSurfaceApi {
  registerCli?: (
    registrar: (ctx: { program: CliProgramLike }) => void,
    opts?: {
      descriptors?: Array<{ name: string; description: string; hasSubcommands: boolean }>;
    },
  ) => void;
  registerControlUiDescriptor?: (descriptor: ControlUiDescriptor) => void;
}

/**
 * Register operator-facing surfaces for the GPU broker:
 *  (a) `openclaw gpu status|release|reclaim` CLI reading live broker state.
 *  (b) A Control UI settings descriptor (`gpu-broker-status`).
 *
 * Each `register*` call is guarded by a `typeof` check so the surface no-ops
 * honestly on hosts that do not expose that seam.
 */
export function registerGpuSurface(
  api: GpuSurfaceApi,
  getBroker: () => GpuBroker | null,
): void {
  // (a) CLI surface: subcommands read live broker.getState()/getSnapshot().
  if (typeof api.registerCli === "function") {
    api.registerCli(
      ({ program }) => {
        const gpu = program
          .command("gpu")
          .description("Inspect and control the cooperative GPU broker");

        gpu
          .command("status")
          .description("Show live broker state, VRAM usage, resident models, lease, and history")
          .action(async () => {
            const broker = getBroker();
            if (!broker) {
              console.log("GPU broker not running.");
              return;
            }
            console.log(await handleGpuStatus(broker));
          });

        gpu
          .command("release")
          .description("Evict Ollama models and grant a GPU lease")
          .option("--owner <owner>", "Lease owner", "user")
          .option("--reason <reason>", "Reason for the release")
          .option("--hold <ms>", "Lease hold duration in ms")
          .action(async (rawOpts) => {
            const broker = getBroker();
            if (!broker) {
              console.log("GPU broker not running.");
              return;
            }
            // Commander hands options as an untyped object; narrow locally.
            const opts = (rawOpts ?? {}) as { owner?: string; reason?: string; hold?: string };
            const holdMs = opts.hold != null ? Number(opts.hold) : undefined;
            console.log(
              await handleGpuRelease(broker, {
                owner: opts.owner,
                reason: opts.reason,
                holdMs,
              }),
            );
          });

        gpu
          .command("reclaim")
          .description("End the active GPU lease and return the broker to idle")
          .option("--token <token>", "Lease token to reclaim")
          .action((rawOpts) => {
            const broker = getBroker();
            if (!broker) {
              console.log("GPU broker not running.");
              return;
            }
            const opts = (rawOpts ?? {}) as { token?: string };
            console.log(handleGpuReclaim(broker, { token: opts.token }));
          });
      },
      {
        descriptors: [
          {
            name: "gpu",
            description: "Inspect and control the cooperative GPU broker",
            hasSubcommands: true,
          },
        ],
      },
    );
  }

  // (b) Control UI settings surface.
  if (typeof api.registerControlUiDescriptor === "function") {
    api.registerControlUiDescriptor({
      id: "gpu-broker-status",
      surface: "settings",
      label: "GPU Broker",
      description: "Live GPU broker state, VRAM usage, resident models, and active lease.",
    });
  }
}
