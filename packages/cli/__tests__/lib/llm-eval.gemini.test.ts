import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockResolveCodexBinary = vi.hoisted(() => vi.fn());
const mockAccessSync = vi.hoisted(() => vi.fn());

// Set CLAUDE_BINARY and GEMINI_BINARY before module load
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

import { llmEval } from "../../src/lib/llm-eval.js";

const PASS_VERDICT = "VERDICT: PASS";
const FAIL_VERDICT = "VERDICT: FAIL";

let originalApiKey: string | undefined;
let originalModel: string | undefined;
let fetchSpy: any;

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
