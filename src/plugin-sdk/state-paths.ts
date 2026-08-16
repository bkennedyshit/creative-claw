// Public state/config path helpers for plugins that persist small caches.

/**
 * `APP_STATE_DIRNAME` / `APP_CONFIG_FILENAME` are exported here because plugins
 * (and their tests) otherwise have no sanctioned way to *name* the state dir:
 * `src/infra/app-branding.ts` is core-internal and importing it from
 * `extensions/**` breaks the package boundary. Without this seam, bundled plugin
 * tests hardcode `.openclaw`, which silently diverges from the resolver the
 * moment a fork sets the branding block — exactly the split brain
 * `app-branding.ts` exists to prevent.
 *
 * Prefer `resolveStateDir()` for building paths; use these only when the
 * directory or file *name* itself is needed.
 */
export { APP_CONFIG_FILENAME, APP_STATE_DIRNAME } from "../infra/app-branding.js";
export { resolveOAuthDir, resolveStateDir, STATE_DIR } from "../config/paths.js";
export { resolveRequiredHomeDir } from "../infra/home-dir.js";
