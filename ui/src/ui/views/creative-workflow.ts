import { html, nothing, svg } from "lit";
import type { CreativeStudioController } from "../controllers/creative-studio.ts";
import type { CreativeWorkflowController } from "../controllers/creative-workflow.ts";
import { renderParameterFields } from "./creative-parameters.ts";
import { renderCreativeRecipes } from "./creative-recipes.ts";

function connectionSelect(
  editor: CreativeWorkflowController,
  target: string,
  type: string,
  disabled: boolean,
  label: string,
) {
  const edge = editor.graph?.edges.find((entry) => entry.targetNodeId === target);
  const current = edge ? JSON.stringify([edge.sourceNodeId, edge.sourcePort]) : "";
  return html`<label class="field"
    ><span>${label}</span>
    <select
      aria-label=${label}
      ?disabled=${disabled}
      @change=${(event: Event) => {
        const value = (event.target as HTMLSelectElement).value;
        const [node, port] = value ? (JSON.parse(value) as string[]) : [];
        editor.connect(target, node, port);
      }}
    >
      <option value="" ?selected=${!current}>Not connected</option>
      ${editor.connections(type, target).map((option) => {
        const value = JSON.stringify([option.node, option.port]);
        return html`<option value=${value} ?selected=${value === current}>${option.label}</option>`;
      })}
    </select>
  </label>`;
}

export function renderCreativeWorkflow(studio: CreativeStudioController) {
  const editor = studio.workflow;
  const graph = editor.graph;
  const disabled = editor.busy || studio.running;
  const selected = graph?.nodes.find((node) => node.id === editor.selectedNodeId);
  const cap = selected ? editor.capability(selected.capability) : undefined;
  const width = Math.max(800, ...(graph?.nodes.map((node) => (node.position?.x ?? 0) + 230) ?? []));
  const height = Math.max(
    250,
    ...(graph?.nodes.map((node) => (node.position?.y ?? 0) + 110) ?? []),
  );
  return html`<section class="card creative-workflow" aria-label="Workflow editor">
    <div class="card-title">Editable workflows</div>
    <p class="card-sub">
      Chain local operations. Select a node to edit parameters and connections. Drag nodes or move
      them with arrow keys.
    </p>
    ${renderCreativeRecipes(studio)}
    <div class="creative-workflow__toolbar">
      <label class="field"
        ><span>Saved workflow</span>
        <select
          aria-label="Saved workflow"
          ?disabled=${disabled || editor.dirty}
          @change=${(event: Event) => editor.select((event.target as HTMLSelectElement).value)}
        >
          <option
            value=""
            ?selected=${!graph || !editor.saved.some((entry) => entry.id === graph.id)}
          >
            Select a workflow
          </option>
          ${editor.saved.map(
            (entry) =>
              html`<option value=${entry.id} ?selected=${entry.id === graph?.id}>
                ${entry.name} · r${entry.revision}
              </option>`,
          )}
        </select>
      </label>
      <button
        class="btn"
        ?disabled=${disabled || editor.dirty}
        @click=${() => editor.create(studio.activeMedia === "vfx" ? "image" : studio.activeMedia)}
      >
        New workflow
      </button>
      <button class="btn" ?disabled=${disabled || !graph} @click=${() => void editor.save()}>
        Save & validate
      </button>
      <button class="btn" ?disabled=${disabled || !graph} @click=${() => void editor.duplicate()}>
        Duplicate workflow
      </button>
      <button class="btn" ?disabled=${disabled || !graph} @click=${() => editor.exportGraph()}>
        Export workflow JSON
      </button>
      <label class="field"
        ><span>Import workflow JSON</span
        ><input
          aria-label="Import workflow JSON"
          type="file"
          accept=".json,application/json"
          ?disabled=${disabled || editor.dirty}
          @change=${async (event: Event) => {
            const input = event.target as HTMLInputElement;
            const file = input.files?.[0];
            if (file) {
              if (file.size > 65536) {
                editor.message = "Workflow JSON exceeds 64 KB";
                studio.updateRunForm({});
              } else {
                await editor.importGraph(await file.text());
              }
            }
            input.value = "";
          }}
      /></label>
      <button
        class="btn primary"
        ?disabled=${disabled || !graph?.nodes.length || !studio.runForm.input.trim()}
        @click=${() => void editor.run()}
      >
        ${studio.running ? "Running…" : "Run workflow"}
      </button>
      ${editor.dirty
        ? html`<span class="muted">Unsaved edits · save before switching</span>`
        : nothing}
    </div>
    ${editor.message ? html`<p role="status">${editor.message}</p>` : nothing}
    ${studio.lastResult
      ? html`<p
          role="status"
          class=${studio.lastResult.ok ? "creative-run__result--ok" : "creative-run__result--err"}
        >
          ${studio.lastResult.message}
        </p>`
      : nothing}
    ${editor.issues.length
      ? html`<div class="callout warn" role="alert">
          ${editor.issues.map((issue) => html`<div>${issue}</div>`)}
        </div>`
      : nothing}
    ${graph
      ? html`
          <div class="creative-run__grid">
            <label class="field"
              ><span>Workflow name</span
              ><input
                aria-label="Workflow name"
                .value=${graph.name}
                ?disabled=${disabled}
                @change=${(event: Event) =>
                  editor.rename((event.target as HTMLInputElement).value)}
            /></label>
            <label class="field"
              ><span>Source type</span
              ><select
                aria-label="Source type"
                ?disabled=${disabled}
                @change=${(event: Event) =>
                  editor.setSourceType(
                    (event.target as HTMLSelectElement).value as
                      | "image"
                      | "audio"
                      | "video"
                      | "vector",
                  )}
              >
                ${["image", "audio", "video", "vector"].map(
                  (kind) =>
                    html`<option value=${kind} ?selected=${graph.inputs[0].dataType === kind}>
                      ${kind}
                    </option>`,
                )}
              </select></label
            >
            <label class="field"
              ><span>Workflow source</span
              ><input
                aria-label="Workflow source"
                .value=${studio.runForm.input}
                ?disabled=${disabled}
                placeholder="Absolute path to your source file"
                @input=${(event: Event) =>
                  studio.updateRunForm({ input: (event.target as HTMLInputElement).value })}
            /></label>
            <label class="field"
              ><span>Workflow export (optional)</span
              ><input
                aria-label="Workflow export"
                .value=${studio.runForm.output}
                ?disabled=${disabled}
                placeholder="Leave blank to save in the project"
                @input=${(event: Event) =>
                  studio.updateRunForm({ output: (event.target as HTMLInputElement).value })}
            /></label>
          </div>
          <label class="field"
            ><span>Find an operation</span
            ><input
              type="search"
              aria-label="Find an operation"
              .value=${editor.paletteQuery}
              placeholder="Search names and descriptions"
              @input=${(event: Event) =>
                editor.filterPalette((event.target as HTMLInputElement).value)}
          /></label>
          <label class="field"
            ><span>Add operation</span>
            <select
              aria-label="Add operation"
              ?disabled=${disabled}
              @change=${(event: Event) => {
                const select = event.target as HTMLSelectElement;
                editor.add(select.value);
                select.value = "";
              }}
            >
              <option value="">Choose an operation to add…</option>
              ${editor.capabilities
                .filter((descriptor) =>
                  `${descriptor.id} ${descriptor.label} ${descriptor.description}`
                    .toLowerCase()
                    .includes(editor.paletteQuery.toLowerCase().trim()),
                )
                .map(
                  (descriptor) =>
                    html`<option value=${descriptor.id}>
                      ${descriptor.id} ·
                      ${descriptor.label}${descriptor.requirements.models?.length
                        ? " · model required"
                        : ""}
                    </option>`,
                )}
            </select>
          </label>
          <div class="creative-workflow__scroll">
            <div class="creative-workflow__canvas" style="width:${width}px;height:${height}px">
              <div class="creative-workflow__source">Source · ${graph.inputs[0].dataType}</div>
              <div class="creative-workflow__result" style="left:${width - 200}px">
                Result · ${graph.outputs[0].dataType}
              </div>
              <svg
                class="creative-workflow__edges"
                width=${width}
                height=${height}
                aria-label="Workflow connections"
              >
                ${graph.edges.map((edge) => {
                  const from = graph.nodes.find((node) => node.id === edge.sourceNodeId);
                  const to = graph.nodes.find((node) => node.id === edge.targetNodeId);
                  if (
                    (!from && edge.sourceNodeId !== graph.id) ||
                    (!to && edge.targetNodeId !== graph.id)
                  ) {
                    return nothing;
                  }
                  const x1 = from ? (from.position?.x ?? 0) + 200 : 120;
                  const y1 = from ? (from.position?.y ?? 0) + 38 : 33;
                  const x2 = to ? (to.position?.x ?? 0) : width - 110;
                  const y2 = to ? (to.position?.y ?? 0) + 38 : 33;
                  return svg`<path d="M ${x1} ${y1} C ${x1 + 55} ${y1}, ${x2 - 55} ${y2}, ${x2} ${y2}" />`;
                })}
              </svg>
              ${graph.nodes.map(
                (node) => html`<button
                  class="creative-workflow__node ${node.id === selected?.id
                    ? "creative-workflow__node--selected"
                    : ""}"
                  style="left:${node.position?.x ?? 0}px;top:${node.position?.y ?? 0}px"
                  aria-label=${`Edit ${editor.capability(node.capability)?.label ?? node.capability}`}
                  ?disabled=${disabled}
                  @click=${() => editor.choose(node.id)}
                  @pointerdown=${(event: PointerEvent) => editor.beginDrag(node.id, event)}
                  @pointermove=${(event: PointerEvent) => editor.dragTo(event)}
                  @pointerup=${() => editor.endDrag()}
                  @pointercancel=${() => editor.endDrag()}
                  @keydown=${(event: KeyboardEvent) => {
                    const directions: Record<string, [number, number]> = {
                      ArrowLeft: [-10, 0],
                      ArrowRight: [10, 0],
                      ArrowUp: [0, -10],
                      ArrowDown: [0, 10],
                    };
                    const delta = directions[event.key];
                    if (delta) {
                      event.preventDefault();
                      editor.move(
                        node.id,
                        (node.position?.x ?? 0) + delta[0],
                        (node.position?.y ?? 0) + delta[1],
                      );
                    }
                  }}
                >
                  <strong
                    >${node.label ??
                    editor.capability(node.capability)?.label ??
                    node.capability}</strong
                  >
                  <small>${node.capability}</small>
                </button>`,
              )}
            </div>
          </div>
          ${graph.nodes.length === 0
            ? html`<p class="muted">
                Add an operation to start. Compatible nodes are connected automatically; connections
                remain editable.
              </p>`
            : nothing}
          <div class="creative-workflow__inspector">
            ${connectionSelect(
              editor,
              graph.id,
              graph.outputs[0].dataType,
              disabled,
              "Workflow result",
            )}
            ${selected && cap
              ? html`<section aria-label="Node inspector">
                  <h3>${cap.label}</h3>
                  <p class="muted">${cap.description}</p>
                  ${connectionSelect(
                    editor,
                    selected.id,
                    Object.values(cap.inputs)[0].dataType,
                    disabled,
                    "Node input",
                  )}
                  ${renderParameterFields(
                    { id: cap.id, label: cap.label, parametersSchema: cap.parametersSchema },
                    selected.parameters,
                    disabled,
                    (patch) => editor.parameters(selected.id, patch),
                  )}
                  ${cap.requirements.models?.length
                    ? html`<p class="callout warn">
                        Requires installed model: ${cap.requirements.models.join(", ")}. An
                        available native engine does not imply the model is installed.
                      </p>`
                    : nothing}
                  <button
                    class="btn"
                    ?disabled=${disabled}
                    @click=${() => editor.remove(selected.id)}
                  >
                    Remove node
                  </button>
                </section>`
              : nothing}
          </div>
        `
      : html`<p class="muted">
          Create a workflow to combine native image, audio, video, vector and VFX operations. Each
          workflow uses one source file and one final result.
        </p>`}
    <p class="muted">
      VFX color grading and tone mapping use the sibling C++ bridge. Model-backed AI effects require
      their models; Python-only AI nodes are not connected to this runtime.
    </p>
    ${studio.lastNodes.length
      ? html`<details open>
          <summary>Last execution · ${studio.lastNodes.length} nodes</summary>
          <div style="overflow:auto">
            <table>
              <thead>
                <tr>
                  <th>Operation</th>
                  <th>Status</th>
                  <th>Time</th>
                  <th>Runtime library</th>
                </tr>
              </thead>
              <tbody>
                ${studio.lastNodes.map(
                  (node) =>
                    html`<tr>
                      <td>
                        ${graph?.nodes.find((entry) => entry.id === node.id)?.capability ?? node.id}
                      </td>
                      <td>${node.status}</td>
                      <td>${node.durationMs} ms</td>
                      <td><code>${node.enginePath || "Not reported"}</code></td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>
        </details>`
      : nothing}
  </section>`;
}
