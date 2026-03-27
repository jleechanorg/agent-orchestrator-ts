import { spawn } from "node:child_process";

/**
 * Model runner — runs the skeptical LLM evaluation.
 * Uses Claude CLI (`claude --print`) for headless evaluation.
 *
 * Note: `--no-input` is NOT a valid Claude CLI flag (as of v2.1.x).
 * Use `--print` for non-interactive output. Prompt is passed via stdin.
 */

export async function runSkepticEvaluation(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["--print"], {
      // Explicit stdio: capture stderr for error diagnostics, pipe stdin.
      stdio: ["pipe", "pipe", "pipe"],
      // Keep env clean; Claude reads stdin for prompt.
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      child.kill();
      resolve("VERDICT: FAIL — Claude CLI timed out after 120s");
    }, 120_000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const stderrSnippet = stderr ? `\nstderr: ${stderr.slice(0, 300)}` : "";
        resolve(
          `VERDICT: FAIL — Claude CLI exited with code ${code}${stderrSnippet}`,
        );
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve(`VERDICT: FAIL — Claude CLI not available: ${err.message.slice(0, 200)}`);
    });

    // Write prompt to stdin and close it so Claude processes it.
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}
