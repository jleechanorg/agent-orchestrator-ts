import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockResolveCodexBinary = vi.hoisted(() => vi.fn());
const mockAccessSync = vi.hoisted(() => vi.fn());

// Set CLAUDE_BINARY before module load so CLAUDE_BINARY_CANDIDATES[0] = "/mock/claude"
// This makes resolveClaudeBinary() return "/mock/claude" without calling `which`,
// preventing extra execFileSync calls that would consume mock slots unexpectedly.
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

import { tryCodexPrint, tryClaudePrint, llmEval } from "../../src/lib/llm-eval.js";

const PASS_VERDICT = "VERDICT: PASS";
const FAIL_VERDICT = "VERDICT: FAIL";
const SKIPPED_VERDICT = "VERDICT: SKIPPED";
const MOCK_CLAUDE_BINARY = "/mock/claude";
const MOCK_CLAUDE_MODEL = "claude-sonnet-4-6";

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFileSync.mockReset();
  mockResolveCodexBinary.mockReset();
  // "/mock/claude" is executable — accessSync doesn't throw
  mockAccessSync.mockImplementation((path) => {
    if (path === MOCK_CLAUDE_BINARY || path === "claude") return undefined;
    const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
  // Default: throw ENOENT for unexpected calls to avoid accidentally returning a previous test's value
  mockExecFileSync.mockImplementation(() => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
});

describe("tryCodexPrint", () => {
  it("returns validVerdict=true for output containing VERDICT: PASS", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync.mockReturnValue(PASS_VERDICT);
    const result = await tryCodexPrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe(PASS_VERDICT);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/usr/local/bin/codex",
      ["exec", "--model", "gpt-5.4", "-"],
      expect.objectContaining({ input: "evaluate this" }),
    );
  });

  it("uses the explicit gpt-5.4 codex model by default", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync.mockReturnValue(PASS_VERDICT);
    await tryCodexPrint("evaluate this");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/usr/local/bin/codex",
      ["exec", "--model", "gpt-5.4", "-"],
      expect.any(Object),
    );
  });

  it("returns validVerdict=true for output containing VERDICT: FAIL", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync.mockReturnValue(FAIL_VERDICT);
    const result = await tryCodexPrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe(FAIL_VERDICT);
  });

  it("returns validVerdict=false with error string when VERDICT is missing", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync.mockReturnValue("Here is my analysis...");
    const result = await tryCodexPrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("missing VERDICT line");
    expect(result.error).toBeDefined();
  });

  it("returns error=undefined (try next) when binary is not found (ENOENT)", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const err = new Error("ENOENT: not found") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });
    const result = await tryCodexPrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toBeUndefined(); // signal: try next tool
  });

  it("returns validVerdict=false with error message for timeout", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const err = new Error("ETIMEDOUT") as NodeJS.ErrnoException;
    err.code = "ETIMEDOUT";
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });
    const result = await tryCodexPrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("ETIMEDOUT");
    expect(result.error).toBeDefined(); // NOT undefined → fail closed
  });

  it("returns error=undefined (try next) when binary exits with auth/unavailable error", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    // "unauthorized" is classified as unavailable → fallback chain continues
    const err = new Error("Command failed: unauthorized") as NodeJS.ErrnoException;
    err.code = undefined;
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });
    const result = await tryCodexPrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toBeUndefined(); // signal: try next tool
  });

  it("returns validVerdict=true for markdown-prefixed ## VERDICT: PASS", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync.mockReturnValue("## VERDICT: PASS");
    const result = await tryCodexPrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe("## VERDICT: PASS");
  });

  it("returns validVerdict=true for markdown-prefixed **VERDICT: FAIL**", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync.mockReturnValue("**VERDICT: FAIL**");
    const result = await tryCodexPrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe("**VERDICT: FAIL**");
  });

  it("returns validVerdict=true for single-# prefixed # VERDICT: PASS", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync.mockReturnValue("# VERDICT: PASS");
    const result = await tryCodexPrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe("# VERDICT: PASS");
  });

  it("returns validVerdict=false for VERDICT: SKIPPED (not a valid merge-gate verdict)", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync.mockReturnValue(SKIPPED_VERDICT);
    const result = await tryCodexPrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("missing VERDICT line");
  });

  it("returns validVerdict=false for markdown-prefixed ## VERDICT: SKIPPED", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync.mockReturnValue("## VERDICT: SKIPPED");
    const result = await tryCodexPrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("missing VERDICT line");
  });
});

describe("tryClaudePrint", () => {
  it("returns validVerdict=true for output containing VERDICT: PASS", async () => {
    mockExecFileSync.mockReturnValue(PASS_VERDICT);
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe(PASS_VERDICT);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      MOCK_CLAUDE_BINARY,
      ["--dangerously-skip-permissions", "--print", "--model", MOCK_CLAUDE_MODEL],
      expect.objectContaining({
        input: "evaluate this",
        cwd: "/tmp",
        encoding: "utf-8",
        timeout: 300000,
        stdio: ["pipe", "pipe", "ignore"],
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
    const err = new Error("ENOENT: not found") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("returns validVerdict=false for other execFileSync errors", async () => {
    const err = new Error("ETIMEDOUT") as NodeJS.ErrnoException;
    err.code = "ETIMEDOUT";
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("ETIMEDOUT");
    expect(result.error).toBeDefined();
  });

  it("treats EACCES from accessSync as infra error (not missing binary)", async () => {
    // Simulate: binary exists but is not executable (EACCES)
    mockAccessSync.mockImplementation((path) => {
      if (path === MOCK_CLAUDE_BINARY) {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      // All other candidates: ENOENT (not installed)
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    // EACCES should produce an infrastructure error message, not undefined
    expect(result.error).toBeDefined();
    expect(result.error).toContain("EACCES");
  });

  it("returns validVerdict=true for markdown-prefixed ## VERDICT: PASS (claude)", async () => {
    mockExecFileSync.mockReturnValue("## VERDICT: PASS");
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe("## VERDICT: PASS");
  });

  it("returns validVerdict=false for VERDICT: SKIPPED (not a valid merge-gate verdict)", async () => {
    mockExecFileSync.mockReturnValue(SKIPPED_VERDICT);
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("missing VERDICT line");
  });
});

describe("llmEval — default (codex primary)", () => {
  it("returns codex output when codex returns valid VERDICT", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync.mockReturnValue(PASS_VERDICT);
    const result = await llmEval("evaluate this");
    expect(result).toBe(PASS_VERDICT);
    expect(mockResolveCodexBinary).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("returns FAIL and tries Claude fallback when codex fails with infra error", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const etimeout = new Error("ETIMEDOUT") as NodeJS.ErrnoException;
    etimeout.code = "ETIMEDOUT";
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw etimeout; // codex
      })
      .mockImplementationOnce(() => {
        throw enoent; // 1st claude candidate (/mock/claude)
      })
      .mockImplementationOnce(() => {
        throw enoent; // last claude candidate (claude)
      })
      .mockImplementationOnce(() => {
        throw enoent; // gemini
      })
      .mockImplementationOnce(() => {
        throw enoent; // cursor
      });
    const result = await llmEval("evaluate this");
    // Infra failure from codex → try Claude fallback → all 4 fail → FAIL (fail-closed)
    expect(result).toContain("VERDICT: FAIL");
    expect(result).toContain("All LLM tools exhausted");
    // 1 codex + 2 claude + 1 gemini + 1 cursor
    expect(mockExecFileSync).toHaveBeenCalledTimes(5);
  });

  it("falls back to claude when codex is unavailable (ENOENT)", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw enoent; // codex unavailable
      })
      .mockReturnValueOnce(PASS_VERDICT); // 1st claude candidate succeeds
    const result = await llmEval("evaluate this");
    expect(result).toBe(PASS_VERDICT);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  it("returns FAIL when all 4 models are unavailable", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw enoent; // codex
      })
      .mockImplementationOnce(() => {
        throw enoent; // 1st claude candidate
      })
      .mockImplementationOnce(() => {
        throw enoent; // last claude candidate
      })
      .mockImplementationOnce(() => {
        throw enoent; // gemini
      })
      .mockImplementationOnce(() => {
        throw enoent; // cursor
      });
    const result = await llmEval("evaluate this");
    // All unavailable → FAIL (fail-closed; infra unavailability blocks merge)
    expect(result).toContain("VERDICT: FAIL");
    expect(result).toContain("All LLM tools exhausted");
    // 1 codex + 2 claude + 1 gemini + 1 cursor
    expect(mockExecFileSync).toHaveBeenCalledTimes(5);
  });

  it("returns FAIL (not SKIPPED) when codex runs but model omits VERDICT", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync
      .mockReturnValueOnce("Here is my analysis with no verdict") // codex runs but omits verdict
      .mockImplementationOnce(() => {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }); // 1st claude candidate unavailable
    const result = await llmEval("evaluate this");
    // Missing VERDICT = code quality failure → fail-closed FAIL
    expect(result).toContain("VERDICT: FAIL");
    expect(result).toContain("missing VERDICT");
    // Try codex, then try claude fallback (at least one candidate)
    expect(mockExecFileSync).toHaveBeenCalled();
  });
});

describe("llmEval — explicit model=claude", () => {
  it("tries claude first when model=claude is specified", async () => {
    mockExecFileSync.mockReturnValue(FAIL_VERDICT); // 1st claude candidate returns FAIL
    const result = await llmEval("evaluate this", { model: "claude" });
    expect(result).toBe(FAIL_VERDICT);
    expect(mockResolveCodexBinary).not.toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("falls back to codex when claude is unavailable", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw enoent; // 1st claude candidate fails
      })
      .mockImplementationOnce(() => {
        throw enoent; // last claude candidate fails
      })
      .mockImplementationOnce(() => {
        throw enoent; // gemini unavailable
      })
      .mockImplementationOnce(() => {
        throw enoent; // cursor unavailable
      })
      .mockReturnValueOnce(PASS_VERDICT); // codex succeeds
    const result = await llmEval("evaluate this", { model: "claude" });
    expect(result).toBe(PASS_VERDICT);
    expect(mockResolveCodexBinary).toHaveBeenCalled();
    // 2 claude + 1 gemini + 1 cursor + 1 codex
    expect(mockExecFileSync).toHaveBeenCalledTimes(5);
  });

  it("returns FAIL and tries codex fallback when claude has infra error", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const etimeout = new Error("ETIMEDOUT") as NodeJS.ErrnoException;
    etimeout.code = "ETIMEDOUT";
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw etimeout; // 1st claude candidate fails
      })
      .mockImplementationOnce(() => {
        throw enoent; // last claude candidate fails
      })
      .mockImplementationOnce(() => {
        throw enoent; // gemini fails
      })
      .mockImplementationOnce(() => {
        throw enoent; // cursor fails
      })
      .mockImplementationOnce(() => {
        throw enoent; // codex also fails
      });
    const result = await llmEval("evaluate this", { model: "claude" });
    // Infra failure from Claude → try all fallbacks → all fail → FAIL (fail-closed)
    expect(result).toContain("VERDICT: FAIL");
    expect(result).toContain("All LLM tools exhausted");
    expect(mockResolveCodexBinary).toHaveBeenCalled();
    // 2 claude + 1 gemini + 1 cursor + 1 codex
    expect(mockExecFileSync).toHaveBeenCalledTimes(5);
  });
});
