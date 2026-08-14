import { shouldWarnOnEdit } from "./pathmeta.js";

/**
 * Enforcement for `pathmeta.shouldWarnOnEdit`.
 *
 * `warnOnEdit` used to be computed, stored on asset metadata, returned by
 * `media_describe` — and consulted by nothing. This module turns it into a real
 * guardrail by registering a host trusted tool policy, which is the one seam
 * that can actually refuse a tool call: `runTrustedToolPolicies`
 * (src/plugins/trusted-tool-policy.ts) honours `{ allow: false, reason }` and
 * converts it into `{ block: true, blockReason }` inside the host's
 * before_tool_call pipeline (src/agents/agent-tools.before-tool-call.ts).
 */

/** Policy id — must match `contracts.trustedToolPolicies` in the manifest. */
export const PROTECTED_CONTENT_POLICY_ID = "visual-memory-protected-content";

/**
 * Core file-mutating tools. Read-only tools are deliberately untouched: the
 * guardrail protects originals from being overwritten, not from being read.
 */
const MUTATING_TOOL_NAMES = new Set(["write", "edit", "apply_patch"]);

/**
 * Param aliases the host itself treats as a file target
 * (src/agents/tool-mutation.ts FILE_TARGET_PATH_ARG_KEYS).
 */
const PATH_ARG_KEYS = ["path", "file_path", "filePath", "filepath", "file"] as const;
const OLD_PATH_ARG_KEYS = ["oldPath", "old_path"] as const;

/** Minimal structural view of the host before_tool_call event we consume. */
export interface ProtectedEditEvent {
  toolName: string;
  params: Record<string, unknown>;
  /**
   * Host-derived destination hints (populated for `apply_patch`). Treated as a
   * hint only, exactly as the host documents it — params are parsed too.
   */
  derivedPaths?: readonly string[];
}

/** Decision shape accepted by `api.registerTrustedToolPolicy`. */
export interface ProtectedEditDecision {
  allow: false;
  reason: string;
}

/** Collect every candidate write target for a tool call. */
export function collectEditTargets(event: ProtectedEditEvent): string[] {
  const targets: string[] = [];
  for (const derived of event.derivedPaths ?? []) {
    if (typeof derived === "string" && derived.trim()) {
      targets.push(derived);
    }
  }
  const params = event.params ?? {};
  for (const key of [...PATH_ARG_KEYS, ...OLD_PATH_ARG_KEYS]) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      targets.push(value);
    }
  }
  // `edit`-family tools can carry a batch of per-file edits.
  const edits = params.edits;
  if (Array.isArray(edits)) {
    for (const entry of edits) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      for (const key of PATH_ARG_KEYS) {
        const value = (entry as Record<string, unknown>)[key];
        if (typeof value === "string" && value.trim()) {
          targets.push(value);
        }
      }
    }
  }
  return [...new Set(targets)];
}

/**
 * Refuse a mutating tool call whose target is flagged `warnOnEdit` by
 * `pathmeta` (today: anything under a `/content/` segment). Returns `undefined`
 * when the call is allowed, which is what the host treats as "no opinion".
 */
export function evaluateProtectedEdit(
  event: ProtectedEditEvent,
): ProtectedEditDecision | undefined {
  if (!MUTATING_TOOL_NAMES.has(event.toolName)) {
    return undefined;
  }
  const flagged = collectEditTargets(event).filter((target) => shouldWarnOnEdit(target));
  if (flagged.length === 0) {
    return undefined;
  }
  return {
    allow: false,
    reason:
      `visual-memory: refusing ${event.toolName} on protected source media — ` +
      `${flagged.join(", ")} is under a /content/ path, which holds original source files that must not be overwritten. ` +
      `Write the result to an /output/ path instead, or set plugins.entries.visual-memory.config.protectContent=false to disable this guardrail.`,
  };
}

/** Structural view of the single host seam this guard needs. */
export interface EditGuardApi {
  registerTrustedToolPolicy?: (policy: {
    id: string;
    description: string;
    evaluate: (event: ProtectedEditEvent) => ProtectedEditDecision | undefined;
  }) => void;
}

/**
 * Register the guardrail. Returns true when the host exposes the policy seam
 * and the policy was handed over, false when the host cannot enforce it — the
 * caller logs that fact instead of pretending the guardrail is active.
 */
export function registerProtectedContentGuard(api: EditGuardApi): boolean {
  if (typeof api.registerTrustedToolPolicy !== "function") {
    return false;
  }
  api.registerTrustedToolPolicy({
    id: PROTECTED_CONTENT_POLICY_ID,
    description: "Refuse write/edit/apply_patch on original source media under /content/ paths.",
    evaluate: (event) => evaluateProtectedEdit(event),
  });
  return true;
}
