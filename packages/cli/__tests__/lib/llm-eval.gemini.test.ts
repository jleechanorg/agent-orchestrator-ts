import { beforeEach, describe, expect, it, vi } from "vitest";

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
});

// model=gemini is now IN the supported chain (["codex", "claude", "gemini"]).
// When model=gemini is specified, preferredHeadless="gemini", rotation starts
// at gemini: ["gemini","codex","claude"].

describe("tryGeminiPrint — cwd isolation", () => {
  it("runs gemini from /tmp, not the PR checkout directory", async () => {
    // Allow /mock/gemini through accessSync
    mockAccessSync.mockImplementation((path: unknown) => {
      if (path === "/mock/gemini" || path === "gemini") return undefined;
      const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    mockExecFileSync.mockReturnValue(PASS_VERDICT);

    const { tryGeminiPrint } = await import("../../src/lib/llm-eval.js");
    await tryGeminiPrint("evaluate this");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/mock/gemini",
      expect.any(Array),
      expect.objectContaining({ cwd: "/tmp" }),
    );
  });
});

describe("llmEval — explicit model=gemini", () => {
  it("tries gemini first when model=gemini is specified", async () => {
    // Allow /mock/gemini through accessSync
    mockAccessSync.mockImplementation((path: unknown) => {
      if (path === "/mock/gemini" || path === "gemini") return undefined;
      const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    mockExecFileSync.mockReturnValue(FAIL_VERDICT);
    const result = await llmEval("evaluate this", { model: "gemini" });
    expect(result).toBe(FAIL_VERDICT);
  });

  it("falls back to codex when gemini is unavailable with model=gemini", async () => {
    mockResolveCodexBinary.mockResolvedValue("/usr/local/bin/codex");
    // Gemini candidates all fail accessSync (default mock), then codex succeeds
    // Rotation: ["gemini","codex","claude"]
    mockExecFileSync.mockReturnValue(PASS_VERDICT); // codex succeeds
    const result = await llmEval("evaluate this", { model: "gemini" });
    expect(result).toBe(PASS_VERDICT);
  });

  it("fails closed when gemini omits a verdict with model=gemini", async () => {
    // Allow /mock/gemini through accessSync
    mockAccessSync.mockImplementation((path: unknown) => {
      if (path === "/mock/gemini" || path === "gemini") return undefined;
      const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    mockExecFileSync.mockReturnValueOnce("Gemini analysis with no verdict");
    const result = await llmEval("evaluate this", { model: "gemini" });
    expect(result).toContain("VERDICT: FAIL");
    expect(result).toContain("gemini:");
    expect(result).toContain("missing VERDICT");
  });
});
