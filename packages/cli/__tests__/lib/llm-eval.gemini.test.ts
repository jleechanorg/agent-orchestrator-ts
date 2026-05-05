import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockResolveCodexBinary = vi.hoisted(() => vi.fn());
const mockAccessSync = vi.hoisted(() => vi.fn());

// Set CLAUDE_BINARY before module load so CLAUDE_BINARY_CANDIDATES[0] = "/mock/claude"
vi.hoisted(() => {
  process.env["CLAUDE_BINARY"] = "/mock/claude";
});

vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock("node:fs", () => ({
  accessSync: mockAccessSync,
  constants: { X_OK: 1 },
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
  mockAccessSync.mockReset();
  mockExecFileSync.mockImplementation(() => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
});

// model=gemini is accepted for CLI compatibility, but gemini is not in the
// supported headless chain (["codex", "claude"]). When model=gemini is specified,
// it maps to codex (preferredHeadless="gemini" → indexOf returns -1 → Math.max(0,-1)=0
// → rotation starts at codex). The unsupported-model rotation still visits every
// supported tool: codex first, then claude fallback.

describe("llmEval — explicit model=gemini (maps to codex)", () => {
  it("tries codex first when model=gemini is specified (gemini not in supported chain)", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync.mockReturnValue(FAIL_VERDICT);
    const result = await llmEval("evaluate this", { model: "gemini" });
    expect(result).toBe(FAIL_VERDICT);
    expect(mockResolveCodexBinary).toHaveBeenCalled();
    // Only codex is tried (gemini maps to codex in the rotation)
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("falls back to claude when codex is unavailable with model=gemini", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    // Rotation: gemini→codex→claude; codex unavailable, claude succeeds
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw enoent; // codex unavailable
      })
      .mockReturnValueOnce(PASS_VERDICT); // claude succeeds
    const result = await llmEval("evaluate this", { model: "gemini" });
    expect(result).toBe(PASS_VERDICT);
    expect(mockResolveCodexBinary).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledTimes(2); // codex + claude
  });

  it("fails closed when codex omits a verdict with model=gemini", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync.mockReturnValueOnce("Gemini analysis with no verdict");
    const result = await llmEval("evaluate this", { model: "gemini" });
    expect(result).toContain("VERDICT: FAIL");
    expect(result).toContain("codex:");
    expect(result).toContain("missing VERDICT");
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });
});
