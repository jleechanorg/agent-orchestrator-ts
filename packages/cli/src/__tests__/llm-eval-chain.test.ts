/**
 * Tests for llmEval chain semantics — fall-through on missing VERDICT and
 * consecutive-result dedup. Complements the existing tryClaudePrint tests
 * in llm-eval.test.ts.
 *
 * RED phase (before this PR): missing VERDICT hard-fails the chain;
 *   consecutive identical errors burn through all 5 models wasting latency.
 *
 * GREEN phase: missing VERDICT falls through to next model;
 *   2 consecutive identical result signatures stop the chain early.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock each adapter so we can deterministically script per-model behavior.
const codexMock = vi.hoisted(() => vi.fn());
const claudeMock = vi.hoisted(() => vi.fn());
const geminiMock = vi.hoisted(() => vi.fn());
const minimaxMock = vi.hoisted(() => vi.fn());
const agyMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/llm-eval-codex.js", () => ({
  tryCodexPrint: codexMock,
}));
vi.mock("../lib/llm-eval-claude.js", () => ({
  tryClaudePrint: claudeMock,
}));
vi.mock("../lib/llm-eval-gemini.js", () => ({
  tryGeminiPrint: geminiMock,
}));
vi.mock("../lib/llm-eval-minimax.js", () => ({
  tryMinimaxPrint: minimaxMock,
}));
vi.mock("../lib/llm-eval-agy.js", () => ({
  tryAgyPrint: agyMock,
}));

import { llmEval } from "../lib/llm-eval.js";

const PASS = (msg = "VERDICT: PASS") => ({ validVerdict: true, output: msg });
const ERROR = (msg: string) => ({ validVerdict: false, output: "", error: msg });
const UNAVAIL = () => ({ validVerdict: false, output: "", error: undefined });
const MISSING_VERDICT = (model: string) =>
  ERROR(`missing VERDICT line in ${model} output`);

beforeEach(() => {
  codexMock.mockReset();
  claudeMock.mockReset();
  geminiMock.mockReset();
  minimaxMock.mockReset();
  agyMock.mockReset();
});

describe("llmEval — fall-through on missing VERDICT (was hard-fail)", () => {
  it("continues to next model when codex runs but produces no VERDICT line", async () => {
    codexMock.mockResolvedValueOnce(MISSING_VERDICT("codex"));
    claudeMock.mockResolvedValueOnce(PASS());

    const result = await llmEval("test prompt");

    // Should NOT be the old hard-fail format
    expect(result).not.toMatch(/^VERDICT: FAIL — codex:/);
    // Should be the PASS from claude
    expect(result).toContain("VERDICT: PASS");
    expect(codexMock).toHaveBeenCalledTimes(1);
    expect(claudeMock).toHaveBeenCalledTimes(1);
    // Gemini/minimax/agy should not be called — chain succeeded on claude
    expect(geminiMock).not.toHaveBeenCalled();
    expect(minimaxMock).not.toHaveBeenCalled();
    expect(agyMock).not.toHaveBeenCalled();
  });

  it("continues past multiple missing-VERDICT models until one yields verdict", async () => {
    codexMock.mockResolvedValueOnce(MISSING_VERDICT("codex"));
    claudeMock.mockResolvedValueOnce(MISSING_VERDICT("claude"));
    geminiMock.mockResolvedValueOnce(PASS());

    const result = await llmEval("test prompt");

    expect(result).toContain("VERDICT: PASS");
    expect(codexMock).toHaveBeenCalledTimes(1);
    expect(claudeMock).toHaveBeenCalledTimes(1);
    expect(geminiMock).toHaveBeenCalledTimes(1);
  });
});

describe("llmEval — consecutive-result dedup", () => {
  it("stops early when 3 consecutive models return the same error string", async () => {
    // codex + claude + gemini all return identical 401 errors → assume shared
    // credential expired → stop instead of burning 2 more models.
    codexMock.mockResolvedValueOnce(ERROR("401 Unauthorized"));
    claudeMock.mockResolvedValueOnce(ERROR("401 Unauthorized"));
    geminiMock.mockResolvedValueOnce(ERROR("401 Unauthorized"));
    minimaxMock.mockResolvedValueOnce(PASS()); // should NEVER be called

    const result = await llmEval("test prompt");

    expect(result).toMatch(/^VERDICT: FAIL — infra:/);
    expect(result).toContain("3 consecutive models");
    expect(result).toContain("401 Unauthorized");
    // Critical: minimax + agy must NOT be tried — early stop worked
    expect(minimaxMock).not.toHaveBeenCalled();
    expect(agyMock).not.toHaveBeenCalled();
  });

  it("does NOT stop early when only 2 consecutive models return the same error", async () => {
    // 2 same errors is below threshold (3) — chain should keep going.
    codexMock.mockResolvedValueOnce(ERROR("401 Unauthorized"));
    claudeMock.mockResolvedValueOnce(ERROR("401 Unauthorized"));
    geminiMock.mockResolvedValueOnce(PASS());

    const result = await llmEval("test prompt");

    expect(result).toContain("VERDICT: PASS");
    expect(codexMock).toHaveBeenCalledTimes(1);
    expect(claudeMock).toHaveBeenCalledTimes(1);
    expect(geminiMock).toHaveBeenCalledTimes(1);
  });

  it("stops early when 3 consecutive models all produce missing VERDICT", async () => {
    // All 3 return missing VERDICT (with different model names in msg) —
    // normalized to same "missing_verdict" signature → systemic prompt issue.
    codexMock.mockResolvedValueOnce(MISSING_VERDICT("codex"));
    claudeMock.mockResolvedValueOnce(MISSING_VERDICT("claude"));
    geminiMock.mockResolvedValueOnce(MISSING_VERDICT("gemini"));
    minimaxMock.mockResolvedValueOnce(PASS()); // should NEVER be called

    const result = await llmEval("test prompt");

    expect(result).toMatch(/^VERDICT: FAIL — infra:/);
    expect(result).toContain("3 consecutive models");
    expect(result).toContain("missing_verdict");
    expect(minimaxMock).not.toHaveBeenCalled();
    expect(agyMock).not.toHaveBeenCalled();
  });

  it("does NOT stop early when only 2 consecutive models produce missing VERDICT", async () => {
    // 2 missing VERDICT models below threshold — third model should be tried.
    codexMock.mockResolvedValueOnce(MISSING_VERDICT("codex"));
    claudeMock.mockResolvedValueOnce(MISSING_VERDICT("claude"));
    geminiMock.mockResolvedValueOnce(PASS());

    const result = await llmEval("test prompt");

    expect(result).toContain("VERDICT: PASS");
    expect(geminiMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT dedup when consecutive models return DIFFERENT errors", async () => {
    // Different errors → not a systemic issue → keep trying
    codexMock.mockResolvedValueOnce(ERROR("401 Unauthorized"));
    claudeMock.mockResolvedValueOnce(ERROR("429 rate limit exceeded"));
    geminiMock.mockResolvedValueOnce(PASS());

    const result = await llmEval("test prompt");

    expect(result).toContain("VERDICT: PASS");
    expect(codexMock).toHaveBeenCalledTimes(1);
    expect(claudeMock).toHaveBeenCalledTimes(1);
    expect(geminiMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT dedup when consecutive models are unavailable (different binaries)", async () => {
    // Two different models both being unavailable (different signatures
    // because signature includes model name) should NOT trigger dedup.
    codexMock.mockResolvedValueOnce(UNAVAIL());
    claudeMock.mockResolvedValueOnce(UNAVAIL());
    geminiMock.mockResolvedValueOnce(PASS());

    const result = await llmEval("test prompt");

    expect(result).toContain("VERDICT: PASS");
    expect(geminiMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT dedup when only 1 model returned a result (need ≥3 to trigger)", async () => {
    // First model errors, second model returns verdict → dedup shouldn't apply
    codexMock.mockResolvedValueOnce(ERROR("401 Unauthorized"));
    claudeMock.mockResolvedValueOnce(PASS());

    const result = await llmEval("test prompt");

    expect(result).toContain("VERDICT: PASS");
    expect(codexMock).toHaveBeenCalledTimes(1);
    expect(claudeMock).toHaveBeenCalledTimes(1);
  });
});

describe("llmEval — fallback chain ordering and exhaustion", () => {
  it("falls through every model type when all error", async () => {
    codexMock.mockResolvedValueOnce(ERROR("codex broke"));
    claudeMock.mockResolvedValueOnce(ERROR("claude broke"));
    geminiMock.mockResolvedValueOnce(ERROR("gemini broke"));
    minimaxMock.mockResolvedValueOnce(ERROR("minimax broke"));
    agyMock.mockResolvedValueOnce(ERROR("agy broke"));

    const result = await llmEval("test prompt");

    expect(result).toMatch(/^VERDICT: FAIL — infra: All LLM tools exhausted/);
    expect(result).toContain("codex → claude → gemini → minimax → agy");
    expect(result).toContain("agy broke");
  });

  it("returns the first validVerdict immediately and skips remaining models", async () => {
    codexMock.mockResolvedValueOnce(PASS("VERDICT: PASS — codex"));

    const result = await llmEval("test prompt");

    expect(result).toContain("VERDICT: PASS — codex");
    expect(codexMock).toHaveBeenCalledTimes(1);
    expect(claudeMock).not.toHaveBeenCalled();
    expect(geminiMock).not.toHaveBeenCalled();
    expect(minimaxMock).not.toHaveBeenCalled();
    expect(agyMock).not.toHaveBeenCalled();
  });

  it("treats explicit model chain as override over default", async () => {
    // User asks to start with minimax → chain becomes minimax → agy → codex → claude → gemini
    minimaxMock.mockResolvedValueOnce(PASS("VERDICT: PASS — minimax"));

    const result = await llmEval("test prompt", { model: "minimax" });

    expect(result).toContain("VERDICT: PASS — minimax");
    expect(minimaxMock).toHaveBeenCalledTimes(1);
    // codex must NOT be called when minimax is the explicit start
    expect(codexMock).not.toHaveBeenCalled();
  });
});
