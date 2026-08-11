import { describe, it, expect, vi } from "vitest";
import {
  PROTECTED_CONTENT_POLICY_ID,
  collectEditTargets,
  evaluateProtectedEdit,
  registerProtectedContentGuard,
  type EditGuardApi,
} from "./edit-guard.js";

describe("collectEditTargets", () => {
  it("collects host-derived paths and every param alias", () => {
    expect(
      collectEditTargets({
        toolName: "write",
        params: { file_path: "/w/content/a.png", oldPath: "/w/input/b.png" },
        derivedPaths: ["/w/content/c.png"],
      }).toSorted(),
    ).toEqual(["/w/content/a.png", "/w/content/c.png", "/w/input/b.png"]);
  });

  it("collects batched edit entries and de-duplicates", () => {
    expect(
      collectEditTargets({
        toolName: "edit",
        params: {
          path: "/w/content/a.png",
          edits: [{ path: "/w/content/a.png" }, { filePath: "/w/output/b.png" }, null, "junk"],
        },
      }).toSorted(),
    ).toEqual(["/w/content/a.png", "/w/output/b.png"]);
  });

  it("ignores blank and non-string values", () => {
    expect(collectEditTargets({ toolName: "write", params: { path: "   ", file: 7 } })).toEqual([]);
  });
});

describe("evaluateProtectedEdit", () => {
  it("refuses a write under /content/", () => {
    const decision = evaluateProtectedEdit({
      toolName: "write",
      params: { path: "/workspace/content/acme/posts/hero.png" },
    });

    expect(decision?.allow).toBe(false);
    expect(decision?.reason).toContain("/workspace/content/acme/posts/hero.png");
    expect(decision?.reason).toContain("must not be overwritten");
  });

  it("refuses apply_patch via host-derived paths", () => {
    const decision = evaluateProtectedEdit({
      toolName: "apply_patch",
      params: { input: "*** Update File: content/acme/copy.md" },
      derivedPaths: ["/workspace/content/acme/copy.md"],
    });

    expect(decision?.allow).toBe(false);
  });

  it("refuses Windows-style content paths", () => {
    expect(
      evaluateProtectedEdit({
        toolName: "edit",
        params: { path: "C:\\workspace\\Content\\acme\\file.png" },
      })?.allow,
    ).toBe(false);
  });

  it("allows writes outside /content/", () => {
    expect(
      evaluateProtectedEdit({ toolName: "write", params: { path: "/workspace/output/a.png" } }),
    ).toBeUndefined();
  });

  it("does not touch read-only or unrelated tools", () => {
    expect(
      evaluateProtectedEdit({ toolName: "read", params: { path: "/workspace/content/a.png" } }),
    ).toBeUndefined();
    expect(
      evaluateProtectedEdit({ toolName: "exec", params: { path: "/workspace/content/a.png" } }),
    ).toBeUndefined();
  });
});

describe("registerProtectedContentGuard", () => {
  it("registers a policy whose id matches the manifest contract", () => {
    const registerTrustedToolPolicy = vi.fn();
    const api: EditGuardApi = { registerTrustedToolPolicy };

    expect(registerProtectedContentGuard(api)).toBe(true);
    expect(registerTrustedToolPolicy).toHaveBeenCalledTimes(1);

    const policy = registerTrustedToolPolicy.mock.calls[0]![0];
    expect(policy.id).toBe(PROTECTED_CONTENT_POLICY_ID);
    expect(policy.description).toBeTruthy();
    expect(
      policy.evaluate({ toolName: "write", params: { path: "/w/content/a.png" } })?.allow,
    ).toBe(false);
    expect(policy.evaluate({ toolName: "write", params: { path: "/w/out/a.png" } })).toBeUndefined();
  });

  it("reports false instead of pretending when the host lacks the seam", () => {
    expect(registerProtectedContentGuard({})).toBe(false);
  });
});
