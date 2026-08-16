// Resolves plugin root directories for bundled and installed plugins.
import path from "node:path";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { APP_STATE_DIRNAME } from "../infra/app-branding.js";
import { resolveConfigDir, resolveUserPath } from "../utils.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";

export type PluginSourceRoots = {
  stock?: string;
  global: string;
  workspace?: string;
};

export type PluginCacheInputs = {
  roots: PluginSourceRoots;
  loadPaths: string[];
};

export function resolvePluginSourceRoots(params: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): PluginSourceRoots {
  const env = params.env ?? process.env;
  const workspaceRoot = params.workspaceDir ? resolveUserPath(params.workspaceDir, env) : undefined;
  const stock = resolveBundledPluginsDir(env);
  const global = path.join(resolveConfigDir(env), "extensions");
  // Workspace plugins live under the fork's own state dirname, matching the
  // branded `global` root above. Hardcoding `.openclaw` here would make a
  // rebranded install miss workspace-installed plugins under `~/.creativeclaw`.
  const workspace = workspaceRoot
    ? path.join(workspaceRoot, APP_STATE_DIRNAME, "extensions")
    : undefined;
  return { stock, global, workspace };
}

// Shared env-aware key inputs for plugin loader registry reuse.
export function resolvePluginCacheInputs(params: {
  workspaceDir?: string;
  loadPaths?: string[];
  env?: NodeJS.ProcessEnv;
}): PluginCacheInputs {
  const env = params.env ?? process.env;
  const roots = resolvePluginSourceRoots({
    workspaceDir: params.workspaceDir,
    env,
  });
  // Preserve caller order because load-path precedence follows input order.
  const loadPaths = normalizeStringEntries(
    (params.loadPaths ?? []).filter((entry): entry is string => typeof entry === "string"),
  ).map((entry) => resolveUserPath(entry, env));
  return { roots, loadPaths };
}
