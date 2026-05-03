import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockResolveCodexBinary = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock("@jleechanorg/ao-plugin-agent-codex", () => ({
  resolveCodexBinary: mockResolveCodexBinary,
}));

import { llmEval } from "../../src/lib/llm-eval.js";

const PASS_VERDICT = "VERDICT: PASS";
const FAIL_VERDICT = "VERDICT: FAIL";

beforeEach(() => {
  mockExecFileSync.mockReset();
  mockResolveCodexBinary.mockReset();
  mockExecFileSync.mockImplementation(() => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
});

function makeErrnoError(message: string, code?: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

// tryGeminiPrint() now returns immediate infra error (no execFileSync call).
// Rotation: ["gemini","cursor","codex","claude"] — only codex calls execFileSync.
// Gemini and cursor return infra errors immediately without consuming queue slots.

describe("llmEval — explicit model=gemini", () => {
  it("tries gemini first when model=gemini is specified", async () => {
    // Rotation: ["gemini","cursor","codex","claude"]
    // gemini+cursor return infra errors (no execFileSync); codex calls execFileSync → FAIL_VERDICT
    mockExecFileSync.mockReturnValue(FAIL_VERDICT);
    const result = await llmEval("evaluate this", { model: "gemini" });
    expect(result).toBe(FAIL_VERDICT);
    expect(mockResolveCodexBinary).toHaveBeenCalled(); // codex is tried after gemini/cursor skip
    expect(mockExecFileSync).toHaveBeenCalledTimes(1); // only codex calls execFileSync
  });

  it("falls back to codex when gemini is unavailable", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    // Rotation: ["gemini","cursor","codex","claude"]
    // gemini+cursor return infra errors (no execFileSync); codex calls execFileSync → PASS
    mockExecFileSync.mockReturnValueOnce(PASS_VERDICT);
    const result = await llmEval("evaluate this", { model: "gemini" });
    expect(result).toBe(PASS_VERDICT);
    expect(mockResolveCodexBinary).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1); // only codex calls execFileSync
  });

  it("falls back to codex when gemini has an infra error", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    // Rotation: ["gemini","cursor","codex","claude"]
    // gemini+cursor return infra errors (no execFileSync); codex calls execFileSync → PASS
    mockExecFileSync.mockReturnValueOnce(PASS_VERDICT);
    const result = await llmEval("evaluate this", { model: "gemini" });
    expect(result).toBe(PASS_VERDICT);
    expect(mockResolveCodexBinary).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1); // only codex calls execFileSync
  });

  it("fails closed when gemini omits a verdict", async () => {
    // Rotation: ["gemini","cursor","codex","claude"]
    // gemini+cursor return infra errors (no execFileSync); codex gets non-VERDICT → fail-closed
    mockExecFileSync.mockReturnValueOnce("Gemini analysis with no verdict");
    const result = await llmEval("evaluate this", { model: "gemini" });
    expect(result).toContain("VERDICT: FAIL");
    expect(result).toContain("codex:"); // codex consumed the non-VERDICT output
    expect(result).toContain("missing VERDICT");
    expect(mockExecFileSync).toHaveBeenCalledTimes(1); // only codex calls execFileSync
  });
});
