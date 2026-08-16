/** Resolves daemon state, home, and generated task-script paths. */
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { APP_STATE_DIRNAME } from "../infra/app-branding.js";
import { resolveGatewayProfileSuffix } from "./constants.js";

const windowsAbsolutePath = /^[a-zA-Z]:[\\/]/;
const windowsUncPath = /^\\\\/;

/** Resolves the home directory used for daemon state paths. */
export function resolveHomeDir(env: Record<string, string | undefined>): string {
  const home = normalizeOptionalString(env.HOME) || normalizeOptionalString(env.USERPROFILE);
  if (!home) {
    throw new Error("Missing HOME");
  }
  return home;
}

function resolveUserPathWithHome(input: string, home?: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    if (!home) {
      throw new Error("Missing HOME");
    }
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, home);
    return path.resolve(expanded);
  }
  if (windowsAbsolutePath.test(trimmed) || windowsUncPath.test(trimmed)) {
    // Do not path.resolve Windows paths on POSIX hosts during cross-platform
    // service rendering; it would corrupt drive and UNC prefixes.
    return trimmed;
  }
  return path.resolve(trimmed);
}

export function resolveGatewayStateDir(env: Record<string, string | undefined>): string {
  const override = normalizeOptionalString(env.OPENCLAW_STATE_DIR);
  if (override) {
    const home = override.startsWith("~") ? resolveHomeDir(env) : undefined;
    return resolveUserPathWithHome(override, home);
  }
  const home = resolveHomeDir(env);
  const suffix = resolveGatewayProfileSuffix(env.OPENCLAW_PROFILE);
  // Profile suffixes isolate managed service files while the unsuffixed name is
  // the app's default state dir. This MUST come from the branding seam: the
  // managed service's working directory, generated `gateway.cmd` wrapper and task
  // script are all derived from here, so a hardcoded name would point launchd /
  // systemd / schtasks at a different directory than the one the config resolver
  // (src/config/paths.ts) actually uses.
  return path.join(home, `${APP_STATE_DIRNAME}${suffix}`);
}

export function resolveGatewayTaskScriptPath(env: Record<string, string | undefined>): string {
  const override = normalizeOptionalString(env.OPENCLAW_TASK_SCRIPT);
  if (override) {
    return override;
  }
  const scriptName = normalizeOptionalString(env.OPENCLAW_TASK_SCRIPT_NAME) || "gateway.cmd";
  if (/[/\\]|\.\./.test(scriptName)) {
    throw new Error(
      `OPENCLAW_TASK_SCRIPT_NAME must be a file name only, not a path: ${scriptName}`,
    );
  }
  return path.join(resolveGatewayStateDir(env), scriptName);
}
