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

  it("forwards an ordered array of model strings to llmEval", async () => {
    const { llmEval } = await import("../../../src/lib/llm-eval.js");
    const mockLlmEval = vi.mocked(llmEval);
    mockLlmEval.mockClear();

    const prompt = "another test prompt";
    await runSkepticEvaluation(prompt, { model: ["codex", "claude"] });
    expect(mockLlmEval).toHaveBeenCalledWith(prompt, { model: ["codex", "claude"] });
  });

  it("rejects when the array contains an invalid model and does not call llmEval", async () => {
    const { llmEval } = await import("../../../src/lib/llm-eval.js");
    const mockLlmEval = vi.mocked(llmEval);
    mockLlmEval.mockClear();

    await expect(
      runSkepticEvaluation("test prompt", { model: ["codex", "invalidModel"] })
    ).rejects.toThrow('Unsupported skeptic model: "invalidModel". Supported models are: codex, claude, gemini, minimax, agy.');

    expect(mockLlmEval).not.toHaveBeenCalled();
  });

  it("rejects an empty model array and does not call llmEval", async () => {
    const { llmEval } = await import("../../../src/lib/llm-eval.js");
    const mockLlmEval = vi.mocked(llmEval);
    mockLlmEval.mockClear();

    await expect(
      runSkepticEvaluation("test prompt", { model: [] }),
    ).rejects.toThrow();

    expect(mockLlmEval).not.toHaveBeenCalled();
  });
});
