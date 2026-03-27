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

const SUPPORTED_MODELS = ["codex", "claude"] as const;
type SupportedModel = (typeof SUPPORTED_MODELS)[number];

export async function runSkepticEvaluation(
  prompt: string,
  options: { model?: "codex" | "claude" | "gemini" } = {},
): Promise<string> {
  if (options.model === "gemini") {
    throw new Error(
      `Unsupported skeptic model: "gemini". The skeptic agent does not yet support Gemini. ` +
        `Supported models are: ${[...SUPPORTED_MODELS].join(", ")}. ` +
        `Omit the --model flag or specify --model codex or --model claude.`,
    );
  }
  if (options.model !== undefined && !SUPPORTED_MODELS.includes(options.model as SupportedModel)) {
    throw new Error(
      `Unsupported skeptic model: "${options.model}". Supported models are: ${[...SUPPORTED_MODELS].join(", ")}.`,
    );
  }
  return llmEval(prompt, { model: options.model });
}
