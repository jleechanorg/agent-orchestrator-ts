import { accessSync, constants as fsConstants } from "node:fs";
import {
  DEFAULT_MINIMAX_BASE_URL,
  CLAUDE_BINARY_CANDIDATES,
  STRICT_VERDICT_RE,
  type LlmEvalResult,
  isUnavailable,
  isAuthError,
  execClaudeBinaryWithRetry,
} from "./llm-eval-shared.js";

/**
 * Run MiniMax via claude CLI with ANTHROPIC_BASE_URL override.
 * Requires MINIMAX_API_KEY in env.
 * Fail-closed: missing VERDICT = failure.
 */
export async function tryMinimaxPrint(prompt: string): Promise<LlmEvalResult> {
  const apiKey = process.env["MINIMAX_API_KEY"];
  if (!apiKey) {
    return { validVerdict: false, output: "", error: undefined };
  }
  const baseUrl = process.env["MINIMAX_ANTHROPIC_BASE_URL"] ?? DEFAULT_MINIMAX_BASE_URL;

  let firstInfraError: string | undefined;
  let allMissing = true;

  for (const candidate of CLAUDE_BINARY_CANDIDATES) {
    if (!candidate) continue;
    if (candidate !== "claude") {
      try {
        accessSync(candidate, fsConstants.X_OK);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          continue;
        }
        allMissing = false;
        if (!firstInfraError) {
          firstInfraError = err instanceof Error ? err.message : String(err);
        }
        continue;
      }
    }

    try {
      allMissing = false;
      const output = await execClaudeBinaryWithRetry(candidate, prompt, {
        ANTHROPIC_API_KEY: apiKey,
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ANTHROPIC_BASE_URL: baseUrl,
      });
      if (!STRICT_VERDICT_RE.test(output)) {
        return {
          validVerdict: false,
          output,
          error: `minimax output missing VERDICT line (got ${output.slice(0, 100)}...)`,
        };
      }
      return { validVerdict: true, output };
    } catch (err: unknown) {
      const errno = (err as NodeJS.ErrnoException).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (errno === "ENOENT") {
        continue;
      }
      if (errno === "ETIMEDOUT") {
        continue;
      }
      if (isAuthError(msg) || isUnavailable(msg, errno as string)) {
        return { validVerdict: false, output: "", error: undefined };
      }
      if (!firstInfraError) {
        firstInfraError = msg.split("\n")[0]?.slice(0, 300);
      }
      continue;
    }
  }

  if (allMissing) {
    return { validVerdict: false, output: "", error: undefined };
  }

  return { validVerdict: false, output: "", error: firstInfraError };
}

