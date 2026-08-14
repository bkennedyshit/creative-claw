import { describe, it, expect } from "vitest";
import { CONFIG_DIR_NAME, APP_NAME as AGENT_APP_NAME } from "../agents/config.js";
import { APP_NAME, APP_STATE_DIRNAME, APP_CONFIG_FILENAME } from "./app-branding.js";

/**
 * These assertions are the contract that made it safe to replace the hardcoded
 * `".openclaw"` / `"openclaw.json"` literals in `src/config/paths.ts` with the
 * package.json branding seam: with no `openclawConfig` block configured, every
 * value must stay byte-identical to the historical constants. Roughly 1200
 * assertions across the core suites depend on those exact names, so a drift here
 * would break config discovery for every existing install.
 */
describe("app branding defaults", () => {
  it("keeps the historical names when no rebrand is configured", () => {
    expect(APP_NAME).toBe("openclaw");
    expect(APP_STATE_DIRNAME).toBe(".openclaw");
    expect(APP_CONFIG_FILENAME).toBe("openclaw.json");
  });

  /**
   * The bug this guards: `src/agents/config.ts` derived its own `CONFIG_DIR_NAME`
   * from the seam while `src/config/paths.ts` hardcoded the directory, so setting
   * the seam moved the agent dir but left config and state under the old name —
   * a split brain that is worse than having no rename support at all.
   */
  it("is the single source shared with the agent config layer", () => {
    expect(CONFIG_DIR_NAME).toBe(APP_STATE_DIRNAME);
    expect(AGENT_APP_NAME).toBe(APP_NAME);
  });
});
