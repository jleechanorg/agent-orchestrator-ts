import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockResolveCodexBinary = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock("@jleechanorg/ao-plugin-agent-codex", () => ({
  resolveCodexBinary: mockResolveCodexBinary,
}));

import { tryCodexPrint, tryClaudePrint, llmEval } from "../../src/lib/llm-eval.js";

const PASS_VERDICT = "VERDICT: PASS";
const FAIL_VERDICT = "VERDICT: FAIL";

beforeEach(() => {
  vi.clearAllMocks();
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
      ["exec", "-"],
      expect.objectContaining({ input: "evaluate this" }),
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

  it("returns validVerdict=false with error message for auth failure", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const err = new Error("Command failed: unauthorized") as NodeJS.ErrnoException;
    err.code = undefined;
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });
    const result = await tryCodexPrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("Command failed: unauthorized");
    expect(result.error).toBeDefined(); // fail closed
  });
});

describe("tryClaudePrint", () => {
  it("returns validVerdict=true for output containing VERDICT: PASS", async () => {
    mockExecFileSync.mockReturnValue(PASS_VERDICT);
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe(PASS_VERDICT);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "claude",
      ["--print", "--no-input"],
      expect.objectContaining({ input: "evaluate this" }),
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

  it("returns SKIPPED when codex fails with real error (infra failure, not code quality failure)", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const err = new Error("ETIMEDOUT") as NodeJS.ErrnoException;
    err.code = "ETIMEDOUT";
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });
    const result = await llmEval("evaluate this");
    // Infrastructure failures return SKIPPED so the cron step continues
    // (FAIL is reserved for code quality failures that should block merge)
    expect(result).toContain("VERDICT: SKIPPED");
    expect(result).toContain("ETIMEDOUT");
    expect(mockExecFileSync).toHaveBeenCalledTimes(1); // no fallback after real error
  });

  it("falls back to claude when codex is unavailable (ENOENT)", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw enoent;
      })
      .mockReturnValueOnce(PASS_VERDICT); // claude succeeds
    const result = await llmEval("evaluate this");
    expect(result).toBe(PASS_VERDICT);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  it("returns SKIPPED when both codex unavailable (ENOENT) and claude also fails (ENOENT)", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const enoent1 = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent1.code = "ENOENT";
    const enoent2 = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent2.code = "ENOENT";
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw enoent1;
      })
      .mockImplementationOnce(() => {
        throw enoent2;
      });
    const result = await llmEval("evaluate this");
    // Both unavailable → SKIPPED so cron continues; only code quality FAIL blocks merge
    expect(result).toContain("VERDICT: SKIPPED");
    expect(result).toContain("Neither Codex nor Claude CLI available");
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
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw enoent; // claude fails
      })
      .mockReturnValueOnce(PASS_VERDICT); // codex succeeds
    const result = await llmEval("evaluate this", { model: "claude" });
    expect(result).toBe(PASS_VERDICT);
    expect(mockResolveCodexBinary).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  it("returns SKIPPED when claude has a real error (infra failure, not code quality failure)", async () => {
    const err = new Error("ETIMEDOUT") as NodeJS.ErrnoException;
    err.code = "ETIMEDOUT";
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });
    const result = await llmEval("evaluate this", { model: "claude" });
    // Infrastructure failures return SKIPPED so the cron step continues
    expect(result).toContain("VERDICT: SKIPPED");
    expect(result).toContain("Claude evaluation failed");
    expect(mockResolveCodexBinary).not.toHaveBeenCalled();
  });
});
