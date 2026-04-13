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

import { resolveCodexBinary } from "@jleechanorg/ao-plugin-agent-codex";
import { accessSync, constants as fsConstants } from "node:fs";
import { buildVerdictLineRe } from "../commands/skeptic/verdict-utils.js";

const LLM_EVAL_TIMEOUT_MS = 300_000;
const DEFAULT_CODEX_MODEL = process.env["AO_LLM_EVAL_CODEX_MODEL"] ?? "gpt-5.4";
const DEFAULT_CLAUDE_MODEL =
  process.env["AO_LLM_EVAL_CLAUDE_MODEL"] ?? "claude-sonnet-4-6";

/** Known claude binary locations, tried in order. */
const CLAUDE_BINARY_CANDIDATES = [
  process.env["CLAUDE_BINARY"] ?? "",
  // nvm-style user-local (preferred — headless-compatible CLI)
  process.env["HOME"] ? `${process.env["HOME"]}/.local/bin/claude` : "",
  // Homebrew / user-local
  "/usr/local/bin/claude",
  "/opt/homebrew/bin/claude",
  // Claude Code standalone (macOS)
  "/Applications/Claude Code.app/Contents/Resources/bin/claude",
  // cmux release app (macOS) — GUI app, may ETIMEDOUT in launchd context
  "/Applications/cmux.app/Contents/Resources/bin/claude",
  // cmux DEV app (macOS) — GUI app, typically ETIMEDOUT in headless context
  "/Applications/cmux DEV.app/Contents/Resources/bin/claude",
  // PATH lookup (last resort — may not be available in launchd env)
  "claude",
].filter(Boolean);

/** Strict VERDICT matcher for tool output validation — PASS or FAIL only.
 * SKIPPED was the old infra-unavailable sentinel; it has been replaced by
 * VERDICT: FAIL (fail-closed). This regex intentionally rejects SKIPPED —
 * infra failures must block merges. */
const STRICT_VERDICT_RE = buildVerdictLineRe(["PASS", "FAIL"]);

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
export function isUnavailable(errMsg: string, errCode?: string): boolean {
  // ENOENT = binary not installed
  // ETIMEDOUT = network/connection timeout — infrastructure unavailable, try next
  // 401/403 = credentials missing or invalid — treat as "unavailable" so fallback chain continues
  // Use word-boundary-aware regex to avoid false positives on strings like "took 4030ms"
  const lower = errMsg.toLowerCase();
  return (
    lower.includes("enoent") ||
    errCode === "ETIMEDOUT" ||
    // \b matches word boundary — so "401 " matches but "4012" does not
    /\b401\b/i.test(errMsg) ||
    /\b403\b/i.test(errMsg) ||
    /\b429\b/i.test(errMsg) ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("quota") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("resource_exhausted") ||
    lower.includes("insufficient_quota")
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
      ["exec", "--model", DEFAULT_CODEX_MODEL, "-"],
      {
        input: prompt,
        encoding: "utf-8",
        timeout: LLM_EVAL_TIMEOUT_MS,
        maxBuffer: 1 << 20, // 1 MB — prevent stderr maxBuffer overflow
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const output = result.trim();
    if (!STRICT_VERDICT_RE.test(output)) {
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
    if (errno.code === "ENOENT" || isUnavailable(msg, errno.code as string)) {
      return { validVerdict: false, output: "", error: undefined }; // → try next
    }
    // Truncate to first line only — Codex echoes the full prompt in its session log,
    // which contains "VERDICT: PASS" as template example text. If we embed the full
    // error message in the verdict comment, skeptic-gate.yml's grep finds the template
    // text and incorrectly reports PASS. First line is always "Command failed: <cmd>".
    const shortMsg = msg.split("\n")[0]?.slice(0, 300) ?? msg.slice(0, 300);
    return { validVerdict: false, output: "", error: shortMsg };
  }
}

/**
 * Run cursor-agent (stdin) for headless evaluation via Cursor's CLI.
 * Fail-closed: missing VERDICT = failure.
 *
 * Prompt is passed via stdin to avoid exposing contents in process listings
 * and to prevent OS argv length overflows on large skeptic prompts.
 */
export async function tryCursorAgentPrint(prompt: string): Promise<LlmEvalResult> {
  const { execFileSync } = await import("node:child_process");

  try {
    const result = execFileSync(
      "cursor-agent",
      ["--print"],
      {
        input: prompt,
        encoding: "utf-8",
        timeout: LLM_EVAL_TIMEOUT_MS,
        stdio: ["pipe", "pipe", "ignore"],
        cwd: "/tmp",
      },
    );
    const output = result.trim();
    if (!STRICT_VERDICT_RE.test(output)) {
      return {
        validVerdict: false,
        output,
        error: `Cursor Agent output missing VERDICT line (got ${output.slice(0, 100)}...)`,
      };
    }
    return { validVerdict: true, output };
  } catch (err: unknown) {
    const errno = (err as NodeJS.ErrnoException).code;
    const msg = err instanceof Error ? err.message : String(err);
    if (errno === "ENOENT" || isUnavailable(msg, errno as string | undefined)) {
      return { validVerdict: false, output: "", error: undefined };
    }
    return { validVerdict: false, output: "", error: msg };
  }
}

/**
 * Run gemini (stdin) for headless evaluation.
 * Fail-closed: missing VERDICT = failure.
 *
 * Prompt is passed via stdin to avoid exposing contents in process listings
 * and to prevent OS argv length overflows on large skeptic prompts.
 */
export async function tryGeminiPrint(prompt: string): Promise<LlmEvalResult> {
  const { execFileSync } = await import("node:child_process");

  try {
    const result = execFileSync(
      "gemini",
      [],
      {
        input: prompt,
        encoding: "utf-8",
        timeout: LLM_EVAL_TIMEOUT_MS,
        stdio: ["pipe", "pipe", "ignore"],
        cwd: "/tmp",
      },
    );
    const output = result.trim();
    if (!STRICT_VERDICT_RE.test(output)) {
      return {
        validVerdict: false,
        output,
        error: `Gemini output missing VERDICT line (got ${output.slice(0, 100)}...)`,
      };
    }
    return { validVerdict: true, output };
  } catch (err: unknown) {
    const errno = (err as NodeJS.ErrnoException).code;
    const msg = err instanceof Error ? err.message : String(err);
    if (errno === "ENOENT" || isUnavailable(msg, errno as string | undefined)) {
      return { validVerdict: false, output: "", error: undefined };
    }
    return { validVerdict: false, output: "", error: msg };
  }
}

/**
 * Run claude --print for headless evaluation.
 * Fail-closed: missing VERDICT = failure.
 */
export async function tryClaudePrint(prompt: string): Promise<LlmEvalResult> {
  const { execFileSync } = await import("node:child_process");

  let firstInfraError: string | undefined;
  let allMissing = true;

  for (const candidate of CLAUDE_BINARY_CANDIDATES) {
    if (!candidate) continue;

    // Validate executability before attempting to run
    if (candidate !== "claude") {
      try {
        accessSync(candidate, fsConstants.X_OK);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          continue; // Binary not installed — try next candidate
        }
        // EACCES/EPERM or other: binary exists but is not executable — treat as infra error
        allMissing = false;
        if (!firstInfraError) {
          firstInfraError = err instanceof Error ? err.message : String(err);
        }
        continue;
      }
    }

    try {
      const result = execFileSync(
        candidate,
        ["--dangerously-skip-permissions", "--print", "--model", DEFAULT_CLAUDE_MODEL],
        {
          input: prompt,
          encoding: "utf-8",
          timeout: LLM_EVAL_TIMEOUT_MS,
          stdio: ["pipe", "pipe", "ignore"],
          // Run from /tmp to prevent project-level CLAUDE.md hooks (e.g. mandatory
          // git-header appended to every response) from polluting the output and
          // hiding the VERDICT line from the regex check.
          cwd: "/tmp",
        },
      );
      const output = result.trim();
      if (!STRICT_VERDICT_RE.test(output)) {
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

      // ENOENT = binary not installed — try next candidate
      if (errno === "ENOENT") {
        continue;
      }

      // 401/403/429 = credentials / quota — treat as "tool unavailable" globally;
      // trying another binary won't help if they use the same global config.
      if (isUnavailable(msg, errno as string | undefined)) {
        return { validVerdict: false, output: "", error: undefined }; // → caller skips this tool
      }

      // Found a binary but it failed with an infra error (e.g. timeout, dynamic link error)
      allMissing = false;
      if (!firstInfraError) firstInfraError = msg;

      // Try next candidate in case another one is working
      continue;
    }
  }

  if (allMissing) {
    return { validVerdict: false, output: "", error: undefined };
  }

  // At least one binary was found but all failed with infra errors
  return { validVerdict: false, output: "", error: firstInfraError };
}

/**
 * Run a skeptic-style LLM evaluation and return the raw output.
 *
 * @param prompt - The evaluation prompt (must contain VERDICT: PASS/FAIL criteria)
 * @param options.model - Prefer this model ("codex" | "claude" | "gemini" | "cursor"); default "codex"
 *
 * Unified fallback chain (no API keys used — all use OAuth/binary auth):
 *   codex → claude → gemini → cursor
 *
 * If a preferred model is specified, it is tried first, then all remaining models follow.
 * All tools use OAuth/binary-level auth — no API key configuration required.
 */
export async function llmEval(
  prompt: string,
  options: { model?: "codex" | "claude" | "gemini" | "cursor" } = {},
): Promise<string> {
  const preferred = options.model ?? "codex";

  const isMissingVerdict = (err?: string) =>
    err !== undefined && /missing VERDICT/i.test(err);

  // Unified fallback chain: all models tried in order regardless of preferred start
  const chain: Array<"codex" | "claude" | "gemini" | "cursor"> = ["codex", "claude", "gemini", "cursor"];

  // Rotate so preferred model comes first, followed by all others
  const startIdx = Math.max(0, chain.indexOf(preferred));
  const ordered = [...chain.slice(startIdx), ...chain.slice(0, startIdx)];

  let lastError = "";

  for (const model of ordered) {
    let result: LlmEvalResult;

    switch (model) {
      case "codex":
        result = await tryCodexPrint(prompt);
        break;
      case "claude":
        result = await tryClaudePrint(prompt);
        break;
      case "gemini":
        result = await tryGeminiPrint(prompt);
        break;
      case "cursor":
        result = await tryCursorAgentPrint(prompt);
        break;
    }

    if (result.validVerdict) return result.output;

    if (isMissingVerdict(result.error)) {
      return `VERDICT: FAIL — ${model}: ${result.error}`;
    }

    if (result.error) {
      lastError = result.error;
      // Infra failure — continue to next model in chain
      continue;
    }

    // Tool unavailable (ENOENT / 401 / 403 / 429) — try next model
    // Keep advancing "not available" until a real error appears (don't clobber ETIMEDOUT etc.)
    if (!lastError || /: not available$/.test(lastError)) {
      lastError = `${model}: not available`;
    }
  }

  // All models exhausted
  return `VERDICT: FAIL — infra: All LLM tools exhausted. Tried: ${ordered.join(" → ")}. Last error: ${lastError}`;
}
