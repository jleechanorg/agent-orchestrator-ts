import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockExec, mockIsPortAvailable, mockExistsSync } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockIsPortAvailable: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock("../../src/lib/shell.js", () => ({
  exec: mockExec,
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
  const savedGhToken = process.env.GH_TOKEN;
  const savedGithubToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    if (savedGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedGhToken;
    if (savedGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedGithubToken;
    vi.restoreAllMocks();
  });

  it("passes when gh is installed and authenticated", async () => {
    mockExec.mockResolvedValue({ stdout: "ok", stderr: "" });
    await expect(preflight.checkGhAuth()).resolves.toBeUndefined();
    expect(mockExec).toHaveBeenCalledWith("gh", ["--version"]);
    expect(mockExec).toHaveBeenCalledWith("gh", ["auth", "status"]);
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

  it("throws 'not authenticated' when gh exists but auth fails with a genuine auth error", async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" }) // --version succeeds
      .mockRejectedValueOnce(
        Object.assign(new Error("not logged in"), {
          stdout: "",
          stderr: "You are not logged into any GitHub hosts.",
        }),
      ); // auth status fails with a genuine (non-rate-limit) error
    await expect(preflight.checkGhAuth()).rejects.toThrow(
      "GitHub CLI is not authenticated",
    );
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("includes correct fix instructions for each failure", async () => {
    // Not installed → install link
    mockExec.mockRejectedValue(new Error("ENOENT"));
    await expect(preflight.checkGhAuth()).rejects.toThrow(
      "https://cli.github.com/",
    );

    mockExec.mockReset();

    // Not authenticated → auth login
    mockExec.mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" }).mockRejectedValueOnce(
      Object.assign(new Error("not logged in"), {
        stdout: "",
        stderr: "You are not logged into any GitHub hosts.",
      }),
    );
    await expect(preflight.checkGhAuth()).rejects.toThrow("gh auth login");
  });

  it("does NOT throw 'not authenticated' when gh auth status fails due to GraphQL rate-limiting and a token is present", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockExec
      .mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" }) // --version
      .mockRejectedValueOnce(
        Object.assign(new Error("HTTP 403"), {
          stdout: "",
          stderr: "gh: API rate limit exceeded for installation ID 12345. (HTTP 403)",
        }),
      ) // auth status fails with rate-limit signature
      .mockResolvedValueOnce({ stdout: "gho_faketoken1234567890", stderr: "" }); // gh auth token succeeds

    await expect(preflight.checkGhAuth()).resolves.toBeUndefined();

    expect(mockExec).toHaveBeenCalledWith("gh", ["auth", "token"]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("still throws 'not authenticated' when rate-limited AND no token is configured", async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" }) // --version
      .mockRejectedValueOnce(
        Object.assign(new Error("HTTP 429"), {
          stdout: "",
          stderr: "rate limit exceeded",
        }),
      ) // auth status rate-limited
      .mockRejectedValueOnce(new Error("no token found")); // gh auth token fails too

    await expect(preflight.checkGhAuth()).rejects.toThrow(
      "GitHub CLI is not authenticated",
    );
  });

  it("uses GH_TOKEN env var as presence check without calling 'gh auth token' again", async () => {
    process.env.GH_TOKEN = "gho_envtoken";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockExec
      .mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" }) // --version
      .mockRejectedValueOnce(
        Object.assign(new Error("HTTP 403"), {
          stdout: "",
          stderr: "API rate limit exceeded",
        }),
      ); // auth status rate-limited

    await expect(preflight.checkGhAuth()).resolves.toBeUndefined();
    // Should NOT shell out to `gh auth token` since GH_TOKEN env var already answers presence
    expect(mockExec).not.toHaveBeenCalledWith("gh", ["auth", "token"]);
    expect(warnSpy).toHaveBeenCalled();
  });
});
