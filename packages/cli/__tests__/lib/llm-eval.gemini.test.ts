import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockResolveCodexBinary = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock("@jleechanorg/ao-plugin-agent-codex", () => ({
  resolveCodexBinary: mockResolveCodexBinary,
}));

import { llmEval, tryGeminiPrint } from "../../src/lib/llm-eval.js";

const PASS_VERDICT = "VERDICT: PASS";
const FAIL_VERDICT = "VERDICT: FAIL";

beforeEach(() => {
  vi.clearAllMocks();
});

function makeErrnoError(message: string, code?: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("tryGeminiPrint", () => {
  it("returns validVerdict=true for output containing VERDICT: PASS", async () => {
    mockExecFileSync.mockReturnValue(PASS_VERDICT);
    const result = await tryGeminiPrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe(PASS_VERDICT);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gemini",
      [],
      expect.objectContaining({
        input: "evaluate this",
        cwd: "/tmp",
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      }),
    );
  });

  it("returns validVerdict=false with error string when VERDICT is missing", async () => {
    mockExecFileSync.mockReturnValue("Some analysis without verdict");
    const result = await tryGeminiPrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("missing VERDICT line");
  });

  it("returns error=undefined when binary is not found", async () => {
    const err = makeErrnoError("ENOENT: not found", "ENOENT");
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });
    const result = await tryGeminiPrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("rejects embedded mid-sentence verdicts", async () => {
    mockExecFileSync.mockReturnValue("Processing complete. VERDICT: PASS");
    const result = await tryGeminiPrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("missing VERDICT line");
  });

  it("accepts indented verdict lines", async () => {
    mockExecFileSync.mockReturnValue("  VERDICT: FAIL");
    const result = await tryGeminiPrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe("VERDICT: FAIL");
  });
});

describe("llmEval — explicit model=gemini", () => {
  it("tries gemini first when model=gemini is specified", async () => {
    mockExecFileSync.mockReturnValue(FAIL_VERDICT);
    const result = await llmEval("evaluate this", { model: "gemini" });
    expect(result).toBe(FAIL_VERDICT);
    expect(mockResolveCodexBinary).not.toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("falls back to codex when gemini is unavailable", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const enoent = makeErrnoError("ENOENT", "ENOENT");
    // Chain for model=gemini: gemini → cursor → codex → claude (4 models)
    // Mock all 4 so codex (3rd) can succeed
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw enoent; // gemini unavailable
      })
      .mockImplementationOnce(() => {
        throw enoent; // cursor unavailable
      })
      .mockReturnValueOnce(PASS_VERDICT); // codex succeeds (3rd call)
    const result = await llmEval("evaluate this", { model: "gemini" });
    expect(result).toBe(PASS_VERDICT);
    expect(mockResolveCodexBinary).toHaveBeenCalled();
    // 1 gemini + 1 cursor + 1 codex
    expect(mockExecFileSync).toHaveBeenCalledTimes(3);
  });

  it("falls back to codex when gemini has an infra error", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const etimeout = makeErrnoError("ETIMEDOUT", "ETIMEDOUT");
    const enoent = makeErrnoError("ENOENT", "ENOENT");
    // Chain for model=gemini: gemini → cursor → codex → claude (4 models)
    // Mock all 4: gemini ETIMEDOUT (infra), rest ENOENT (not installed)
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw etimeout; // gemini (infra error)
      })
      .mockImplementationOnce(() => {
        throw enoent; // cursor (not installed)
      })
      .mockReturnValueOnce(PASS_VERDICT); // codex succeeds (3rd call)
    const result = await llmEval("evaluate this", { model: "gemini" });
    expect(result).toBe(PASS_VERDICT);
    expect(mockResolveCodexBinary).toHaveBeenCalled();
    // 1 gemini + 1 cursor + 1 codex
    expect(mockExecFileSync).toHaveBeenCalledTimes(3);
  });

  it("fails closed when gemini omits a verdict", async () => {
    mockExecFileSync.mockReturnValue("Gemini analysis with no verdict");
    const result = await llmEval("evaluate this", { model: "gemini" });
    expect(result).toContain("VERDICT: FAIL");
    expect(result).toContain("gemini:");
    expect(result).toContain("missing VERDICT");
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });
});
