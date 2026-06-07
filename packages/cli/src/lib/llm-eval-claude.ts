import { accessSync, constants as fsConstants } from "node:fs";
import {
  CLAUDE_BINARY_CANDIDATES,
  STRICT_VERDICT_RE,
  type LlmEvalResult,
  isAuthError,
  makeClaudeExecOptions,
} from "./llm-eval-shared.js";

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
        ["--bare", "--dangerously-skip-permissions", "--print"],
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
            ["--bare", "--dangerously-skip-permissions", "--print"],
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
