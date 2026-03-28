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
 *   claude --print --no-input  (secondary — Claude with ANTHROPIC_API_KEY)
 *
 * The evaluated output must contain VERDICT: PASS or VERDICT: FAIL.
 * Missing VERDICT = fail-closed FAIL.
 */

import { resolveCodexBinary } from "@jleechanorg/ao-plugin-agent-codex";

const CODEX_TIMEOUT_MS = 120_000;
const CLAUDE_TIMEOUT_MS = 120_000;

/** Line-anchored VERDICT matcher — accepts VERDICT: PASS/FAIL/SKIPPED with optional markdown prefix and trailing content. */
const VERDICT_LINE_RE = /^(?:#{1,3}\s*|\*{1,2})?VERDICT:\s*(PASS|FAIL|SKIPPED)\b/im;

export interface LlmEvalResult {
  /** Whether a valid VERDICT line was obtained from the tool.
   *  false + error=undefined: tool unavailable (not installed / no credentials) — caller should try next.
   *  false + error=string: tool ran but produced no VERDICT — fail-closed.
   *  true: valid VERDICT obtained. */
  validVerdict: boolean;
  output: string;
  /** Set when the tool ran but produced non-VERDICT output, or when it errored fatally.
   *  Undefined means "tool unavailable — try next". */
  error?: string;
}

/** Errors that mean the tool is unavailable and the caller should try the next one. */
// Exported for unit testing; production callers use the public functions only.
export function isUnavailable(errMsg: string): boolean {
  // ENOENT = binary not installed
  // 401/403 = credentials missing or invalid — treat as "unavailable" so fallback chain continues
  // Use word-boundary-aware regex to avoid false positives on strings like "took 4030ms"
  const lower = errMsg.toLowerCase();
  return (
    lower.includes("enoent") ||
    // \b matches word boundary — so "401 " matches but "4012" does not
    /\b401\b/i.test(errMsg) ||
    /\b403\b/i.test(errMsg) ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  );
}

/**
 * Run codex exec - (stdin) for headless evaluation.
 * Uses resolveCodexBinary() from agent-codex plugin for portable path detection.
 * Fail-closed: missing VERDICT = failure (returns error string, not undefined).
 *
 * Prompt is passed via stdin (codex exec -) to avoid:
 * - Exposing prompt contents in process listings (ps)
 * - Hitting OS argument-length limits on very long prompts
 */
export async function tryCodexPrint(prompt: string): Promise<LlmEvalResult> {
  const { execFileSync } = await import("node:child_process");

  const binary = await resolveCodexBinary();

  try {
    const result = execFileSync(
      binary,
      ["exec", "-"],
      {
        input: prompt,
        encoding: "utf-8",
        timeout: CODEX_TIMEOUT_MS,
        maxBuffer: 1 << 20, // 1 MB — prevent stderr maxBuffer overflow
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const output = result.trim();
    if (!VERDICT_LINE_RE.test(output)) {
      // Tool ran but model failed to produce required output — fail-closed.
      return {
        validVerdict: false,
        output,
        error: `Codex output missing VERDICT line (got ${output.slice(0, 100)}...)`,
      };
    }
    return { validVerdict: true, output };
  } catch (err: unknown) {
    const errno = err as NodeJS.ErrnoException;
    const msg = err instanceof Error ? err.message : String(err);
    // Unavailable: binary not installed OR auth failure — try next tool
    if (errno.code === "ENOENT" || isUnavailable(msg)) {
      return { validVerdict: false, output: "", error: undefined }; // → try next
    }
    // All other errors (timeout, Command failed without auth issue, etc.) are real failures
    // — fail-closed: do NOT fall through to next tool
    return { validVerdict: false, output: "", error: msg };
  }
}

/**
 * Run claude --print for headless evaluation.
 * Fail-closed: missing VERDICT = failure.
 */
export async function tryClaudePrint(prompt: string): Promise<LlmEvalResult> {
  const { execFileSync } = await import("node:child_process");

  try {
    const result = execFileSync(
      "claude",
      ["--print"],
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
    const errno = (err as NodeJS.ErrnoException).code;
    const msg = err instanceof Error ? err.message : String(err);
    // ENOENT = binary not installed — treat as unavailable so caller can fall through
    // Any other non-zero exit (auth failed, token invalid, etc.) = also unavailable;
    // the fallback chain handles credential gaps. Only fatal/ENOENT stops the chain.
    if (errno === "ENOENT" || isUnavailable(msg)) {
      return { validVerdict: false, output: "", error: undefined }; // → caller skips this tool
    }
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

  // Helper: check if error means "tool ran but model omitted VERDICT" (fail-closed)
  const isMissingVerdict = (err?: string) =>
    err !== undefined && /missing VERDICT/i.test(err);

  // If user explicitly chose claude, try it first and skip codex
  if (model === "claude") {
    const result = await tryClaudePrint(prompt);
    if (result.validVerdict) return result.output;
    if (isMissingVerdict(result.error)) {
      // Tool ran but model produced no VERDICT — fail closed (block merge rather than skip)
      return `VERDICT: FAIL — claude: ${result.error}`;
    }
    if (result.error) {
      // Infra failure — try codex as fallback before returning SKIPPED
      const codexResult = await tryCodexPrint(prompt);
      if (codexResult.validVerdict) return codexResult.output;
      return `VERDICT: SKIPPED — infra: Claude failed: ${result.error}. Codex: ${codexResult.error ?? "not available"}.`;
    }
    // Claude unavailable (ENOENT) — try codex as last resort
    const codexResult = await tryCodexPrint(prompt);
    if (codexResult.validVerdict) return codexResult.output;
    return `VERDICT: SKIPPED — infra: Neither Claude nor Codex available. Claude: ${result.error ?? "not available"}. Codex: ${codexResult.error ?? "not available"}.`;
  }

  // Default: codex primary
  const codexResult = await tryCodexPrint(prompt);
  if (codexResult.validVerdict) return codexResult.output;
  if (isMissingVerdict(codexResult.error)) {
    // Tool ran but model produced no VERDICT — fail closed; try Claude before giving up
    const claudeResult = await tryClaudePrint(prompt);
    if (claudeResult.validVerdict) return claudeResult.output;
    return `VERDICT: FAIL — codex: ${codexResult.error}. Claude: ${claudeResult.error ?? "not available"}.`;
  }
  if (codexResult.error) {
    // Infra failure — try Claude as fallback before returning SKIPPED
    const claudeResult = await tryClaudePrint(prompt);
    if (claudeResult.validVerdict) return claudeResult.output;
    return `VERDICT: SKIPPED — infra: Codex failed: ${codexResult.error}. Claude: ${claudeResult.error ?? "not available"}.`;
  }

  // Codex not available (ENOENT) — try Claude as fallback
  const claudeResult = await tryClaudePrint(prompt);
  if (claudeResult.validVerdict) return claudeResult.output;
  if (claudeResult.error) {
    return `VERDICT: SKIPPED — infra: Both Codex and Claude evaluation failed. Codex: ${codexResult.error ?? "not available"}. Claude: ${claudeResult.error}`;
  }

  return "VERDICT: SKIPPED — infra: Neither Codex nor Claude CLI available for skeptic evaluation";
}
