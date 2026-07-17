import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExec, mockExecOrError, mockIsPortAvailable, mockExistsSync } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockExecOrError: vi.fn(),
  mockIsPortAvailable: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock("../../src/lib/shell.js", () => ({
  exec: mockExec,
  execOrError: mockExecOrError,
}));

vi.mock("../../src/lib/web-dir.js", () => ({
  isPortAvailable: mockIsPortAvailable,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

import { preflight } from "../../src/lib/preflight.js";

beforeEach(() => {
  mockExec.mockReset();
  mockIsPortAvailable.mockReset();
  mockExistsSync.mockReset();
});

describe("preflight.checkPort", () => {
  it("passes when port is free", async () => {
    mockIsPortAvailable.mockResolvedValue(true);
    await expect(preflight.checkPort(3000)).resolves.toBeUndefined();
    expect(mockIsPortAvailable).toHaveBeenCalledWith(3000);
  });

  it("throws when port is in use", async () => {
    mockIsPortAvailable.mockResolvedValue(false);
    await expect(preflight.checkPort(3000)).rejects.toThrow(
      "Port 3000 is already in use",
    );
  });

  it("includes port number in error message", async () => {
    mockIsPortAvailable.mockResolvedValue(false);
    await expect(preflight.checkPort(8080)).rejects.toThrow("Port 8080");
  });
});

describe("preflight.checkBuilt", () => {
  it("passes when node_modules and core dist exist", async () => {
    mockExistsSync.mockReturnValue(true);
    await expect(preflight.checkBuilt("/web")).resolves.toBeUndefined();
    expect(mockExistsSync).toHaveBeenCalled();
  });

  it("throws 'pnpm install' when node_modules is missing", async () => {
    // First call checks node_modules/@jleechanorg/ao-core — missing
    mockExistsSync.mockReturnValue(false);
    await expect(preflight.checkBuilt("/web")).rejects.toThrow(
      "pnpm install",
    );
  });

  it("throws 'pnpm build' when node_modules exists but dist is missing", async () => {
    // First call: node_modules/@jleechanorg/ao-core exists
    // Second call: dist/index.js does not exist
    mockExistsSync
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    await expect(preflight.checkBuilt("/web")).rejects.toThrow(
      "Packages not built. Run: pnpm build",
    );
  });
});

describe("preflight.checkTmux", () => {
  it("passes when tmux is installed", async () => {
    mockExec.mockResolvedValue({ stdout: "tmux 3.3a", stderr: "" });
    await expect(preflight.checkTmux()).resolves.toBeUndefined();
    expect(mockExec).toHaveBeenCalledWith("tmux", ["-V"]);
  });

  it("throws when tmux is not installed", async () => {
    mockExec.mockRejectedValue(new Error("ENOENT"));
    await expect(preflight.checkTmux()).rejects.toThrow(
      "tmux is not installed",
    );
  });

  it("includes install instruction in error", async () => {
    mockExec.mockRejectedValue(new Error("ENOENT"));
    await expect(preflight.checkTmux()).rejects.toThrow("brew install tmux");
  });
});

describe("preflight.checkGhAuth", () => {
  it("passes when gh is installed and authenticated", async () => {
    mockExec.mockResolvedValue({ stdout: "ok", stderr: "" });
    mockExecOrError.mockResolvedValue({ stdout: "logged in", stderr: "", code: 0 });
    await expect(preflight.checkGhAuth()).resolves.toBeUndefined();
    expect(mockExec).toHaveBeenCalledWith("gh", ["--version"]);
    expect(mockExecOrError).toHaveBeenCalledWith("gh", ["auth", "status"]);
  });

  it("throws 'not installed' when gh is missing (ENOENT)", async () => {
    mockExec.mockRejectedValue(new Error("ENOENT"));
    await expect(preflight.checkGhAuth()).rejects.toThrow(
      "GitHub CLI (gh) is not installed",
    );
    // Should only call --version, not auth status
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith("gh", ["--version"]);
  });

  it("throws 'not authenticated' when gh exists but auth fails (401)", async () => {
    mockExec.mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" }); // --version succeeds
    mockExecOrError.mockResolvedValueOnce({
      stdout: "",
      stderr: "gh: HTTP 401 Bad credentials",
      code: 1,
    }); // auth status: 401
    await expect(preflight.checkGhAuth()).rejects.toThrow(/401/);
  });

  it("includes correct fix instructions for each failure", async () => {
    // Not installed → install link
    mockExec.mockRejectedValue(new Error("ENOENT"));
    await expect(preflight.checkGhAuth()).rejects.toThrow(
      "https://cli.github.com/",
    );

    mockExec.mockReset();
    mockExecOrError.mockReset();

    // Not authenticated (401) → auth login
    mockExec.mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" });
    mockExecOrError.mockResolvedValueOnce({
      stdout: "",
      stderr: "gh: HTTP 401 Bad credentials",
      code: 1,
    });
    await expect(preflight.checkGhAuth()).rejects.toThrow(/401|auth login/);
  });

  // jleechan-ao-preflight-ratelimit-qcr9: gh auth status returns non-zero
  // exit code on THREE distinct classes of failure: not authenticated
  // (HTTP 401), forbidden (HTTP 403, e.g. SSO required), and rate-limited
  // (HTTP 403 secondary / HTTP 429). The pre-fix code treated all three as
  // "not authenticated" — including rate-limit — which caused the daemon
  // to mark wave dispatches as auth-failed and trigger spurious
  // notifier-discord/mcp-mail errors. The fix MUST distinguish them so
  // rate-limit failures surface as transient/retryable and the user gets
  // the correct guidance ("rate limited, wait and retry") instead of
  // being told to re-authenticate a perfectly valid token.
  it("distinguishes 401 invalid-token from 403/429 rate-limit (qcr9)", async () => {
    mockExec.mockResolvedValue({ stdout: "gh version 2.40", stderr: "" });
    mockExecOrError.mockResolvedValueOnce({
      stdout: "",
      stderr: "gh: HTTP 401 Bad credentials (curl rc=22)",
      code: 1,
    });
    await expect(preflight.checkGhAuth()).rejects.toThrow(/401/);

    mockExecOrError.mockReset();
    mockExecOrError.mockResolvedValueOnce({
      stdout: "",
      stderr: "gh: HTTP 403 rate limit exceeded",
      code: 1,
    });
    await expect(preflight.checkGhAuth()).rejects.toThrow(/rate.?limit/i);

    mockExecOrError.mockReset();
    mockExecOrError.mockResolvedValueOnce({
      stdout: "",
      stderr: "gh: HTTP 429 Too Many Requests",
      code: 1,
    });
    await expect(preflight.checkGhAuth()).rejects.toThrow(/rate.?limit/i);
  });

  it("rate-limit preflight failure is tagged retryable so callers defer, not park (qcr9)", async () => {
    // The fix MUST expose whether the failure is retryable so the
    // dispatch path can defer-and-retry rather than parking HUMAN_HELD.
    // Pre-fix, rate-limit was indistinguishable from 401 → all auth
    // failures were "not authenticated" + manual intervention required.
    mockExec.mockResolvedValue({ stdout: "gh version 2.40", stderr: "" });
    mockExecOrError.mockResolvedValueOnce({
      stdout: "",
      stderr: "gh: HTTP 403 API rate limit exceeded",
      code: 1,
    });
    const reason = await preflight
      .checkGhAuth()
      .then(() => "ok")
      .catch((e: Error) => e.message);
    expect(reason).toMatch(/rate.?limit/i);
    expect(reason).toMatch(/retry|wait|backoff/i);
    expect(reason).not.toMatch(/gh auth login/);
  });
});
