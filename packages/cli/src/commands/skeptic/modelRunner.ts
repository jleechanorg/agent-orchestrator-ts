/**
 * Model runner — runs the skeptical LLM evaluation.
 * Uses Claude CLI for headless evaluation.
 */

export async function runSkepticEvaluation(prompt: string): Promise<string> {
  try {
    const { execSync } = await import("node:child_process");
    const result = execSync(
      "claude --print --no-input 2>/dev/null",
      {
        input: prompt,
        encoding: "utf-8",
        timeout: 60_000,
      },
    );
    return result.trim();
  } catch {
    return "VERDICT: FAIL — Claude CLI not available or evaluation failed (install claude to enable LLM skeptic)";
  }
}
