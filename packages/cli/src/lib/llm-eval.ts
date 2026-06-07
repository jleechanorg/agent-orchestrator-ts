/**
 * Shared LLM evaluation utilities for skeptic-style headless evaluation.
 *
 * All LLM evaluation (skeptic, verifier, exit-criteria checks) MUST route
 * through this module — do not hard-code binary paths or exec calls in
 * command handlers.
 *
 * Binary resolution uses resolveCodexBinary() from agent-codex plugin
 * to benefit from its cross-platform path detection logic.
 *
 * Fallback chain:
 *   codex exec -   (primary — Codex with OAuth / OPENAI_API_KEY; prompt via stdin)
 *   claude --dangerously-skip-permissions --print  (secondary — Claude Code OAuth, no proxy; prompt via stdin)
 *
 * The evaluated output must contain VERDICT: PASS or VERDICT: FAIL.
 * Missing VERDICT = fail-closed FAIL.
 */

import { type LlmEvalResult, isUnavailable } from "./llm-eval-shared.js";
import { tryCodexPrint } from "./llm-eval-codex.js";
import { tryClaudePrint } from "./llm-eval-claude.js";
import { tryGeminiPrint } from "./llm-eval-gemini.js";
import { tryAgyPrint } from "./llm-eval-agy.js";
import { tryMinimaxPrint } from "./llm-eval-minimax.js";

export type { LlmEvalResult };
export { isUnavailable };
export { tryCodexPrint };
export { tryClaudePrint };
export { tryGeminiPrint };
export { tryAgyPrint };
export { tryMinimaxPrint };

/**
 * Run a skeptic-style LLM evaluation and return the raw output.
 *
 * @param prompt - The evaluation prompt (must contain VERDICT: PASS/FAIL criteria)
 * @param options.model - Prefer this model or ordered chain; default "codex"
 *
 * Headless fallback chain (default):
 *   codex → claude → gemini → minimax → agy
 *
 * Pass a string[] to define an explicit ordered chain (e.g. ["minimax", "codex"]).
 * cursor is accepted for CLI compatibility but excluded: cursor-agent blocks on Workspace Trust.
 */
export type ChainModel = "codex" | "claude" | "gemini" | "minimax" | "agy";

export async function llmEval(
  prompt: string,
  options: { model?: ChainModel | ChainModel[] } = {},
): Promise<string> {
  const { model } = options;

  const isMissingVerdict = (err?: string) =>
    err !== undefined && /missing VERDICT/i.test(err);

  const DEFAULT_CHAIN: ChainModel[] = ["codex", "claude", "gemini", "minimax", "agy"];

  let ordered: ChainModel[];
  if (Array.isArray(model)) {
    if (model.length === 0) {
      throw new Error(
        "Invalid model: empty array; expected one or more ChainModel values."
      );
    }
    // Explicit chain from caller — validate all elements are ChainModel
    const filteredOrdered = model.filter((m): m is ChainModel => DEFAULT_CHAIN.includes(m as ChainModel));
    if (filteredOrdered.length !== model.length) {
      const unknownModel = model.find((m) => !DEFAULT_CHAIN.includes(m as ChainModel));
      throw new Error(
        `Invalid model in options.model: "${unknownModel}". Expected all elements to be ChainModel values from DEFAULT_CHAIN.`
      );
    }
    ordered = filteredOrdered;
  } else if (model === undefined) {
    ordered = DEFAULT_CHAIN;
  } else {
    const preferred = model as string;
    const startIdx = DEFAULT_CHAIN.findIndex((m) => m === preferred);
    ordered = startIdx >= 0 ? [...DEFAULT_CHAIN.slice(startIdx), ...DEFAULT_CHAIN.slice(0, startIdx)] : DEFAULT_CHAIN;
  }

  let lastError = "";

  for (const evalModel of ordered) {
    let result: LlmEvalResult;

    switch (evalModel) {
      case "codex":
        result = await tryCodexPrint(prompt);
        break;
      case "claude":
        result = await tryClaudePrint(prompt);
        break;
      case "gemini":
        result = await tryGeminiPrint(prompt);
        break;
      case "minimax":
        result = await tryMinimaxPrint(prompt);
        break;
      case "agy":
        result = await tryAgyPrint(prompt);
        break;
      default:
        continue;
    }

    if (result.validVerdict) return result.output;

    if (isMissingVerdict(result.error)) {
      return `VERDICT: FAIL — ${evalModel}: ${result.error}`;
    }

    if (result.error) {
      lastError = result.error;
      // Infra failure — continue to next model in chain
      continue;
    }

    // Tool unavailable (ENOENT / 401 / 403 / 429) — try next model
    // Only set "not available" if we haven't recorded an error yet.
    // Infra errors (set above) are preserved since they're more informative
    // (tool IS installed but something went wrong); "not available" is a
    // fallback when no infra error has been encountered in the chain.
    if (!lastError) {
      lastError = `${evalModel}: not available`;
    }
  }

  // All models exhausted
  return `VERDICT: FAIL — infra: All LLM tools exhausted. Tried: ${ordered.join(" → ")}. Last error: ${lastError}`;
}
