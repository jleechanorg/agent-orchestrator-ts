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

import { tryCodexPrint, tryClaudePrint, tryGeminiPrint, tryAgyPrint, llmEval } from "../../src/lib/llm-eval.js";

const PASS_VERDICT = "VERDICT: PASS";
const FAIL_VERDICT = "VERDICT: FAIL";
const SKIPPED_VERDICT = "VERDICT: SKIPPED";
const MOCK_CLAUDE_BINARY = "/mock/claude";
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

describe("tryCodexPrint", () => {
  it("returns validVerdict=true for output containing VERDICT: PASS", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync.mockReturnValue(PASS_VERDICT);
    const result = await tryCodexPrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe(PASS_VERDICT);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/usr/local/bin/codex",
      ["exec", "--model", "gpt-5.5", "-c", "check_for_update_on_startup=false", "-"],
      expect.objectContaining({ input: "evaluate this" }),
    );
  });

  it("uses the explicit gpt-5.4 codex model by default", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync.mockReturnValue(PASS_VERDICT);
    await tryCodexPrint("evaluate this");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/usr/local/bin/codex",
      ["exec", "--model", "gpt-5.5", "-c", "check_for_update_on_startup=false", "-"],
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

  it("returns error=undefined (try next) for ETIMEDOUT (network timeout = unavailable)", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const err = new Error("ETIMEDOUT") as NodeJS.ErrnoException;
    err.code = "ETIMEDOUT";
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });
    const result = await tryCodexPrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    // ETIMEDOUT matches isUnavailable → infra error, not missing binary → try next tool
    expect(result.error).toBeUndefined();
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

  it("preserves existing ANTHROPIC_API_KEY/BASE_URL when MINIMAX_API_KEY is unset", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync.mockReturnValue(PASS_VERDICT);
    // MINIMAX_API_KEY unset → minimaxEnv() returns {} → child inherits parent env
    delete process.env["MINIMAX_API_KEY"];
    delete process.env["MINIMAX_ANTHROPIC_BASE_URL"];
    process.env["ANTHROPIC_API_KEY"] = "anthropic-existing";
    process.env["ANTHROPIC_BASE_URL"] = "https://api.anthropic.com";
    await tryCodexPrint("evaluate this");
    const calls = mockExecFileSync.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const envArg = calls[0][2]?.env as Record<string, string>;
    expect(envArg["ANTHROPIC_API_KEY"]).toBe("anthropic-existing");
    expect(envArg["ANTHROPIC_BASE_URL"]).toBe("https://api.anthropic.com");
    expect("MINIMAX_API_KEY" in envArg).toBe(false);
  });

  it("overrides ANTHROPIC_API_KEY and BASE_URL when MINIMAX_API_KEY is set", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync.mockReturnValue(PASS_VERDICT);
    process.env["MINIMAX_API_KEY"] = "minimax-key";
    process.env["MINIMAX_ANTHROPIC_BASE_URL"] = "https://api.minimax.io/anthropic";
    process.env["ANTHROPIC_API_KEY"] = "anthropic-existing";
    await tryCodexPrint("evaluate this");
    const calls = mockExecFileSync.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const envArg = calls[0][2]?.env as Record<string, string>;
    expect(envArg["ANTHROPIC_API_KEY"]).toBe("minimax-key");
    expect(envArg["ANTHROPIC_BASE_URL"]).toBe("https://api.minimax.io/anthropic");
    delete process.env["MINIMAX_API_KEY"];
    delete process.env["MINIMAX_ANTHROPIC_BASE_URL"];
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
  // Override accessSync to allow /mock/claude (first candidate) through.
  const allowFirstCandidate = () => {
    mockAccessSync.mockImplementation((path) => {
      if (path === MOCK_CLAUDE_BINARY || path === "claude") return undefined;
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
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
      MOCK_CLAUDE_BINARY,
      ["--bare", "--dangerously-skip-permissions", "--print"],
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
    allowFirstCandidate();
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

  it("returns error=undefined for ETIMEDOUT (unavailable) on first candidate", async () => {
    const err = new Error("ETIMEDOUT") as NodeJS.ErrnoException;
    err.code = "ETIMEDOUT";
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    // ETIMEDOUT is "unavailable" — try next binary candidate
    expect(result.error).toBeUndefined();
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
    allowFirstCandidate();
    mockExecFileSync.mockReturnValue("## VERDICT: PASS");
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe("## VERDICT: PASS");
  });

  it("returns validVerdict=false for VERDICT: SKIPPED (not a valid merge-gate verdict)", async () => {
    allowFirstCandidate();
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
      })
      .mockImplementationOnce(() => {
        throw enoent; // 1st claude candidate → isUnavailable=true → continue
      })
      .mockImplementationOnce(() => {
        throw enoent; // 2nd claude candidate → isUnavailable=true → continue
      })
      .mockImplementationOnce(() => {
        throw enoent; // 3rd claude candidate → isUnavailable=true → continue
      })
      .mockImplementationOnce(() => {
        throw enoent; // 4th claude candidate → isUnavailable=true → continue
      });
    const result = await llmEval("evaluate this");
    // All unavailable → FAIL (fail-closed; infra unavailability blocks merge)
    expect(result).toContain("VERDICT: FAIL");
    expect(result).toContain("All LLM tools exhausted");
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
    // Rotation: ["claude","gemini","codex"] (gemini/cursor in supported chain)
    // Call1→claude(ENOENT→try next), gemini candidates(ENOENT→try next), CallN→codex(PASS)
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw enoent; // claude unavailable
      })
      .mockReturnValueOnce(PASS_VERDICT); // codex succeeds (or gemini if first available)
    const result = await llmEval("evaluate this", { model: "claude" });
    expect(result).toBe(PASS_VERDICT);
  });

  it("returns FAIL when claude and codex are both unavailable", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    // Rotation: ["claude","gemini","codex"] (all return ENOENT/unavailable)
    // Call1→claude(ENOENT→try next), then gemini candidates(ENOENT), then codex(ENOENT), chain exhausted → FAIL
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw enoent; // claude unavailable
      });
    const result = await llmEval("evaluate this", { model: "claude" });
    expect(result).toContain("VERDICT: FAIL");
    expect(result).toContain("All LLM tools exhausted");
    expect(mockResolveCodexBinary).toHaveBeenCalled(); // codex is tried after claude and gemini
    expect(mockExecFileSync).toHaveBeenCalled();
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

describe("tryGeminiPrint", () => {
  let originalApiKey: string | undefined;
  let originalModel: string | undefined;
  let fetchSpy: any;

  beforeEach(() => {
    originalApiKey = process.env["GEMINI_API_KEY"];
    originalModel = process.env["GEMINI_MODEL"];
    process.env["GEMINI_API_KEY"] = "mock-api-key";
    process.env["GEMINI_MODEL"] = "gemini-3-flash-preview";
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env["GEMINI_API_KEY"] = originalApiKey;
    } else {
      delete process.env["GEMINI_API_KEY"];
    }
    if (originalModel !== undefined) {
      process.env["GEMINI_MODEL"] = originalModel;
    } else {
      delete process.env["GEMINI_MODEL"];
    }
    fetchSpy.mockRestore();
  });

  it("returns fallback (error=undefined) when GEMINI_API_KEY is missing", async () => {
    delete process.env["GEMINI_API_KEY"];
    const result = await tryGeminiPrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns validVerdict=true for successful API response containing VERDICT: PASS", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "VERDICT: PASS" }] } }],
      }),
    } as Response);

    const result = await tryGeminiPrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe("VERDICT: PASS");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=mock-api-key",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          contents: [{ parts: [{ text: "evaluate this" }] }],
        }),
      }),
    );
  });

  it("returns validVerdict=true for successful API response containing VERDICT: FAIL", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "VERDICT: FAIL" }] } }],
      }),
    } as Response);

    const result = await tryGeminiPrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe("VERDICT: FAIL");
  });

  it("returns validVerdict=false with error when VERDICT is missing", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "Just some discussion" }] } }],
      }),
    } as Response);

    const result = await tryGeminiPrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("missing VERDICT");
  });

  it("returns validVerdict=false with error when API returns non-ok status", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Bad request payload",
    } as Response);

    const result = await tryGeminiPrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("status 400");
    expect(result.error).toContain("Bad request payload");
  });

  it("returns validVerdict=false with error when fetch throws", async () => {
    fetchSpy.mockRejectedValue(new Error("Network error"));

    const result = await tryGeminiPrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("Network error");
  });

  it("returns validVerdict=false with error when fetch times out (aborted)", async () => {
    fetchSpy.mockImplementation(async () => {
      throw new DOMException("The user aborted a request.", "AbortError");
    });

    const result = await tryGeminiPrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("aborted");
  });

  it("uses an AbortSignal and aborts the fetch after timeout", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    fetchSpy.mockImplementation(async (url: any, init: any) => {
      signal = init.signal;
      return new Promise((resolve, reject) => {
        const checkAbort = () => {
          if (signal?.aborted) {
            reject(new DOMException("The user aborted a request.", "AbortError"));
          } else {
            setTimeout(checkAbort, 100);
          }
        };
        setTimeout(checkAbort, 100);
      });
    });

    const promise = tryGeminiPrint("evaluate this");
    
    // Fast-forward time
    await vi.advanceTimersByTimeAsync(300000);
    
    const result = await promise;
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("aborted");
    expect(signal?.aborted).toBe(true);
    
    vi.useRealTimers();
  });
});

describe("llmEval — explicit model=gemini", () => {
  let originalApiKey: string | undefined;
  let originalModel: string | undefined;
  let fetchSpy: any;

  beforeEach(() => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockAccessSync.mockImplementation((path: unknown) => {
      if (path === "/mock/claude") return undefined;
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    originalApiKey = process.env["GEMINI_API_KEY"];
    originalModel = process.env["GEMINI_MODEL"];
    process.env["GEMINI_API_KEY"] = "mock-api-key";
    process.env["GEMINI_MODEL"] = "gemini-3-flash-preview";
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env["GEMINI_API_KEY"] = originalApiKey;
    } else {
      delete process.env["GEMINI_API_KEY"];
    }
    if (originalModel !== undefined) {
      process.env["GEMINI_MODEL"] = originalModel;
    } else {
      delete process.env["GEMINI_MODEL"];
    }
    fetchSpy.mockRestore();
  });

  it("tries gemini first when model=gemini is specified", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: PASS_VERDICT }] } }],
      }),
    } as Response);

    const result = await llmEval("evaluate this", { model: "gemini" });
    expect(result).toBe(PASS_VERDICT);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("falls back to codex when gemini is unavailable", async () => {
    delete process.env["GEMINI_API_KEY"];
    mockExecFileSync.mockReturnValue(PASS_VERDICT); // codex succeeds

    const result = await llmEval("evaluate this", { model: "gemini" });
    expect(result).toBe(PASS_VERDICT);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalled();
  });
});

describe("tryAgyPrint", () => {
  const allowAgyCandidate = () => {
    mockAccessSync.mockImplementation((path: unknown) => {
      if (path === "/usr/local/bin/agy" || path === "agy") return undefined;
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
  };

  it("passes cwd: '/tmp' to execFileSync when running agy", async () => {
    const originalAgyBinary = process.env["AGY_BINARY"];
    process.env["AGY_BINARY"] = "/usr/local/bin/agy";
    try {
      allowAgyCandidate();
      mockExecFileSync.mockReturnValue(PASS_VERDICT);
      const result = await tryAgyPrint("evaluate this");
      expect(result.validVerdict).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "/usr/local/bin/agy",
        ["--yolo", "-p", ""],
        expect.objectContaining({
          input: "evaluate this",
          cwd: "/tmp",
          encoding: "utf-8",
        }),
      );
    } finally {
      if (originalAgyBinary === undefined) delete process.env["AGY_BINARY"];
      else process.env["AGY_BINARY"] = originalAgyBinary;
    }
  });
});

describe("llmEval model validation", () => {
  it("throws a clear error when options.model array contains an unknown model", async () => {
    await expect(
      llmEval("test prompt", { model: ["codex", "invalid-model"] })
    ).rejects.toThrow('Invalid model in options.model: "invalid-model".');
  });
});

