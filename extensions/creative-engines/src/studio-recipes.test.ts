import { describe, expect, it } from "vitest";
import { prepareStudioGraph } from "./studio-graph.js";
import { buildStudioRecipe, STUDIO_RECIPES } from "./studio-recipes.js";

describe("Studio demo recipes", () => {
  it.each(STUDIO_RECIPES)("builds a valid, parameter-resolved canonical graph: $id", (recipe) => {
    const graph = buildStudioRecipe(recipe.id);
    expect(graph.name).toBe(recipe.name);
    expect(graph.inputs[0].dataType).toBe(recipe.sourceType);
    expect(graph.nodes).toHaveLength(recipe.steps.length);
    expect(prepareStudioGraph(graph).capabilities.size).toBe(recipe.steps.length);
    expect(buildStudioRecipe(recipe.id).id).not.toBe(graph.id);
  });
  it("rejects unknown recipes", () => {
    expect(() => buildStudioRecipe("not-a-recipe")).toThrow("Unknown workflow recipe");
  });
});
