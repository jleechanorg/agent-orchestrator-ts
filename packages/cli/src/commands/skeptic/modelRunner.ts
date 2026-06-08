/**
 * Model runner — runs the skeptical LLM evaluation.
 *
 * Delegates to the shared llmEval() utility in packages/cli/src/lib/.
 * All LLM evaluation MUST go through llm-eval.ts — never hard-code
 * binary paths or exec calls here.
 *
 * The skeptic must produce a VERDICT: PASS or VERDICT: FAIL line.
 * If no VERDICT is found in output, the caller treats it as FAIL (fail-closed).
 */

import { VALID_SKEPTIC_MODELS, type SkepticModel } from "@jleechanorg/ao-core";
import { llmEval, type ChainModel } from "../../lib/llm-eval.js";

const SUPPORTED_MODELS = VALID_SKEPTIC_MODELS;
type SupportedModel = SkepticModel;

export async function runSkepticEvaluation(
  prompt: string,
  options: { model?: string | string[] } = {},
): Promise<string> {
  const { model } = options;
  if (model !== undefined) {
    const models = Array.isArray(model) ? model : [model];
    if (models.length === 0) {
      throw new Error(
        "runSkepticEvaluation: `model` must be a non-empty string or non-empty array of model names. " +
          `Supported models are: ${SUPPORTED_MODELS.join(", ")}.`,
      );
    }
    for (const m of models) {
      if (!SUPPORTED_MODELS.includes(m as SupportedModel)) {
        throw new Error(
          `Unsupported skeptic model: "${m}". Supported models are: ${SUPPORTED_MODELS.join(", ")}.`,
        );
      }
    }
  }
  return llmEval(prompt, { model: model as ChainModel | ChainModel[] });
}
