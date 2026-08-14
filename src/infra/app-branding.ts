import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Product identity, read from the `openclawConfig` block in package.json.
 *
 * WHY THIS EXISTS
 * ---------------
 * `openclawConfig.configDir` was already a documented rebrand seam, but only
 * HALF the runtime honoured it: `src/agents/config.ts` derived `CONFIG_DIR_NAME`
 * from it, while `src/config/paths.ts` hardcoded `".openclaw"` and
 * `"openclaw.json"`. Setting the seam therefore produced a SPLIT BRAIN — the
 * agent directory moved to the new name while config and state stayed under the
 * old one — which is worse than not supporting a rename at all. Both layers now
 * read this one source.
 *
 * It lives in `infra/` because the low-level path resolver must not import from
 * `src/agents/**` (layering, and `pnpm check:import-cycles`).
 *
 * DEFAULTS ARE DELIBERATELY UNCHANGED. With no `openclawConfig` block present,
 * every value below is byte-identical to the previous hardcoded constants, so
 * this is a no-op for existing installs and for the ~1200 test assertions that
 * pin the historical names. A fork rebrands by adding the block, which is the
 * only supported way to get an isolated config directory (renaming the npm
 * `name` field instead would break every `openclaw/plugin-sdk/*` self-import).
 */

/** Shape of the package.json fields consumed here. */
interface BrandingPackageJson {
  openclawConfig?: {
    name?: string;
    configDir?: string;
    configFileName?: string;
  };
}

const DEFAULT_APP_NAME = "openclaw";
const DEFAULT_STATE_DIRNAME = ".openclaw";
const DEFAULT_CONFIG_FILENAME = "openclaw.json";

/**
 * Locate the package root by walking up from this module until a package.json
 * appears. Mirrors `getPackageDir()` in `src/agents/config.ts`, including the
 * `OPENCLAW_PACKAGE_DIR` override used by Nix/Guix store paths.
 */
function resolvePackageDir(): string | undefined {
  const envDir = process.env.OPENCLAW_PACKAGE_DIR?.trim();
  if (envDir) {
    if (envDir === "~") {
      return homedir();
    }
    return envDir.startsWith("~/") ? homedir() + envDir.slice(1) : envDir;
  }
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return undefined;
}

/**
 * Read the branding block once. NEVER THROWS: this runs during module
 * initialisation of the path resolver, which every entry point imports before
 * anything can catch, so an unreadable or malformed package.json must degrade to
 * the historical defaults rather than take the process down.
 */
function readBranding(): BrandingPackageJson["openclawConfig"] {
  try {
    const packageDir = resolvePackageDir();
    if (!packageDir) {
      return undefined;
    }
    const raw = readFileSync(join(packageDir, "package.json"), "utf-8");
    return (JSON.parse(raw) as BrandingPackageJson).openclawConfig;
  } catch {
    return undefined;
  }
}

const branding = readBranding();

/** Trimmed override, or undefined when absent/blank. */
function override(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Product name used for env-var prefixes and user-facing labels. */
export const APP_NAME: string = override(branding?.name) ?? DEFAULT_APP_NAME;

/** Home-relative state/config directory name, e.g. `.openclaw`. */
export const APP_STATE_DIRNAME: string = override(branding?.configDir) ?? DEFAULT_STATE_DIRNAME;

/**
 * Config file name inside {@link APP_STATE_DIRNAME}.
 *
 * Defaults to `<name>.json` when the fork sets a product name but no explicit
 * file name, so a rebrand does not leave a `creativeclaw` install reading a file
 * called `openclaw.json`.
 */
export const APP_CONFIG_FILENAME: string =
  override(branding?.configFileName) ??
  (APP_NAME === DEFAULT_APP_NAME ? DEFAULT_CONFIG_FILENAME : `${APP_NAME}.json`);

/** True when no rebrand is configured, i.e. the historical defaults apply. */
export const IS_DEFAULT_BRANDING: boolean =
  APP_NAME === DEFAULT_APP_NAME &&
  APP_STATE_DIRNAME === DEFAULT_STATE_DIRNAME &&
  APP_CONFIG_FILENAME === DEFAULT_CONFIG_FILENAME;
