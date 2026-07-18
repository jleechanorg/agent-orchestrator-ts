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
    expect(mockExec).toHaveBeenCalledWith("gh", ["api", "user"]);
  });

  it("throws 'not installed' when gh is missing (ENOENT)", async () => {
    mockExec.mockRejectedValue(new Error("ENOENT"));
    await expect(preflight.checkGhAuth()).rejects.toThrow(
      "GitHub CLI (gh) is not installed",
    );
    // Should only call --version, not the api probe
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith("gh", ["--version"]);
  });

  it("throws 'not authenticated' when gh exists but the api probe fails with a genuine auth error", async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" }) // --version succeeds
      .mockRejectedValueOnce(
        Object.assign(new Error("HTTP 401"), {
          stdout: "",
          stderr: "gh: Bad credentials (HTTP 401)",
        }),
      ); // gh api user fails with a genuine (non-rate-limit) error
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
      Object.assign(new Error("HTTP 401"), {
        stdout: "",
        stderr: "gh: Bad credentials (HTTP 401)",
      }),
    );
    await expect(preflight.checkGhAuth()).rejects.toThrow("gh auth login");
  });

  it("does NOT throw 'not authenticated' when gh api user fails due to rate-limiting and a token is present", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockExec
      .mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" }) // --version
      .mockRejectedValueOnce(
        Object.assign(new Error("HTTP 403"), {
          stdout: "",
          stderr: "gh: API rate limit exceeded for installation ID 12345. (HTTP 403)",
        }),
      ) // gh api user fails with rate-limit signature
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
      ) // gh api user rate-limited
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
      ); // gh api user rate-limited

    await expect(preflight.checkGhAuth()).resolves.toBeUndefined();
    // Should NOT shell out to `gh auth token` since GH_TOKEN env var already answers presence
    expect(mockExec).not.toHaveBeenCalledWith("gh", ["auth", "token"]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("passes immediately when gh api user succeeds, even though gh auth status would report the token invalid", async () => {
    // Live-reproduced bug: `gh auth status` can report "token is invalid" for a
    // token that `gh api user` accepts fine. The primary probe must be `gh api
    // user`, and `gh auth status` must never be consulted at all — its opinion
    // (mocked here as a hypothetical failing call) is irrelevant once the
    // api-user probe succeeds.
    mockExec
      .mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" }) // --version
      .mockResolvedValueOnce({ stdout: '{"login":"jleechan2015"}', stderr: "" }); // gh api user succeeds

    await expect(preflight.checkGhAuth()).resolves.toBeUndefined();

    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec).toHaveBeenCalledWith("gh", ["api", "user"]);
    expect(mockExec).not.toHaveBeenCalledWith("gh", ["auth", "status"]);
  });

  it("falls back to rate-limit classification when gh api user itself is rate-limited and a token is present (warn+proceed)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockExec
      .mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" }) // --version
      .mockRejectedValueOnce(
        Object.assign(new Error("HTTP 403"), {
          stdout: "",
          stderr: "API rate limit exceeded for installation ID 12345. (HTTP 403)",
        }),
      ) // gh api user itself is rate-limited
      .mockResolvedValueOnce({ stdout: "gho_faketoken", stderr: "" }); // gh auth token succeeds

    await expect(preflight.checkGhAuth()).resolves.toBeUndefined();
    expect(mockExec).not.toHaveBeenCalledWith("gh", ["auth", "status"]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("throws 'not authenticated' when gh api user fails with a genuine 401 and no rate-limit signature", async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" }) // --version
      .mockRejectedValueOnce(
        Object.assign(new Error("HTTP 401"), {
          stdout: "",
          stderr: "gh: Bad credentials (HTTP 401)",
        }),
      ); // gh api user fails, no rate-limit signature present

    await expect(preflight.checkGhAuth()).rejects.toThrow(
      "GitHub CLI is not authenticated",
    );
    // Should not even attempt the token-presence fallback for a non-rate-limit failure
    expect(mockExec).not.toHaveBeenCalledWith("gh", ["auth", "token"]);
  });

  // PR #771 review (chatgpt-codex-connector, P2): a bare "403" is not sufficient
  // evidence of rate limiting — GitHub also returns 403 for missing token scopes
  // and org/SSO policy blocks, which are genuine auth failures.
  it("throws 'not authenticated' for a 403 that carries org/SSO policy text but no rate-limit signature (bare 403 must not bypass auth)", async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" }) // --version
      .mockRejectedValueOnce(
        Object.assign(new Error("HTTP 403"), {
          stdout: "",
          stderr:
            "gh: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization. (HTTP 403)",
        }),
      ); // gh api user fails with a genuine 403 (SSO policy block), no rate-limit text

    await expect(preflight.checkGhAuth()).rejects.toThrow(
      "GitHub CLI is not authenticated",
    );
    // Must not even attempt the token-presence fallback — this is not a rate limit
    expect(mockExec).not.toHaveBeenCalledWith("gh", ["auth", "token"]);
  });

  it("warns and proceeds for a 403 accompanied by explicit rate-limit text", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockExec
      .mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" }) // --version
      .mockRejectedValueOnce(
        Object.assign(new Error("HTTP 403"), {
          stdout: "",
          stderr: "gh: API rate limit exceeded for installation ID 12345. (HTTP 403)",
        }),
      ) // gh api user fails with 403 + explicit "rate limit exceeded" text
      .mockResolvedValueOnce({ stdout: "gho_faketoken", stderr: "" }); // gh auth token succeeds

    await expect(preflight.checkGhAuth()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("warns and proceeds for a bare 429 with no other rate-limit text (429 is unambiguous)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockExec
      .mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" }) // --version
      .mockRejectedValueOnce(
        Object.assign(new Error("HTTP 429"), {
          stdout: "",
          stderr: "gh: 429",
        }),
      ) // bare 429, no "rate limit" phrase at all
      .mockResolvedValueOnce({ stdout: "gho_faketoken", stderr: "" }); // gh auth token succeeds

    await expect(preflight.checkGhAuth()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});
