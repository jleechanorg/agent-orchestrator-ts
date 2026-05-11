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
const DEFAULT_CODEX_MODEL = process.env["AO_LLM_EVAL_CODEX_MODEL"] ?? "gpt-5.5";
const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/anthropic";

/** Env vars to propagate minimax credentials to codex/claude exec calls.
 * Only overrides ANTHROPIC_API_KEY when MINIMAX_API_KEY is actually set —
 * otherwise the child inherits the parent's env (e.g. AO_WORKER_ANTHROPIC_KEY). */
function minimaxEnv(): Record<string, string> {
  const apiKey = process.env["MINIMAX_API_KEY"];
  const baseUrl = process.env["MINIMAX_ANTHROPIC_BASE_URL"];
  if (!apiKey) return {}; // No override — child inherits parent env including ANTHROPIC_API_KEY
  return {
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_BASE_URL: baseUrl || DEFAULT_MINIMAX_BASE_URL,
  };
}

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

  const execOptions: {
    input: string;
    encoding: "utf-8";
    timeout: number;
    maxBuffer: number;
    stdio: ["pipe", "pipe", "pipe"];
    env: Record<string, string | undefined>;
  } = {
    input: prompt,
    encoding: "utf-8",
    timeout: LLM_EVAL_TIMEOUT_MS,
    maxBuffer: 1 << 20, // 1 MB — prevent stderr maxBuffer overflow
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...minimaxEnv(),
    },
  };

  function attempt(): string {
    return execFileSync(
      binary,
      ["exec", "--model", DEFAULT_CODEX_MODEL, "-c", "check_for_update_on_startup=false", "-"],
      execOptions,
    ) as string;
  }

  let result: string;
  try {
    result = attempt();
  } catch (primaryErr: unknown) {
    const errnoException = primaryErr as NodeJS.ErrnoException;
    const msg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    // ENOENT / auth failures → binary unavailable, don't retry
    if (errnoException.code === "ENOENT" || isUnavailable(msg, errnoException.code as string)) {
      return { validVerdict: false, output: "", error: undefined }; // → try next
    }
    // Otherwise, retry without the `-c config` flag — older Codex releases may reject it
    console.warn(
      `[llm-eval] Codex exec with check_for_update_on_startup=false failed: ${msg.split("\n")[0]}. Retrying without the flag.`,
    );
    try {
      result = execFileSync(
        binary,
        ["exec", "--model", DEFAULT_CODEX_MODEL, "-"],
        execOptions,
      ) as string;
    } catch (retryErr: unknown) {
      const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      const retryErrno = retryErr as NodeJS.ErrnoException;
      if (retryErrno.code === "ENOENT" || isUnavailable(retryMsg, retryErrno.code as string)) {
        return { validVerdict: false, output: "", error: undefined };
      }
      const shortMsg = retryMsg.split("\n")[0]?.slice(0, 300) ?? retryMsg.slice(0, 300);
      return { validVerdict: false, output: "", error: shortMsg };
    }
  }

  const output = result.trim();
  if (!STRICT_VERDICT_RE.test(output)) {
    return {
      validVerdict: false,
      output,
      error: `Codex output missing VERDICT line (got ${output.slice(0, 100)}...)`,
    };
  }
  return { validVerdict: true, output };
}


/**
 * Run claude --print for headless evaluation.
 * Fail-closed: missing VERDICT = failure.
 */

/** Shared exec options — avoids duplication across initial attempt and 429 retry. */
function makeClaudeExecOptions(
  prompt: string,
): {
  input: string;
  encoding: "utf-8";
  timeout: number;
  maxBuffer: number;
  stdio: ["pipe", "pipe", "ignore"];
  cwd: string;
  env: Record<string, string | undefined>;
} {
  return {
    input: prompt,
    encoding: "utf-8",
    timeout: LLM_EVAL_TIMEOUT_MS,
    maxBuffer: 1 << 20,
    stdio: ["pipe", "pipe", "ignore"],
    cwd: "/tmp",
    env: {
      ...process.env,
      ...minimaxEnv(),
    },
  };
}

/** True when msg indicates an auth failure that is global to all binaries. */
function isAuthError(msg: string): boolean {
  return (
    /\b401\b/i.test(msg) ||
    /\b403\b/i.test(msg) ||
    msg.toLowerCase().includes("unauthorized") ||
    msg.toLowerCase().includes("forbidden")
  );
}

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
        ["--dangerously-skip-permissions", "--print"],
        makeClaudeExecOptions(prompt),
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

      // ETIMEDOUT = binary-specific hang (e.g. GUI app in headless launchd context).
      // Another candidate (e.g. CLI-only binary) may not hang. Continue to next.
      if (errno === "ETIMEDOUT") {
        allMissing = false;
        continue;
      }

      // 429 = MiniMax rate-limit. Retry once with 2s backoff; if still failing,
      // continue to next candidate (another binary may not hit the same rate limit).
      if (/\b429\b/i.test(msg) || msg.toLowerCase().includes("rate_limit") || msg.toLowerCase().includes("rate limit")) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const retryResult = execFileSync(
            candidate,
            ["--dangerously-skip-permissions", "--print"],
            makeClaudeExecOptions(prompt),
          );
          const retryOutput = retryResult.trim();
          if (STRICT_VERDICT_RE.test(retryOutput)) {
            return { validVerdict: true, output: retryOutput };
          }
          return {
            validVerdict: false,
            output: retryOutput,
            error: `Claude output missing VERDICT line (got ${retryOutput.slice(0, 100)}...)`,
          };
        } catch (retryErr: unknown) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          // Retry 429: give up on this candidate, continue to next
          if (/\b429\b/i.test(retryMsg) || retryMsg.toLowerCase().includes("rate_limit") || retryMsg.toLowerCase().includes("rate limit")) {
            allMissing = false;
            continue;
          }
          // Retry 401/403: auth is global — no other binary will help, return immediately
          if (isAuthError(retryMsg)) {
            return { validVerdict: false, output: "", error: undefined };
          }
          // Any other retry error: treat as infra error, try next candidate
          allMissing = false;
          if (!firstInfraError) firstInfraError = retryMsg;
          continue;
        }
      }

      // 401/403 = auth failure. All binaries share the same credentials → return immediately.
      if (isAuthError(msg)) {
        return { validVerdict: false, output: "", error: undefined };
      }

      // Other infra errors: record and continue to next candidate
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

/** Known gemini binary locations, tried in order. */
const GEMINI_BINARY_CANDIDATES = [
  process.env["GEMINI_BINARY"] ?? "",
  "/usr/local/bin/gemini",
  "/opt/homebrew/bin/gemini",
  "gemini",
].filter(Boolean);

/**
 * Run gemini -p for headless evaluation.
 * Gemini CLI supports `-p` for non-interactive headless mode.
 * Fail-closed: missing VERDICT = failure.
 */
export async function tryGeminiPrint(prompt: string): Promise<LlmEvalResult> {
  const { execFileSync } = await import("node:child_process");

  for (const candidate of GEMINI_BINARY_CANDIDATES) {
    if (!candidate) continue;

    if (candidate !== "gemini") {
      try {
        accessSync(candidate, fsConstants.X_OK);
      } catch {
        continue;
      }
    }

    try {
      const result = execFileSync(
        candidate,
        ["--yolo", "-p", ""],
        {
          input: prompt,
          encoding: "utf-8",
          timeout: LLM_EVAL_TIMEOUT_MS,
          maxBuffer: 1 << 20,
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

      if (errno === "ENOENT") continue;

      if (isUnavailable(msg, errno as string)) {
        continue;
      }

      return { validVerdict: false, output: "", error: msg.split("\n")[0]?.slice(0, 300) };
    }
  }

  return { validVerdict: false, output: "", error: undefined };
}

/**
 * Run a skeptic-style LLM evaluation and return the raw output.
 *
 * @param prompt - The evaluation prompt (must contain VERDICT: PASS/FAIL criteria)
 * @param options.model - Prefer this model ("codex" | "claude" | "gemini" | "cursor"); default "codex"
 *
 * Headless fallback chain:
 *   codex → claude → gemini
 *
 * cursor is accepted for CLI compatibility but excluded:
 * cursor-agent blocks on Workspace Trust.
 */
export async function llmEval(
  prompt: string,
  options: { model?: "codex" | "claude" | "gemini" | "cursor" } = {},
): Promise<string> {
  const preferred = options.model ?? "codex";

  const isMissingVerdict = (err?: string) =>
    err !== undefined && /missing VERDICT/i.test(err);

  const chain: Array<"codex" | "claude" | "gemini"> = ["codex", "claude", "gemini"];
  const preferredHeadless = preferred === "claude" ? "claude" : preferred === "gemini" ? "gemini" : "codex";

  // Rotate so a supported preferred model comes first, followed by the others.
  const startIdx = Math.max(0, chain.indexOf(preferredHeadless));
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
    // Only set "not available" if we haven't recorded an error yet.
    // Infra errors (set above) are preserved since they're more informative
    // (tool IS installed but something went wrong); "not available" is a
    // fallback when no infra error has been encountered in the chain.
    if (!lastError) {
      lastError = `${model}: not available`;
    }
  }

  // All models exhausted
  return `VERDICT: FAIL — infra: All LLM tools exhausted. Tried: ${ordered.join(" → ")}. Last error: ${lastError}`;
}
