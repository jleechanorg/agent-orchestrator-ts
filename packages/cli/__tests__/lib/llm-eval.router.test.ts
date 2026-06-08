import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockResolveCodexBinary = vi.hoisted(() => vi.fn());
const mockAccessSync = vi.hoisted(() => vi.fn());

// Set CLAUDE_BINARY before module load so CLAUDE_BINARY_CANDIDATES[0] = "/mock/claude"
// This makes resolveClaudeBinary() return "/mock/claude" without calling `which`,
// preventing extra execFileSync calls that would consume mock slots unexpectedly.
vi.hoisted(() => {
  process.env["CLAUDE_BINARY"] = "/mock/claude";
  process.env["GEMINI_BINARY"] = "/mock/gemini";
});

vi.mock("node:child_process", async () => {
  const original = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...original,
    execFileSync: mockExecFileSync,
  };
});

vi.mock("node:fs", async () => {
  const original = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...original,
    accessSync: mockAccessSync,
    constants: { ...original.constants, X_OK: 1 },
  };
});

vi.mock("@jleechanorg/ao-plugin-agent-codex", () => ({
  resolveCodexBinary: mockResolveCodexBinary,
}));

import { llmEval } from "../../src/lib/llm-eval.js";

const PASS_VERDICT = "VERDICT: PASS";
const FAIL_VERDICT = "VERDICT: FAIL";
let originalApiKeyGlobal: string | undefined;
let originalModelGlobal: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFileSync.mockReset();
  mockResolveCodexBinary.mockReset();
  // Default: throw ENOENT for all calls (test overrides per-case as needed)
  mockExecFileSync.mockImplementation(() => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
  // accessSync: throw ENOENT for ALL candidates.
  // This makes tryClaudePrint skip every candidate, so rotation advances
  // to the next tool (not to a 2nd claude candidate).
  mockAccessSync.mockImplementation((_path) => {
    const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });

  // Isolate tests from host GEMINI_API_KEY
  originalApiKeyGlobal = process.env["GEMINI_API_KEY"];
  originalModelGlobal = process.env["GEMINI_MODEL"];
  delete process.env["GEMINI_API_KEY"];
  delete process.env["GEMINI_MODEL"];
});

afterEach(() => {
  if (originalApiKeyGlobal !== undefined) {
    process.env["GEMINI_API_KEY"] = originalApiKeyGlobal;
  } else {
    delete process.env["GEMINI_API_KEY"];
  }
  if (originalModelGlobal !== undefined) {
    process.env["GEMINI_MODEL"] = originalModelGlobal;
  } else {
    delete process.env["GEMINI_MODEL"];
  }
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
    // Chain: codex → claude → gemini. Headless-broken tools stay out of the runtime
    // fallback path so they cannot mask the real codex/claude failure.
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw etimeout; // codex → isUnavailable=true → error=undefined, continue
      })
      .mockImplementationOnce(() => {
        throw enoent; // 1st claude candidate → isUnavailable=true → error=undefined, continue
      })
      .mockImplementationOnce(() => {
        throw enoent; // 2nd claude candidate → isUnavailable=true → error=undefined, continue
      })
      .mockImplementationOnce(() => {
        throw enoent; // 3rd claude candidate → isUnavailable=true → error=undefined, continue
      })
      .mockImplementationOnce(() => {
        throw enoent; // 4th claude candidate → isUnavailable=true → error=undefined, continue
      });
    // gemini candidates also return ENOENT (default mockImplementation handles this)
    const result = await llmEval("evaluate this");
    expect(result).toContain("VERDICT: FAIL");
    expect(result).toContain("All LLM tools exhausted");
    expect(result).toContain("Tried: codex → claude → gemini");
    expect(result).not.toContain("cursor");
    expect(mockResolveCodexBinary).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalled();
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

  it("returns FAIL when all models unavailable", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    // Chain: codex → claude (1 codex + 4-5 claude candidates). All return ENOENT.
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw enoent; // codex → isUnavailable=true → continue
      });
    const result = await llmEval("evaluate this");
    expect(result).toContain("VERDICT: FAIL");
    expect(result).toContain("All LLM tools exhausted");
  });
});

describe("llmEval — explicit model=cursor (maps to codex)", () => {
  it("tries codex first when model=cursor is specified (cursor not in supported chain)", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync.mockReturnValue(FAIL_VERDICT);
    const result = await llmEval("evaluate this", { model: "cursor" });
    expect(result).toBe(FAIL_VERDICT);
    expect(mockResolveCodexBinary).toHaveBeenCalled();
    // Only codex is tried (cursor maps to codex in the rotation)
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("falls back to claude when codex is unavailable with model=cursor", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    // Rotation: cursor→codex→claude→gemini; codex unavailable, claude succeeds
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw enoent; // codex unavailable
      })
      .mockReturnValueOnce(PASS_VERDICT); // claude succeeds
    const result = await llmEval("evaluate this", { model: "cursor" });
    expect(result).toBe(PASS_VERDICT);
    expect(mockResolveCodexBinary).toHaveBeenCalled();
  });

  it("exhausted-chain output does not mention cursor", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    // Both codex and claude unavailable → chain exhausted
    mockExecFileSync.mockImplementation(() => {
      throw enoent;
    });
    const result = await llmEval("evaluate this", { model: "cursor" });
    expect(result).toContain("VERDICT: FAIL");
    expect(result).not.toContain("cursor");
  });
});

describe("llmEval model validation", () => {
  it("throws a clear error when options.model array contains an unknown model", async () => {
    await expect(
      llmEval("test prompt", { model: ["codex", "invalid-model"] })
    ).rejects.toThrow('Invalid model in options.model: "invalid-model".');
  });

  it("throws a clear error when options.model is an empty array", async () => {
    await expect(
      llmEval("test prompt", { model: [] })
    ).rejects.toThrow("Invalid model: empty array; expected one or more ChainModel values.");
  });

  it("throws a clear error when options.model is an unknown single model string", async () => {
    await expect(
      llmEval("test prompt", { model: "invalid-model" } as unknown as Parameters<typeof llmEval>[1])
    ).rejects.toThrow('Invalid model: "invalid-model". Expected a ChainModel value from DEFAULT_CHAIN.');
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
    const etimeout = new Error("ETIMEDOUT") as NodeJS.ErrnoException;
    etimeout.code = "ETIMEDOUT";
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
