import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockResolveCodexBinary = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock("@jleechanorg/ao-plugin-agent-codex", () => ({
  resolveCodexBinary: mockResolveCodexBinary,
}));

import { llmEval, tryClaudePrint } from "../../src/lib/llm-eval.js";

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

  it("returns validVerdict=false for other execFileSync errors", async () => {
    const err = makeErrnoError("ETIMEDOUT", "ETIMEDOUT");
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("ETIMEDOUT");
    expect(result.error).toBeDefined();
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
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw enoent;
      })
      .mockReturnValueOnce(PASS_VERDICT);
    const result = await llmEval("evaluate this", { model: "claude" });
    expect(result).toBe(PASS_VERDICT);
    expect(mockResolveCodexBinary).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  it("returns FAIL and tries codex fallback when claude has infra error", async () => {
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
    const result = await llmEval("evaluate this", { model: "claude" });
    expect(result).toContain("VERDICT: FAIL");
    expect(result).toContain("Claude failed:");
    expect(mockResolveCodexBinary).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });
});
