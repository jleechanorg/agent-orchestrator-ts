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

import { llmEval } from "../../lib/llm-eval.js";

const SUPPORTED_MODELS = ["codex", "claude", "gemini", "minimax", "agy", "cursor"] as const;
type SupportedModel = (typeof SUPPORTED_MODELS)[number];

export async function runSkepticEvaluation(
  prompt: string,
  options: { model?: SupportedModel | SupportedModel[] } = {},
): Promise<string> {
  const { model } = options;
  if (model !== undefined) {
    const models = Array.isArray(model) ? model : [model];
    for (const m of models) {
      if (!SUPPORTED_MODELS.includes(m as SupportedModel)) {
        throw new Error(
          `Unsupported skeptic model: "${m}". Supported models are: ${[...SUPPORTED_MODELS].join(", ")}.`,
        );
      }
    }
  }
  return llmEval(prompt, { model });
}
