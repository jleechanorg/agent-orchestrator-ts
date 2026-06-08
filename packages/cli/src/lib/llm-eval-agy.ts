import { accessSync, constants as fsConstants } from "node:fs";
import {
  LLM_EVAL_TIMEOUT_MS,
  STRICT_VERDICT_RE,
  type LlmEvalResult,
  isUnavailable,
  isAuthError,
} from "./llm-eval-shared.js";

/** Known agy (Google Antigravity/Gemini CLI) binary locations, tried in order. */
const AGY_BINARY_CANDIDATES = [
  process.env["AGY_BINARY"] ?? "",
  process.env["HOME"] ? `${process.env["HOME"]}/.local/bin/agy` : "",
  "/usr/local/bin/agy",
  "/opt/homebrew/bin/agy",
  "agy",
].filter(Boolean);

/**
 * Run agy (Google Antigravity CLI) for headless evaluation.
 * Fail-closed: missing VERDICT = failure.
 */
export async function tryAgyPrint(prompt: string): Promise<LlmEvalResult> {
  const { execFileSync } = await import("node:child_process");
  let firstInfraError: string | undefined;
  let allMissing = true;

  for (const candidate of AGY_BINARY_CANDIDATES) {
    if (!candidate) continue;

    if (candidate !== "agy") {
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
      const result = execFileSync(
        candidate,
        ["--yolo", "-p", ""],
        {
          input: prompt,
          encoding: "utf-8",
          timeout: LLM_EVAL_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
          stdio: ["pipe", "pipe", "ignore"],
          cwd: "/tmp",
        },
      );
      const output = result.trim();
      if (!STRICT_VERDICT_RE.test(output)) {
        return {
          validVerdict: false,
          output,
          error: `agy output missing VERDICT line (got ${output.slice(0, 100)}...)`,
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
      if (isAuthError(msg)) {
        return { validVerdict: false, output: "", error: undefined };
      }
      if (isUnavailable(msg, errno as string)) {
        continue;
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
