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
        throw new Error("options.model contains invalid model(s); all entries must be valid Skeptic models");
      }
    }
  }

  const resolvedModel = model;

  let chain: typeof FALLBACK_CHAIN;
  if (Array.isArray(resolvedModel)) {
    if (resolvedModel.length > 0) {
      chain = resolvedModel;
    } else {
      chain = FALLBACK_CHAIN.slice(0);
    }
  } else if (resolvedModel) {
    const idx = FALLBACK_CHAIN.indexOf(resolvedModel);
    if (idx === -1) {
      throw new Error(`Skeptic model "${resolvedModel}" is not present in FALLBACK_CHAIN.`);
    }
    chain = FALLBACK_CHAIN.slice(idx);
  } else {
    chain = FALLBACK_CHAIN.slice(0);
  }

  return {
    validatedModel: resolvedModel,
    chain,
  };
}
