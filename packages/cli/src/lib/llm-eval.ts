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
 *   codex --print  (primary — Codex with OPENAI_API_KEY)
 *   claude --print --no-input  (secondary — Claude with ANTHROPIC_API_KEY)
 *
 * The evaluated output must contain VERDICT: PASS or VERDICT: FAIL.
 * Missing VERDICT = fail-closed FAIL.
 */

import { resolveCodexBinary } from "@jleechanorg/ao-plugin-agent-codex";

const CODEX_TIMEOUT_MS = 90_000;
const CLAUDE_TIMEOUT_MS = 60_000;
const MINIMAX_TIMEOUT_MS = 60_000;

/** Line-anchored VERDICT matcher — only accepts a single-line literal "VERDICT: PASS" or "VERDICT: FAIL". */
const VERDICT_LINE_RE = /^VERDICT:\s*(PASS|FAIL)\s*$/im;

export interface LlmEvalResult {
  /** Whether a valid VERDICT line was obtained from the tool.
   *  false + error=undefined: tool binary not found — caller should try next.
   *  false + error=string: tool ran but produced no VERDICT — fail-closed.
   *  true: valid VERDICT obtained. */
  validVerdict: boolean;
  output: string;
  /** Set when the tool ran but produced non-VERDICT output, or when it errored.
   *  Undefined means "tool not found — try next". */
  error?: string;
}

/**
 * Run codex --print --no-input for headless evaluation.
 * Uses resolveCodexBinary() from agent-codex plugin for portable path detection.
 * Fail-closed: missing VERDICT = failure (returns error string, not undefined).
 */
export async function tryCodexPrint(prompt: string): Promise<LlmEvalResult> {
  const { execFileSync } = await import("node:child_process");

  const binary = await resolveCodexBinary();

  try {
    const result = execFileSync(
      binary,
      ["--print", "--no-input"],
      {
        input: prompt,
        encoding: "utf-8",
        timeout: CODEX_TIMEOUT_MS,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const output = result.trim();
    if (!VERDICT_LINE_RE.test(output)) {
      return {
        validVerdict: false,
        output,
        error: `Codex output missing VERDICT line (got ${output.slice(0, 100)}...)`,
      };
    }
    return { validVerdict: true, output };
  } catch (err: unknown) {
    const errno = err as NodeJS.ErrnoException;
    // ENOENT — codex binary not installed, caller should try next tool
    if (errno.code === "ENOENT") {
      return { validVerdict: false, output: "", error: undefined }; // → try next
    }
    // All other errors (timeout, auth failure, Command failed, etc.) are real failures
    // — fail-closed: do NOT fall through to next tool
    const msg = err instanceof Error ? err.message : String(err);
    return { validVerdict: false, output: "", error: msg };
  }
}

/**
 * Call MiniMax chat API (OpenAI-compatible endpoint) for headless evaluation.
 * Uses MINIMAX_API_KEY env var. Fail-closed: missing VERDICT = failure.
 */
export async function tryMiniMax(prompt: string): Promise<LlmEvalResult> {
  const apiKey = process.env["MINIMAX_API_KEY"];
  if (!apiKey) {
    return { validVerdict: false, output: "", error: undefined }; // → try next
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MINIMAX_TIMEOUT_MS);

    const response = await fetch(
      "https://api.minimaxi.chat/v1/text/chatcompletion_v2",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "MiniMax-Text-01",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1024,
        }),
        signal: controller.signal,
      },
    );
    clearTimeout(timeout);

    if (!response.ok) {
      return {
        validVerdict: false,
        output: "",
        error: `MiniMax HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const json = await response.json() as {
      choices?: Array<{ messages?: Array<{ role: string; content: string }> }>;
      error?: { message?: string };
    };
    const content =
      json?.choices?.[0]?.messages?.[0]?.content ??
      json?.error?.message ??
      "";
    const output = content.trim();

    if (!VERDICT_LINE_RE.test(output)) {
      return {
        validVerdict: false,
        output,
        error: `MiniMax output missing VERDICT line (got ${output.slice(0, 100)}...)`,
      };
    }
    return { validVerdict: true, output };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { validVerdict: false, output: "", error: msg };
  }
}

/**
 * Run claude --print --no-input for headless evaluation.
 * Fail-closed: missing VERDICT = failure.
 */
export async function tryClaudePrint(prompt: string): Promise<LlmEvalResult> {
  const { execFileSync } = await import("node:child_process");

  try {
    const result = execFileSync(
      "claude",
      ["--print", "--no-input"],
      {
        input: prompt,
        encoding: "utf-8",
        timeout: CLAUDE_TIMEOUT_MS,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const output = result.trim();
    if (!VERDICT_LINE_RE.test(output)) {
      return {
        validVerdict: false,
        output,
        error: `Claude output missing VERDICT line (got ${output.slice(0, 100)}...)`,
      };
    }
    return { validVerdict: true, output };
  } catch (err: unknown) {
    const errno = err as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return { validVerdict: false, output: "", error: undefined }; // → no-op
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { validVerdict: false, output: "", error: msg };
  }
}

/**
 * Run a skeptic-style LLM evaluation and return the raw output.
 *
 * @param prompt - The evaluation prompt (must contain VERDICT: PASS/FAIL criteria)
 * @param options.model - Prefer this model ("codex" | "claude"); default "codex"
 */
export async function llmEval(
  prompt: string,
  options: { model?: "codex" | "claude" } = {},
): Promise<string> {
  const model = options.model ?? "codex";

  // If user explicitly chose claude, try it first and skip codex
  if (model === "claude") {
    const result = await tryClaudePrint(prompt);
    if (result.validVerdict) return result.output;
    if (result.error) {
      return `VERDICT: FAIL — Claude evaluation failed: ${result.error}`;
    }
    // Claude unavailable — fall through to codex as last resort
    const codexResult = await tryCodexPrint(prompt);
    if (codexResult.validVerdict) return codexResult.output;
    return `VERDICT: FAIL — Neither Claude nor Codex available. Claude: ${result.error ?? "not available"}. Codex: ${codexResult.error ?? "not available"}.`;
  }

  // Default: codex primary
  const codexResult = await tryCodexPrint(prompt);
  if (codexResult.validVerdict) return codexResult.output;
  if (codexResult.error) {
    // Codex failed with a real error — try MiniMax then Claude as fallbacks
    const miniMaxResult = await tryMiniMax(prompt);
    if (miniMaxResult.validVerdict) return miniMaxResult.output;
    const claudeResult = await tryClaudePrint(prompt);
    if (claudeResult.validVerdict) return claudeResult.output;
    return `VERDICT: FAIL — All LLM providers failed. Codex: ${codexResult.error}. MiniMax: ${miniMaxResult.error ?? "not configured"}. Claude: ${claudeResult.error ?? "not available"}.`;
  }

  // Codex not available — try MiniMax then Claude
  const miniMaxResult = await tryMiniMax(prompt);
  if (miniMaxResult.validVerdict) return miniMaxResult.output;

  const claudeResult = await tryClaudePrint(prompt);
  if (claudeResult.validVerdict) return claudeResult.output;
  if (claudeResult.error) {
    return `VERDICT: FAIL — Codex (not available), MiniMax, and Claude all failed. MiniMax: ${miniMaxResult.error ?? "not configured"}. Claude: ${claudeResult.error}`;
  }
  return "VERDICT: FAIL — Neither Codex nor Claude CLI available for skeptic evaluation";
}
