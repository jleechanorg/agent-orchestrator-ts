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
 * If the chain exhausts all models without a verdict, returns
 * "VERDICT: FAIL — infra: ..." with diagnostic detail.
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
 *
 * Chain semantics (post-#725):
 * - First model to produce a valid VERDICT line wins.
 * - ANY error (ENOENT, 401, 403, 429, quota exhausted, OAuth missing, real crash,
 *   missing VERDICT line) falls through to the next model. We no longer hard-fail
 *   on "model ran but didn't produce VERDICT" — that's a per-model prompt-format
 *   mismatch, not necessarily a prompt-template defect, so we try the next model.
 * - If 2 consecutive models produce the same outcome signature
 *   (same error string OR same "unavailable:<model>" result), the chain stops
 *   early. Two same-signature outcomes in a row is strong evidence of a
 *   systemic issue (broken prompt template, shared credential expired, etc.)
 *   and continuing would waste latency.
 * - If the chain exhausts all models without a verdict, returns
 *   "VERDICT: FAIL — infra: All LLM tools exhausted. ..." with the most
 *   informative error captured during the run.
 */
export type ChainModel = "codex" | "claude" | "gemini" | "minimax" | "agy";

export async function llmEval(
  prompt: string,
  options: { model?: ChainModel | ChainModel[] } = {},
): Promise<string> {
  let { model } = options;
  if (model === ("cursor" as unknown)) {
    model = "codex";
  }

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
    if (startIdx === -1) {
      throw new Error(
        `Invalid model: "${preferred}". Expected a ChainModel value from DEFAULT_CHAIN.`
      );
    }
    ordered = [...DEFAULT_CHAIN.slice(startIdx), ...DEFAULT_CHAIN.slice(0, startIdx)];
  }

  let lastError = "";
  // Dedup state: if N consecutive models produce the same outcome signature,
  // assume a systemic issue (broken prompt template, all-creds-expired, etc.)
  // and stop early to avoid wasting latency on the remaining models.
  // The signature covers "real error" (error:<msg>), "missing VERDICT"
  // (normalized to "missing_verdict" across models), and "tool unavailable"
  // (unavailable:<model>) cases.
  // Threshold of 3 = allows 2 attempts before declaring a systemic issue.
  let lastSig: string | undefined = undefined;
  let sameSigCount = 0;
  const DEDUP_THRESHOLD = 3;

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

    // Build signature for dedup. Normalize "missing VERDICT" outcomes to a
    // stable signature so two consecutive models each producing missing
    // VERDICT (with different model names in the message) are recognized
    // as the same systemic issue (prompt-template vs. model mismatch).
    // Other errors keep their literal string as the signature.
    const sig =
      result.error !== undefined
        ? /missing VERDICT/i.test(result.error)
          ? "missing_verdict"
          : `error:${result.error}`
        : `unavailable:${evalModel}`;

    if (sig === lastSig) {
      sameSigCount++;
    } else {
      sameSigCount = 1;
      lastSig = sig;
    }

    if (sameSigCount >= DEDUP_THRESHOLD) {
      // Stop early — same outcome from N consecutive models likely means
      // a systemic issue (e.g. prompt template broken for all models,
      // shared credential expired, all binaries installed but produce
      // identical crash). Continuing would waste latency for no gain.
      return `VERDICT: FAIL — infra: ${sameSigCount} consecutive models returned same outcome (${sig}). Stopped early. Tried: ${ordered.join(" → ")}. Last error: ${lastError || sig}`;
    }

    if (result.error !== undefined) {
      lastError = result.error;
    } else if (!lastError) {
      lastError = `${evalModel}: not available`;
    }
    // Continue to next model — chain tries every binary regardless of
    // error type. Missing VERDICT no longer hard-fails; that's the
    // prompt-template-vs-model mismatch signal, which we now treat as
    // "try a different model that might follow the template better".
  }

  // All models exhausted
  return `VERDICT: FAIL — infra: All LLM tools exhausted. Tried: ${ordered.join(" → ")}. Last error: ${lastError}`;
}
