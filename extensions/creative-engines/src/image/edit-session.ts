import { createHash } from "node:crypto";
import { readFile, copyFile } from "node:fs/promises";
import { join, dirname, basename, extname } from "node:path";
import { Type } from "typebox";
import { defineEngineTool, type EngineToolRegistrar } from "../define-tool.js";
import type { ImageEngineRuntime } from "../runtime/image.js";
import type { EditSessionVersion, Step } from "../types.js";

/** In-memory edit session store: sessionId → version stack. */
const sessions = new Map<string, EditSessionVersion[]>();

async function hashFile(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

function generateSessionId(): string {
  return `edit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Reusable typebox schema for an op-chain step. */
const StepSchema = Type.Object({
  op: Type.String(),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

/**
 * Registers image edit session tools:
 *   image.edit_session.plan — NL instruction → op chain
 *   image.edit_session.preview — execute chain, return preview path
 *   image.edit_session.confirm — commit, stack onto working image, version
 *   image.edit_session.revert — restore original
 *
 * Includes Anti_Fake_Guard: if input hash === output hash, the op produced no change.
 */
export function registerEditSessionTools(
  registerTool: EngineToolRegistrar,
  imageEngine: ImageEngineRuntime,
): void {
  registerTool(
    defineEngineTool({
      name: "image.edit_session.plan",
      description:
        "Plan an edit session: translate natural-language instruction into an op chain. Returns session_id and planned steps.",
      parameters: Type.Object({
        input: Type.String({ description: "Source image path" }),
        instruction: Type.String({ description: "Natural language editing instruction" }),
      }),
      async run(args) {
        const inputPath = args.input as string;
        const instruction = args.instruction as string;

        // Derive op chain from instruction keywords (real impl would use model routing)
        const steps = deriveStepsFromInstruction(instruction);
        const sessionId = generateSessionId();
        const inputHash = await hashFile(inputPath);

        sessions.set(sessionId, [
          {
            version: 0,
            path: inputPath,
            ops_applied: [],
            input_hash: inputHash,
            output_hash: inputHash,
            timestamp: new Date().toISOString(),
          },
        ]);

        return {
          session_id: sessionId,
          input: inputPath,
          input_hash: inputHash,
          planned_steps: steps,
          instruction,
        };
      },
    }),
  );

  registerTool(
    defineEngineTool({
      name: "image.edit_session.preview",
      description:
        "Execute a planned op chain and return a preview path. Does not commit the result.",
      parameters: Type.Object({
        session_id: Type.String({ description: "Edit session identifier" }),
        steps: Type.Array(StepSchema, { description: "Op chain to preview" }),
      }),
      async run(args) {
        const sessionId = args.session_id as string;
        const steps = args.steps as Step[];

        const versions = sessions.get(sessionId);
        if (!versions?.length) {
          throw new Error(`No edit session found: ${sessionId}`);
        }

        // Honest degradation: if the native image engine is not loaded, skip with
        // a reason instead of failing on a missing preview file.
        if (!imageEngine.isAvailable()) {
          return {
            ok: false,
            reason: imageEngine.reason() ?? "image engine unavailable",
            session_id: sessionId,
          };
        }

        const latest = versions[versions.length - 1]!;
        const ext = extname(latest.path);
        const previewPath = join(
          dirname(latest.path),
          `${basename(latest.path, ext)}_preview${ext}`,
        );

        const inputHash = await hashFile(latest.path);
        const result = await imageEngine.applyChain(latest.path, steps, previewPath);

        // If the native op chain failed (e.g. gated op), surface the reason.
        if (!result.ok) {
          return {
            ok: false,
            reason: result.reason ?? "apply_chain failed",
            session_id: sessionId,
            steps,
          };
        }

        // Anti_Fake_Guard: identical hashes mean the op produced no change.
        const outputHash = await hashFile(previewPath);
        if (inputHash === outputHash) {
          return {
            ok: false,
            reason: "no_change_detected",
            preview_path: previewPath,
            session_id: sessionId,
          };
        }

        return {
          ok: result.ok,
          preview_path: previewPath,
          session_id: sessionId,
          input_hash: inputHash,
          output_hash: outputHash,
          steps,
        };
      },
    }),
  );

  registerTool(
    defineEngineTool({
      name: "image.edit_session.confirm",
      description: "Commit the preview: stack result onto the working image, increment version.",
      parameters: Type.Object({
        session_id: Type.String({ description: "Edit session identifier" }),
        preview_path: Type.String({ description: "Preview file path to commit" }),
        steps: Type.Array(StepSchema, { description: "Steps that produced this preview" }),
      }),
      async run(args) {
        const sessionId = args.session_id as string;
        const previewPath = args.preview_path as string;
        const steps = args.steps as Step[];

        const versions = sessions.get(sessionId);
        if (!versions?.length) {
          throw new Error(`No edit session found: ${sessionId}`);
        }

        const latest = versions[versions.length - 1]!;
        const nextVersion = latest.version + 1;
        const ext = extname(latest.path);
        const committedPath = join(
          dirname(latest.path),
          `${basename(latest.path, ext)}_v${nextVersion}${ext}`,
        );

        await copyFile(previewPath, committedPath);

        const inputHash = latest.output_hash;
        const outputHash = await hashFile(committedPath);

        // Anti_Fake_Guard
        if (inputHash === outputHash) {
          return {
            ok: false,
            reason: "no_change_detected",
            session_id: sessionId,
            version: latest.version,
          };
        }

        const newVersion: EditSessionVersion = {
          version: nextVersion,
          path: committedPath,
          ops_applied: steps,
          input_hash: inputHash,
          output_hash: outputHash,
          timestamp: new Date().toISOString(),
        };

        versions.push(newVersion);

        return {
          ok: true,
          session_id: sessionId,
          version: nextVersion,
          committed_path: committedPath,
          output_hash: outputHash,
        };
      },
    }),
  );

  registerTool(
    defineEngineTool({
      name: "image.edit_session.revert",
      description: "Revert to the original image (version 0), discarding all edits.",
      parameters: Type.Object({
        session_id: Type.String({ description: "Edit session identifier" }),
      }),
      run(args) {
        const sessionId = args.session_id as string;

        const versions = sessions.get(sessionId);
        if (!versions?.length) {
          throw new Error(`No edit session found: ${sessionId}`);
        }

        const original = versions[0]!;
        // Keep only the original version
        sessions.set(sessionId, [original]);

        return {
          ok: true,
          session_id: sessionId,
          reverted_to: original.path,
          version: 0,
          discarded_versions: versions.length - 1,
        };
      },
    }),
  );
}

/**
 * Simple keyword-based instruction → step derivation.
 * In production this would route through a model or instruction parser.
 */
function deriveStepsFromInstruction(instruction: string): Step[] {
  const lower = instruction.toLowerCase();
  const steps: Step[] = [];

  if (lower.includes("blur")) {
    steps.push({ op: "gaussian_blur", params: { radius: 3 } });
  }
  if (lower.includes("sharpen")) {
    steps.push({ op: "unsharp_mask", params: { amount: 1.5 } });
  }
  if (lower.includes("brightness") || lower.includes("brighten")) {
    steps.push({ op: "brightness", params: { factor: 1.2 } });
  }
  if (lower.includes("contrast")) {
    steps.push({ op: "contrast", params: { factor: 1.3 } });
  }
  if (lower.includes("grayscale") || lower.includes("greyscale") || lower.includes("b&w")) {
    steps.push({ op: "grayscale", params: {} });
  }
  if (lower.includes("resize")) {
    steps.push({ op: "resize", params: { width: 1024, height: 1024 } });
  }
  if (lower.includes("crop")) {
    steps.push({ op: "crop", params: { x: 0, y: 0, width: 512, height: 512 } });
  }
  if (lower.includes("rotate")) {
    steps.push({ op: "rotate", params: { degrees: 90 } });
  }
  if (lower.includes("flip")) {
    steps.push({ op: "flip", params: { axis: "horizontal" } });
  }
  if (lower.includes("invert")) {
    steps.push({ op: "invert", params: {} });
  }

  // Default: if no keywords matched, suggest a generic enhance
  if (steps.length === 0) {
    steps.push({ op: "auto_enhance", params: {} });
  }

  return steps;
}
