import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockResolveCodexBinary = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock("@jleechanorg/ao-plugin-agent-codex", () => ({
  resolveCodexBinary: mockResolveCodexBinary,
}));

import { llmEval, tryCodexPrint } from "../../src/lib/llm-eval.js";

const PASS_VERDICT = "VERDICT: PASS";
const FAIL_VERDICT = "VERDICT: FAIL";
const SKIPPED_VERDICT = "VERDICT: SKIPPED";

beforeEach(() => {
  vi.clearAllMocks();
});

function makeErrnoError(message: string, code?: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

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
    const err = makeErrnoError("ENOENT: not found", "ENOENT");
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });
    const result = await tryCodexPrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toBeUndefined(); // signal: try next tool
  });

  it("returns validVerdict=false with error message for timeout", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const err = makeErrnoError("ETIMEDOUT", "ETIMEDOUT");
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
    const err = makeErrnoError("Command failed: unauthorized");
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

  it("rejects embedded mid-sentence verdicts", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync.mockReturnValue("Processing complete. VERDICT: PASS");
    const result = await tryCodexPrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("missing VERDICT line");
  });

  it("accepts indented verdict lines", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync.mockReturnValue("  VERDICT: PASS");
    const result = await tryCodexPrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe("VERDICT: PASS");
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
    const etimeout = makeErrnoError("ETIMEDOUT", "ETIMEDOUT");
    const enoent = makeErrnoError("ENOENT", "ENOENT");
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw etimeout;
      })
      .mockImplementationOnce(() => {
        throw enoent;
      });
    const result = await llmEval("evaluate this");
    // Infra failure from codex → try Claude fallback → both fail → FAIL (fail-closed)
    expect(result).toContain("VERDICT: FAIL");
    expect(result).toContain("ETIMEDOUT");
    expect(result).toContain("Claude:");
    expect(mockExecFileSync).toHaveBeenCalledTimes(2); // codex failed, then tried Claude
  });

  it("falls back to claude when codex is unavailable (ENOENT)", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const enoent = makeErrnoError("ENOENT", "ENOENT");
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw enoent;
      })
      .mockReturnValueOnce(PASS_VERDICT); // claude succeeds
    const result = await llmEval("evaluate this");
    expect(result).toBe(PASS_VERDICT);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  it("returns FAIL when both codex unavailable (ENOENT) and claude also fails (ENOENT)", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const enoent1 = makeErrnoError("ENOENT", "ENOENT");
    const enoent2 = makeErrnoError("ENOENT", "ENOENT");
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw enoent1;
      })
      .mockImplementationOnce(() => {
        throw enoent2;
      });
    const result = await llmEval("evaluate this");
    // Both unavailable → FAIL (fail-closed; infra unavailability blocks merge)
    expect(result).toContain("VERDICT: FAIL");
    expect(result).toContain("Neither Codex nor Claude CLI available for skeptic evaluation");
  });

  it("returns FAIL (not SKIPPED) when codex runs but model omits VERDICT", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync.mockReturnValue("Here is my analysis with no verdict");
    const result = await llmEval("evaluate this");
    // Missing VERDICT = code quality failure → fail-closed FAIL
    expect(result).toContain("VERDICT: FAIL");
    expect(result).toContain("missing VERDICT");
    expect(mockExecFileSync).toHaveBeenCalledTimes(2); // codex no-verdict → tried Claude fallback
  });
});
