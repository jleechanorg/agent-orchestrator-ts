import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile as execFileCb } from "node:child_process";

// Mock node:child_process
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Import after mock
import { executeWithFallback } from "../fallback.js";
import type { FallbackConfig, FallbackResult } from "../fallback.js";

const mockExecFile = execFileCb as unknown as ReturnType<typeof vi.fn>;

/** Helper: make execFile resolve with stdout */
function stubExecFileSuccess(stdout: string): void {
  mockExecFile.mockImplementation(
    (
      _bin: string,
      _args: string[],
      _opts: Record<string, unknown>,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, stdout, "");
    },
  );
}

/** Helper: make execFile reject with an error */
function stubExecFileFailure(message: string): void {
  mockExecFile.mockImplementation(
    (
      _bin: string,
      _args: string[],
      _opts: Record<string, unknown>,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(new Error(message), "", "");
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// executeWithFallback()
// =============================================================================

describe("executeWithFallback()", () => {
  it("returns primary result when primary succeeds", async () => {
    const primary = vi.fn().mockResolvedValue("peekaboo output");

    const result = await executeWithFallback(
      primary,
      "do something",
      "/tmp/ws",
    );

    expect(result).toEqual<FallbackResult>({
      success: true,
      output: "peekaboo output",
      fallbackUsed: false,
    });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("invokes CLI fallback when primary throws", async () => {
    const primary = vi.fn().mockRejectedValue(new Error("peekaboo not found"));
    stubExecFileSuccess("claude output here");

    const result = await executeWithFallback(
      primary,
      "implement feature X",
      "/tmp/ws",
    );

    expect(result).toEqual<FallbackResult>({
      success: true,
      output: "claude output here",
      fallbackUsed: true,
    });
    expect(primary).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("invokes CLI fallback when primary returns error indicator", async () => {
    const primary = vi.fn().mockResolvedValue("element not found in window");
    stubExecFileSuccess("fallback result");

    const result = await executeWithFallback(
      primary,
      "click button",
      "/tmp/ws",
    );

    expect(result.fallbackUsed).toBe(true);
    expect(result.success).toBe(true);
    expect(result.output).toBe("fallback result");
  });

  it("returns success=false when both primary and fallback fail", async () => {
    const primary = vi.fn().mockRejectedValue(new Error("peekaboo crash"));
    stubExecFileFailure("claude binary not found");

    const result = await executeWithFallback(
      primary,
      "do task",
      "/tmp/ws",
      { maxRetries: 1 },
    );

    expect(result.success).toBe(false);
    expect(result.fallbackUsed).toBe(true);
    expect(result.error).toBeDefined();
  });

  it("respects maxRetries config", async () => {
    const primary = vi.fn().mockRejectedValue(new Error("fail"));
    stubExecFileFailure("claude error");

    const config: Partial<FallbackConfig> = { maxRetries: 4 };
    await executeWithFallback(primary, "retry task", "/tmp/ws", config);

    expect(mockExecFile).toHaveBeenCalledTimes(4);
  });

  it("passes correct arguments to claude CLI", async () => {
    const primary = vi.fn().mockRejectedValue(new Error("fail"));
    stubExecFileSuccess("done");

    await executeWithFallback(
      primary,
      "implement auth module",
      "/home/user/project",
      { cliBin: "/usr/local/bin/claude", cliFlags: ["--dangerously-skip-permissions", "--verbose"] },
    );

    expect(mockExecFile).toHaveBeenCalledWith(
      "/usr/local/bin/claude",
      ["--dangerously-skip-permissions", "--verbose", "-p", "implement auth module"],
      expect.objectContaining({ cwd: "/home/user/project" }),
      expect.any(Function),
    );
  });

  it("uses default config when none provided", async () => {
    const primary = vi.fn().mockRejectedValue(new Error("fail"));
    stubExecFileSuccess("output");

    await executeWithFallback(primary, "task", "/tmp/ws");

    // Default cliBin is "claude", default flag is --dangerously-skip-permissions
    expect(mockExecFile).toHaveBeenCalledWith(
      "claude",
      ["--dangerously-skip-permissions", "-p", "task"],
      expect.objectContaining({ cwd: "/tmp/ws" }),
      expect.any(Function),
    );
  });

  it("detects 'not found' case-insensitively in primary output", async () => {
    const primary = vi.fn().mockResolvedValue("Element Not Found in snapshot");
    stubExecFileSuccess("fallback ok");

    const result = await executeWithFallback(primary, "click", "/tmp/ws");

    expect(result.fallbackUsed).toBe(true);
  });

  it("stops retrying after first CLI success", async () => {
    const primary = vi.fn().mockRejectedValue(new Error("fail"));
    let callCount = 0;
    mockExecFile.mockImplementation(
      (
        _bin: string,
        _args: string[],
        _opts: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callCount++;
        if (callCount === 2) {
          cb(null, "success on retry 2", "");
        } else {
          cb(new Error("transient"), "", "");
        }
      },
    );

    const result = await executeWithFallback(
      primary,
      "flaky task",
      "/tmp/ws",
      { maxRetries: 5 },
    );

    expect(result.success).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(result.output).toBe("success on retry 2");
    expect(mockExecFile).toHaveBeenCalledTimes(2); // stopped after success
  });
});
