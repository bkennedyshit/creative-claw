import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME, APP_NAME as AGENT_APP_NAME } from "../agents/config.js";
import {
  APP_CONFIG_FILENAME,
  APP_NAME,
  APP_STATE_DIRNAME,
  IS_DEFAULT_BRANDING,
  resolveBranding,
} from "./app-branding.js";

/**
 * This file is the ONE place allowed to pin the historical literal names. Every
 * other test asserts against the exported constants, so a rebrand does not
 * require editing ~1200 assertions and no test silently re-encodes the default
 * strings (which would make it tautological once the fork moved off them).
 *
 * The exported constants are read from the real package.json `openclawConfig`
 * block, so these assertions also document the fork's configured identity.
 */
describe("app branding", () => {
  it("matches the configured package.json openclawConfig block", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf-8")) as {
      openclawConfig?: { name?: string; configDir?: string; configFileName?: string };
    };
    const configured = resolveBranding(pkg.openclawConfig);
    expect(APP_NAME).toBe(configured.appName);
    expect(APP_STATE_DIRNAME).toBe(configured.stateDirname);
    expect(APP_CONFIG_FILENAME).toBe(configured.configFilename);
    expect(IS_DEFAULT_BRANDING).toBe(configured.isDefault);
  });

  /**
   * Split-brain regression guard. The bug this repo fixed: `src/agents/config.ts`
   * derived its own dir name from the seam while `src/config/paths.ts` hardcoded
   * `.openclaw`, so setting the seam moved the agent dir but left config/state
   * under the old name. Both layers must resolve to the SAME identity.
   */
  it("is the single source shared with the agent config layer", () => {
    expect(CONFIG_DIR_NAME).toBe(APP_STATE_DIRNAME);
    expect(AGENT_APP_NAME).toBe(APP_NAME);
  });

  /**
   * An unbranded install (no `openclawConfig` block) must still get the exact
   * historical names, byte-for-byte — this is what keeps the seam a no-op for
   * upstream OpenClaw and every existing user. Proven by calling the pure
   * resolver with an empty config rather than by mutating package.json on disk.
   */
  it("resolves the historical defaults when no rebrand is configured", () => {
    const unbranded = resolveBranding(undefined);
    expect(unbranded.appName).toBe("openclaw");
    expect(unbranded.stateDirname).toBe(".openclaw");
    expect(unbranded.configFilename).toBe("openclaw.json");
    expect(unbranded.isDefault).toBe(true);

    // Blank/whitespace overrides fall back to defaults, never to empty names.
    const blank = resolveBranding({ name: "  ", configDir: "" });
    expect(blank.appName).toBe("openclaw");
    expect(blank.stateDirname).toBe(".openclaw");
  });

  /**
   * A fork that sets only a product name gets an isolated `<name>.json`, never a
   * stale `openclaw.json`, so its config cannot collide with an upstream file.
   */
  it("derives a per-product config filename from the product name", () => {
    const branded = resolveBranding({ name: "creativeclaw", configDir: ".creativeclaw" });
    expect(branded.appName).toBe("creativeclaw");
    expect(branded.stateDirname).toBe(".creativeclaw");
    expect(branded.configFilename).toBe("creativeclaw.json");
    expect(branded.isDefault).toBe(false);
  });
});
