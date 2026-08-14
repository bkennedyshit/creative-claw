// Control UI view renders creative studio screen content.
import { html, nothing } from "lit";
import {
  CREATIVE_MEDIA_ORDER,
  type CreativeEngineState,
  type CreativeGpuState,
  type CreativeMedia,
  type CreativeOp,
  type CreativeRecentOutput,
  type CreativeRunForm,
  type CreativeRunResult,
} from "../controllers/creative-studio.ts";

export interface CreativeStudioViewProps {
  activeMedia: CreativeMedia;
  onMediaChange: (media: CreativeMedia) => void;
  engines: Record<CreativeMedia, CreativeEngineState>;
  gpu: CreativeGpuState;
  recentOutputs: CreativeRecentOutput[];
  runForm: CreativeRunForm;
  onRunFormChange: (patch: Partial<CreativeRunForm>) => void;
  onRunOp: () => void;
  running: boolean;
  lastResult?: CreativeRunResult;
}

const MEDIA_LABELS: Record<CreativeMedia, string> = {
  image: "Image",
  audio: "Audio",
  video: "Video",
  vector: "Vector",
};

function renderMediaTabs(props: CreativeStudioViewProps) {
  return html`
    <div class="creative-tabs" role="tablist" aria-label="Media type">
      ${CREATIVE_MEDIA_ORDER.map((media) => {
        const active = props.activeMedia === media;
        const engine = props.engines[media];
        return html`
          <button
            class="creative-tab ${active ? "creative-tab--active" : ""}"
            role="tab"
            aria-selected=${active ? "true" : "false"}
            @click=${() => props.onMediaChange(media)}
          >
            <span>${MEDIA_LABELS[media]}</span>
            <span
              class="creative-tab__dot ${engine.available
                ? "creative-tab__dot--ok"
                : "creative-tab__dot--off"}"
              title=${engine.available ? "Available" : engine.reason ?? "Unavailable"}
            ></span>
          </button>
        `;
      })}
    </div>
  `;
}

function renderGpuWidget(gpu: CreativeGpuState) {
  const total = gpu.totalMb > 0 ? gpu.totalMb : 0;
  const pct = total > 0 ? Math.min(100, Math.round((gpu.usedMb / total) * 100)) : 0;
  return html`
    <section class="card creative-gpu">
      <div class="creative-gpu__head">
        <div class="card-title">GPU</div>
        <span class="pill pill--sm ${gpu.dormant ? "" : "pill--ok"}">${gpu.state}</span>
      </div>
      <div class="creative-gpu__meter" title="${gpu.usedMb} / ${total} MB">
        <div class="creative-gpu__meter-fill" style="width: ${pct}%"></div>
      </div>
      <div class="creative-gpu__stats">
        <span>${gpu.usedMb} / ${total > 0 ? `${total} MB` : "unknown"}</span>
        <span>${gpu.dormant ? "dormant" : "active"}</span>
      </div>
      <div class="creative-gpu__models">
        ${gpu.models.length === 0
          ? html`<span class="muted">No resident models</span>`
          : gpu.models.map((model) => html`<span class="chip">${model}</span>`)}
      </div>
    </section>
  `;
}

function renderOpCatalog(engine: CreativeEngineState) {
  if (engine.ops.length === 0) {
    return html`<div class="data-table-empty-state">No operations available</div>`;
  }
  return html`
    <div class="creative-ops">
      ${engine.ops.map(
        (op) => html`
          <div class="creative-op">
            <div class="creative-op__label">${op.label}</div>
            <code class="creative-op__id">${op.id}</code>
            ${op.params && op.params.length > 0
              ? html`<div class="creative-op__params">
                  ${op.params.map(
                    (param) => html`<span class="chip">${param.name}: ${param.type}</span>`,
                  )}
                </div>`
              : nothing}
          </div>
        `,
      )}
    </div>
  `;
}

function renderRunForm(props: CreativeStudioViewProps, engine: CreativeEngineState) {
  const disabled = !engine.available || props.running;
  return html`
    <section class="card creative-run">
      <div class="card-title">Run operation</div>
      <div class="card-sub">Apply an ${MEDIA_LABELS[props.activeMedia].toLowerCase()} operation.</div>
      <div class="creative-run__grid">
        <label class="field">
          <span>Input path</span>
          <input
            type="text"
            .value=${props.runForm.input}
            ?disabled=${disabled}
            placeholder="path/to/input"
            @input=${(event: Event) =>
              props.onRunFormChange({ input: (event.target as HTMLInputElement).value })}
          />
        </label>
        <label class="field">
          <span>Operation</span>
          <select
            ?disabled=${disabled || engine.ops.length === 0}
            @change=${(event: Event) =>
              props.onRunFormChange({ op: (event.target as HTMLSelectElement).value })}
          >
            <option value="" ?selected=${props.runForm.op === ""}>Select an operation</option>
            ${engine.ops.map(
              (op: CreativeOp) =>
                html`<option value=${op.id} ?selected=${props.runForm.op === op.id}>
                  ${op.label}
                </option>`,
            )}
          </select>
        </label>
        <label class="field">
          <span>Output path</span>
          <input
            type="text"
            .value=${props.runForm.output}
            ?disabled=${disabled}
            placeholder="path/to/output"
            @input=${(event: Event) =>
              props.onRunFormChange({ output: (event.target as HTMLInputElement).value })}
          />
        </label>
      </div>
      <div class="creative-run__actions">
        <button class="btn primary" ?disabled=${disabled || !props.runForm.op} @click=${props.onRunOp}>
          ${props.running ? "Running..." : "Run"}
        </button>
        ${props.lastResult
          ? html`<span
              class="creative-run__result ${props.lastResult.ok
                ? "creative-run__result--ok"
                : "creative-run__result--err"}"
              >${props.lastResult.message}</span
            >`
          : nothing}
      </div>
    </section>
  `;
}

function renderActivePanel(props: CreativeStudioViewProps) {
  const engine = props.engines[props.activeMedia];
  return html`
    <section class="card creative-panel">
      <div class="creative-panel__head">
        <div class="card-title">${MEDIA_LABELS[props.activeMedia]} engine</div>
        <span class="pill pill--sm ${engine.available ? "pill--ok" : ""}">
          ${engine.available ? "Available" : "Unavailable"}
        </span>
      </div>
      ${engine.available
        ? nothing
        : html`<div class="callout warn creative-panel__unavailable">
            Engine unavailable: ${engine.reason ?? "unknown reason"}
          </div>`}
      <div class="creative-panel__catalog">
        <div class="card-sub">Operations</div>
        ${renderOpCatalog(engine)}
      </div>
    </section>
    ${renderRunForm(props, engine)}
  `;
}

function renderRecentOutputs(outputs: CreativeRecentOutput[]) {
  return html`
    <section class="card creative-recent">
      <div class="card-title">Recent outputs</div>
      ${outputs.length === 0
        ? html`<div class="data-table-empty-state">No recent outputs</div>`
        : html`<div class="creative-recent__strip">
            ${outputs.map(
              (output) => html`
                <div class="creative-recent__item" title=${output.path}>
                  <div class="creative-recent__thumb">${output.type}</div>
                  <div class="creative-recent__path">${output.path}</div>
                </div>
              `,
            )}
          </div>`}
    </section>
  `;
}

export function renderCreativeStudio(props: CreativeStudioViewProps) {
  return html`
    <section class="creative-studio">
      ${renderMediaTabs(props)}
      <div class="creative-studio__grid">
        <div class="creative-studio__main">${renderActivePanel(props)}</div>
        <div class="creative-studio__side">${renderGpuWidget(props.gpu)}</div>
      </div>
      ${renderRecentOutputs(props.recentOutputs)}
    </section>
  `;
}
