import { html, nothing } from "lit";
import type { CreativeOp } from "../controllers/creative-studio.ts";

function toTitleCase(snake: string): string {
  return snake
    .split("_")
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export function renderParameterFields(
  op: CreativeOp | undefined,
  params: Record<string, unknown>,
  disabled: boolean,
  onChange: (patch: Record<string, unknown>) => void,
) {
  const schema = op?.parametersSchema as
    | {
        properties?: Record<
          string,
          {
            type?: string;
            minimum?: number;
            maximum?: number;
            enum?: string[];
            description?: string;
            default?: unknown;
          }
        >;
        required?: string[];
      }
    | undefined;

  if (!schema?.properties || Object.keys(schema.properties).length === 0) {
    return nothing;
  }

  const entries = Object.entries(schema.properties);
  const required = new Set(schema.required ?? []);

  return html`
    <div class="creative-run__parameters">
      <div class="card-sub">Operation parameters</div>
      <div class="creative-run__parameters-grid">
        ${entries.map(([name, prop]) => {
          const isReq = required.has(name);
          const val = params[name] !== undefined ? params[name] : prop.default;
          const textValue =
            typeof val === "string" || typeof val === "number" || typeof val === "boolean"
              ? String(val)
              : "";

          if (prop.enum && prop.enum.length > 0) {
            return html`
              <label class="field">
                <span>${toTitleCase(name)}${isReq ? " *" : ""}</span>
                <select
                  ?disabled=${disabled}
                  @change=${(e: Event) =>
                    onChange({ [name]: (e.target as HTMLSelectElement).value })}
                >
                  ${prop.enum.map(
                    (opt) => html`<option value=${opt} ?selected=${val === opt}>${opt}</option>`,
                  )}
                </select>
                ${prop.description
                  ? html`<span class="field-help">${prop.description}</span>`
                  : nothing}
              </label>
            `;
          }

          if (prop.type === "boolean") {
            return html`
              <label class="field field--checkbox">
                <input
                  type="checkbox"
                  ?checked=${Boolean(val)}
                  ?disabled=${disabled}
                  @change=${(e: Event) =>
                    onChange({ [name]: (e.target as HTMLInputElement).checked })}
                />
                <span>${toTitleCase(name)}${isReq ? " *" : ""}</span>
                ${prop.description
                  ? html`<span class="field-help">${prop.description}</span>`
                  : nothing}
              </label>
            `;
          }

          if (prop.type === "integer" || prop.type === "number") {
            const step = prop.type === "integer" ? "1" : "any";
            return html`
              <label class="field">
                <span>${toTitleCase(name)}${isReq ? " *" : ""}</span>
                <input
                  type="number"
                  step=${step}
                  min=${prop.minimum !== undefined ? String(prop.minimum) : nothing}
                  max=${prop.maximum !== undefined ? String(prop.maximum) : nothing}
                  .value=${textValue}
                  ?disabled=${disabled}
                  @change=${(e: Event) => {
                    const str = (e.target as HTMLInputElement).value;
                    onChange({ [name]: str === "" ? undefined : Number(str) });
                  }}
                />
                ${prop.description
                  ? html`<span class="field-help">${prop.description}</span>`
                  : nothing}
              </label>
            `;
          }

          return html`
            <label class="field">
              <span>${toTitleCase(name)}${isReq ? " *" : ""}</span>
              <input
                type="text"
                .value=${textValue}
                ?disabled=${disabled}
                @input=${(e: Event) => onChange({ [name]: (e.target as HTMLInputElement).value })}
              />
              ${prop.description
                ? html`<span class="field-help">${prop.description}</span>`
                : nothing}
            </label>
          `;
        })}
      </div>
    </div>
  `;
}
