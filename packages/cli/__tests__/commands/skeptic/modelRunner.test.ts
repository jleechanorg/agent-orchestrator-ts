import { describe, it, expect, vi } from "vitest";
import { runSkepticEvaluation } from "../../../src/commands/skeptic/modelRunner.js";

vi.mock("../../../src/lib/llm-eval.js", () => ({
  llmEval: vi.fn().mockResolvedValue("VERDICT: PASS"),
}));

describe("runSkepticEvaluation", () => {
  it("rejects 'cursor' model with a specific error message", async () => {
    await expect(
      runSkepticEvaluation("test prompt", { model: "cursor" })
    ).rejects.toThrow('Unsupported skeptic model: "cursor". Supported models are: codex, claude, gemini, minimax, agy.');
  });
});
