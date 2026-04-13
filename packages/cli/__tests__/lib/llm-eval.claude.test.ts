import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockResolveCodexBinary = vi.hoisted(() => vi.fn());
const mockAccessSync = vi.hoisted(() => vi.fn());

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

import { llmEval, tryClaudePrint } from "../../src/lib/llm-eval.js";

const PASS_VERDICT = "VERDICT: PASS";
const FAIL_VERDICT = "VERDICT: FAIL";
const SKIPPED_VERDICT = "VERDICT: SKIPPED";
const MOCK_CLAUDE_BINARY = "/mock/claude";

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFileSync.mockReset();
  mockResolveCodexBinary.mockReset();
  // "/mock/claude" is executable
  mockAccessSync.mockImplementation((path) => {
    if (path === MOCK_CLAUDE_BINARY || path === "claude") return undefined;
    const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
  // Default behavior: throw ENOENT
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

describe("tryClaudePrint", () => {
  it("returns validVerdict=true for output containing VERDICT: PASS", async () => {
    mockExecFileSync.mockReturnValue(PASS_VERDICT);
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe(PASS_VERDICT);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/(^|\/)claude$/),
      ["--dangerously-skip-permissions", "--print", "--model", "claude-sonnet-4-6"],
      expect.objectContaining({
        input: "evaluate this",
        cwd: "/tmp",
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
        timeout: 300_000,
      }),
    );
  });

  it("returns validVerdict=false with error string when VERDICT is missing", async () => {
    mockExecFileSync.mockReturnValue("Some analysis without verdict");
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("missing VERDICT line");
    expect(result.error).toBeDefined();
  });

  it("returns error=undefined when binary is not found", async () => {
    const err = makeErrnoError("ENOENT: not found", "ENOENT");
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("returns error=undefined for ETIMEDOUT (unavailable) on first candidate", async () => {
    const err = makeErrnoError("ETIMEDOUT", "ETIMEDOUT");
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    // ETIMEDOUT is "unavailable" — try next binary candidate
    expect(result.error).toBeUndefined();
  });

  it("returns validVerdict=true for markdown-prefixed ## VERDICT: PASS", async () => {
    mockExecFileSync.mockReturnValue("## VERDICT: PASS");
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe("## VERDICT: PASS");
  });

  it("returns validVerdict=false for VERDICT: SKIPPED", async () => {
    mockExecFileSync.mockReturnValue(SKIPPED_VERDICT);
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("missing VERDICT line");
  });

  it("rejects embedded mid-sentence verdicts", async () => {
    mockExecFileSync.mockReturnValue("Analysis complete. VERDICT: PASS");
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("missing VERDICT line");
  });

  it("accepts indented verdict lines", async () => {
    mockExecFileSync.mockReturnValue("\tVERDICT: PASS");
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe("VERDICT: PASS");
  });
});

describe("llmEval — explicit model=claude", () => {
  it("tries claude first when model=claude is specified", async () => {
    mockExecFileSync.mockReturnValue(FAIL_VERDICT);
    const result = await llmEval("evaluate this", { model: "claude" });
    expect(result).toBe(FAIL_VERDICT);
    expect(mockResolveCodexBinary).not.toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("falls back to codex when claude is unavailable", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const enoent = makeErrnoError("ENOENT", "ENOENT");
    // Chain: claude → gemini → cursor → codex (4 models)
    // Mock all 4: 1st claude, 2nd claude, gemini, cursor fail; codex succeeds
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw enoent; // 1st claude candidate fails
      })
      .mockImplementationOnce(() => {
        throw enoent; // 2nd claude candidate fails
      })
      .mockImplementationOnce(() => {
        throw enoent; // gemini fails
      })
      .mockImplementationOnce(() => {
        throw enoent; // cursor fails
      })
      .mockReturnValueOnce(PASS_VERDICT); // codex succeeds (5th call)
    const result = await llmEval("evaluate this", { model: "claude" });
    expect(result).toBe(PASS_VERDICT);
    expect(mockResolveCodexBinary).toHaveBeenCalled();
    // 2 claude + gemini + cursor + codex
    expect(mockExecFileSync).toHaveBeenCalledTimes(5);
  });

  it("returns FAIL and tries codex fallback when claude has infra error", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const etimeout = makeErrnoError("ETIMEDOUT", "ETIMEDOUT");
    const enoent = makeErrnoError("ENOENT", "ENOENT");
    // Chain: claude → gemini → cursor → codex (4 models)
    // Mock all 4: 1st claude ETIMEDOUT, 2nd claude ENOENT, gemini ENOENT, cursor ENOENT; codex not called
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw etimeout; // 1st claude candidate (infra error)
      })
      .mockImplementationOnce(() => {
        throw enoent; // 2nd claude candidate (not installed)
      })
      .mockImplementationOnce(() => {
        throw enoent; // gemini (not installed)
      })
      .mockImplementationOnce(() => {
        throw enoent; // cursor (not installed)
      })
      .mockImplementationOnce(() => {
        throw enoent; // codex (not installed)
      });
    const result = await llmEval("evaluate this", { model: "claude" });
    expect(result).toContain("VERDICT: FAIL");
    expect(result).toContain("All LLM tools exhausted");
    expect(mockResolveCodexBinary).toHaveBeenCalled();
    // 1 ETIMEDOUT + 3 ENOENT = 4 calls (all become "unavailable")
    expect(mockExecFileSync).toHaveBeenCalledTimes(4);
  });
});
