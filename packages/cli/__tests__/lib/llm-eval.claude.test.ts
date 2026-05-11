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

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFileSync.mockReset();
  mockResolveCodexBinary.mockReset();
  // accessSync: throw ENOENT for all candidates (binary not found).
  // This makes tryClaudePrint skip every candidate without succeeding,
  // so the rotation advances to the next tool (not a 2nd claude candidate).
  mockAccessSync.mockImplementation((_path: unknown) => {
    const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
  // Default: throw ENOENT for ALL execFileSync calls.
  // Each test queues specific return values for the calls it cares about.
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
  // Override accessSync to allow /mock/claude (first candidate) through.
  // Without this, accessSync throws ENOENT and tryClaudePrint skips all candidates.
  const allowFirstCandidate = () => {
    mockAccessSync.mockImplementation((path: unknown) => {
      if (path === "/mock/claude" || path === "claude") return undefined;
      const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
  };

  it("returns validVerdict=true for output containing VERDICT: PASS", async () => {
    allowFirstCandidate();
    mockExecFileSync.mockReturnValue(PASS_VERDICT);
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe(PASS_VERDICT);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/(^|\/)claude$/),
      ["--dangerously-skip-permissions", "--print"],
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
    allowFirstCandidate();
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
    allowFirstCandidate();
    mockExecFileSync.mockReturnValue("## VERDICT: PASS");
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe("## VERDICT: PASS");
  });

  it("returns validVerdict=false for VERDICT: SKIPPED", async () => {
    allowFirstCandidate();
    mockExecFileSync.mockReturnValue(SKIPPED_VERDICT);
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("missing VERDICT line");
  });

  it("rejects embedded mid-sentence verdicts", async () => {
    allowFirstCandidate();
    mockExecFileSync.mockReturnValue("Analysis complete. VERDICT: PASS");
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("missing VERDICT line");
  });

  it("accepts indented verdict lines", async () => {
    allowFirstCandidate();
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
    // Rotation: ["claude","gemini","codex"]
    // claude→all accessSync ENOENT, gemini→ENOENT from execFileSync (including bare "gemini"),
    // codex→resolveCodexBinary resolves, execFileSync returns PASS
    mockExecFileSync
      .mockImplementationOnce(() => { throw enoent; }) // gemini bare-name candidate
      .mockReturnValueOnce(PASS_VERDICT); // codex succeeds
    const result = await llmEval("evaluate this", { model: "claude" });
    expect(result).toBe(PASS_VERDICT);
  });

  it("returns FAIL and tries codex fallback when claude has infra error", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const etimeout = makeErrnoError("ETIMEDOUT", "ETIMEDOUT");
    // Call 1: claude → ETIMEDOUT (infra error); then gemini and codex tried (both unavailable via default ENOENT)
    // Chain exhausted → FAIL
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw etimeout; // claude (infra error)
      });
    const result = await llmEval("evaluate this", { model: "claude" });
    expect(result).toContain("VERDICT: FAIL");
    expect(result).toContain("All LLM tools exhausted");
    expect(mockResolveCodexBinary).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalled(); // claude + gemini candidates + codex
  });
});
