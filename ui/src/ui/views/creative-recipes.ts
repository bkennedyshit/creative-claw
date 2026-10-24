import { html, nothing } from "lit";
import type { CreativeStudioController } from "../controllers/creative-studio.ts";

export function renderCreativeRecipes(studio: CreativeStudioController) {
  const editor = studio.workflow;
  const disabled = editor.busy || editor.dirty || studio.running;
  return html`<details class="creative-recipes" open>
    <summary>Workflow launchpad · ${editor.recipes.length} editable starters</summary>
    <p class="muted">
      Choose a starting point, then customize every node. These run locally; no auto-posting or
      AI-model downloads. Start with a short clip.
    </p>
    <div class="creative-workflow__toolbar">
      <label class="field"
        ><span>Search workflows</span
        ><input
          type="search"
          aria-label="Search workflows"
          .value=${editor.recipeQuery}
          placeholder="cinematic, portrait, thumbnail, audio…"
          @input=${(event: Event) =>
            editor.filterRecipes((event.target as HTMLInputElement).value)}
      /></label>
      <label class="field"
        ><span>Workflow category</span
        ><select
          aria-label="Workflow category"
          @change=${(event: Event) =>
            editor.filterRecipes(editor.recipeQuery, (event.target as HTMLSelectElement).value)}
        >
          ${["All", ...new Set(editor.recipes.map((recipe) => recipe.category))].map(
            (category) =>
              html`<option value=${category} ?selected=${category === editor.recipeCategory}>
                ${category}
              </option>`,
          )}
        </select></label
      >
    </div>
    ${editor.dirty
      ? html`<p class="callout warn">
          Save your current draft before loading another workflow. Duplicate keeps your current
          edits in a new copy.
        </p>`
      : nothing}
    <div class="creative-recipes__grid">
      ${editor.filteredRecipes.map((recipe) => {
        const unavailable = editor.recipeUnavailable(recipe);
        return html`<article class="creative-recipes__item">
          <strong>${recipe.name}</strong
          ><span class="muted"
            >${recipe.category} · ${recipe.sourceType} source · ${recipe.operations.length}
            nodes</span
          >
          <p>${recipe.description}</p>
          ${recipe.note ? html`<p class="muted">${recipe.note}</p>` : nothing}
          ${unavailable ? html`<p class="callout warn">${unavailable}</p>` : nothing}
          <button
            class="btn"
            ?disabled=${disabled || Boolean(unavailable)}
            @click=${() => void editor.useRecipe(recipe.id)}
          >
            Use ${recipe.name}
          </button>
        </article>`;
      })}
    </div>
    ${!editor.filteredRecipes.length
      ? html`<p class="muted">
          ${editor.recipes.length
            ? "No matching workflows."
            : "Workflow recipes are not available from the gateway yet."}
        </p>`
      : nothing}
  </details>`;
}
