import { type SkepticModel, isValidSkepticModel } from "./skeptic-model-schema.js";

/** Ordered fallback chain for skeptic LLM evaluation (bd-skp3). */
export const FALLBACK_CHAIN: SkepticModel[] = ["codex", "claude", "gemini", "minimax", "agy"];

export function resolveSkepticModel(
  model?: SkepticModel | SkepticModel[],
): {
  validatedModel?: SkepticModel | SkepticModel[];
  chain: typeof FALLBACK_CHAIN;
} {
  if (model !== undefined) {
    const models = Array.isArray(model) ? model : [model];
    if (models.length === 0) {
      throw new Error("options.model must contain at least one model.");
    }
    for (const m of models) {
      if (!isValidSkepticModel(m)) {
        throw new Error("options.model must contain at least one valid model.");
      }
    }
  }

  const resolvedModel = model;

  const chain: typeof FALLBACK_CHAIN =
    Array.isArray(resolvedModel) && resolvedModel.length > 0
      ? resolvedModel
      : resolvedModel && !Array.isArray(resolvedModel)
      ? FALLBACK_CHAIN.slice(Math.max(0, FALLBACK_CHAIN.indexOf(resolvedModel)))
      : FALLBACK_CHAIN.slice(0);

  return {
    validatedModel: resolvedModel,
    chain,
  };
}
