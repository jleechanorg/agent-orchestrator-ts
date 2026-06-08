import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockResolveCodexBinary = vi.hoisted(() => vi.fn());
const mockAccessSync = vi.hoisted(() => vi.fn());

// Set CLAUDE_BINARY and GEMINI_BINARY before module load
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

import { llmEval, tryGeminiPrint } from "../../src/lib/llm-eval.js";

const PASS_VERDICT = "VERDICT: PASS";
const FAIL_VERDICT = "VERDICT: FAIL";

let originalApiKey: string | undefined;
let originalModel: string | undefined;
let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  mockExecFileSync.mockReset();
  mockResolveCodexBinary.mockReset();
  mockAccessSync.mockReset();
  mockExecFileSync.mockImplementation(() => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
  // accessSync: throw ENOENT for all candidates by default
  mockAccessSync.mockImplementation((_path: unknown) => {
    const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
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

describe("tryGeminiPrint", () => {
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
    try {
      let signal: AbortSignal | undefined;
      fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        signal = init?.signal;
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
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("llmEval — explicit model=gemini", () => {
  it("tries gemini first when model=gemini is specified", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "VERDICT: FAIL" }] } }],
      }),
    } as Response);

    const result = await llmEval("evaluate this", { model: "gemini" });
    expect(result).toBe(FAIL_VERDICT);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("falls back to codex when gemini is unavailable with model=gemini", async () => {
    delete process.env["GEMINI_API_KEY"];
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    mockExecFileSync.mockReturnValue(PASS_VERDICT); // codex succeeds

    const result = await llmEval("evaluate this", { model: "gemini" });
    expect(result).toBe(PASS_VERDICT);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed when gemini omits a verdict with model=gemini", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "Gemini analysis with no verdict" }] } }],
      }),
    } as Response);

    const result = await llmEval("evaluate this", { model: "gemini" });
    expect(result).toContain("VERDICT: FAIL");
    expect(result).toContain("gemini:");
    expect(result).toContain("missing VERDICT");
  });
});
