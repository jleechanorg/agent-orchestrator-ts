/**
 * Model runner — runs the skeptical LLM evaluation.
 * Uses Claude CLI (`claude --print`) for headless evaluation.
 *
 * Note: `--no-input` is NOT a valid Claude CLI flag (as of v2.1.x).
 * Use `--print` for non-interactive output. Prompt is passed via stdin.
 */

export async function runSkepticEvaluation(prompt: string): Promise<string> {
  try {
    const { execSync } = await import("node:child_process");
    // --print: outputs LLM response only (no interactive UI).
    // Prompt is piped via stdin. 2>/dev/null suppresses hook stderr noise.
    const result = execSync("claude --print 2>/dev/null", {
      input: prompt,
      encoding: "utf-8",
      timeout: 120_000,
    });
    return result.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `VERDICT: FAIL — Claude CLI evaluation failed: ${msg.slice(0, 200)}`;
  }
}
