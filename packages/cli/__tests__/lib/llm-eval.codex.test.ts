import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockResolveCodexBinary = vi.hoisted(() => vi.fn());
const mockAccessSync = vi.hoisted(() => vi.fn());

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

import { tryCodexPrint } from "../../src/lib/llm-eval.js";

const PASS_VERDICT = "VERDICT: PASS";
const FAIL_VERDICT = "VERDICT: FAIL";
const SKIPPED_VERDICT = "VERDICT: SKIPPED";

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
  mockAccessSync.mockImplementation((_path) => {
    const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
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
      ["exec", "--model", "gpt-5.5", "-c", "check_for_update_on_startup=false", "-"],
      expect.objectContaining({ input: "evaluate this" }),
    );
  });

  it("uses the explicit gpt-5.5 codex model by default", async () => {
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
