import { resolveCodexBinary } from "@jleechanorg/ao-plugin-agent-codex";
import {
  LLM_EVAL_TIMEOUT_MS,
  DEFAULT_CODEX_MODEL,
  STRICT_VERDICT_RE,
  type LlmEvalResult,
  isUnavailable,
} from "./llm-eval-shared.js";

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
    maxBuffer: 10 * 1024 * 1024, // 10 MB — prevent stderr maxBuffer overflow
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
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
