import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentLaunchConfig } from "@jleechanorg/ao-core";
import path from "node:path";

const {
  mockHomedir,
  mockTmpdir,
  mockPlatform,
  mockMkdirSync,
  mockExistsSync,
  mockLstatSync,
  mockReaddirSync,
  mockCopyFileSync,
  mockSymlinkSync,
  mockUnlinkSync,
  mockRmSync,
  mockReadFileSync,
  mockWriteFileSync,
  mockReadlinkSync,
  mockRealpathSync,
  mockExecFileSync,
  mockSpawn,
} = vi.hoisted(() => ({
  mockHomedir: vi.fn(() => "/mock/home"),
  mockTmpdir: vi.fn(() => "/tmp"),
  mockPlatform: vi.fn(() => "darwin"),
  mockMkdirSync: vi.fn(),
  mockExistsSync: vi.fn(() => false),
  mockLstatSync: vi.fn(),
  mockReaddirSync: vi.fn(() => []),
  mockCopyFileSync: vi.fn(),
  mockSymlinkSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockRmSync: vi.fn(),
  mockReadFileSync: vi.fn(() => "{}"),
  mockWriteFileSync: vi.fn(),
  mockReadlinkSync: vi.fn(() => "/mock/home/Library/Keychains"),
  // Default: return path unchanged (no symlink resolution). Tests that need
  // a real path resolution override this with mockImplementation.
  mockRealpathSync: vi.fn((p: string) => p),
  mockExecFileSync: vi.fn(),
  mockSpawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock("node:os", () => ({
  default: {
    homedir: mockHomedir,
    tmpdir: mockTmpdir,
    platform: mockPlatform,
  },
  homedir: mockHomedir,
  tmpdir: mockTmpdir,
  platform: mockPlatform,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("node:child_process");
  return {
    ...actual,
    execFileSync: mockExecFileSync,
    spawn: mockSpawn,
    default: {
      ...actual.default,
      execFileSync: mockExecFileSync,
      spawn: mockSpawn,
    },
  };
});

vi.mock("node:fs", () => ({
  default: {
    mkdirSync: mockMkdirSync,
    existsSync: mockExistsSync,
    lstatSync: mockLstatSync,
    readdirSync: mockReaddirSync,
    copyFileSync: mockCopyFileSync,
    symlinkSync: mockSymlinkSync,
    unlinkSync: mockUnlinkSync,
    rmSync: mockRmSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    readlinkSync: mockReadlinkSync,
    realpathSync: mockRealpathSync,
  },
  mkdirSync: mockMkdirSync,
  existsSync: mockExistsSync,
  lstatSync: mockLstatSync,
  readdirSync: mockReaddirSync,
  copyFileSync: mockCopyFileSync,
  symlinkSync: mockSymlinkSync,
  unlinkSync: mockUnlinkSync,
  rmSync: mockRmSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  readlinkSync: mockReadlinkSync,
  realpathSync: mockRealpathSync,
}));

import { create } from "./index.js";

function makeLaunchConfig(permissions?: AgentLaunchConfig["permissions"], prompt?: string): AgentLaunchConfig {
  return {
    sessionId: "sess-1",
    permissions,
    prompt,
    projectConfig: {
      name: "my-project",
      repo: "owner/repo",
      path: "/workspace/repo",
      defaultBranch: "main",
      sessionPrefix: "my",
    },
  };
}

describe("antigravity antigravity-cli/settings.json trustedWorkspaces pre-seed", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("pre-seeds antigravity-cli/settings.json trustedWorkspaces with the launch workspace and project path", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    mockLstatSync.mockReset();
    mockUnlinkSync.mockReset();
    mockSymlinkSync.mockReset();
    mockWriteFileSync.mockReset();

    mockExistsSync.mockImplementation((filepath) => {
      if (typeof filepath !== "string") return false;
      // antigravity-cli/settings.json exists; the outer trustedFolders.json does not
      // (so we test the inner pre-seed in isolation, without writing the outer file).
      if (filepath.endsWith(path.join("antigravity-cli", "settings.json"))) return true;
      return false;
    });

    const writtenFiles = new Map<string, string>();
    mockWriteFileSync.mockImplementation((filepath, content) => {
      if (typeof filepath === "string") {
        writtenFiles.set(filepath, content as string);
      }
    });

    const env = agent.getEnvironment({
      ...makeLaunchConfig(),
      workspacePath: "/workspace/distinct-workspace-path",
    });
    expect(env).toBeDefined();

    const innerSettingsPath = path.join(
      "/Users/mockuser",
      ".ao-sessions",
      "sess-1",
      ".gemini",
      "antigravity-cli",
      "settings.json",
    );

    expect(writtenFiles.has(innerSettingsPath)).toBe(true);
    const innerSettings = JSON.parse(writtenFiles.get(innerSettingsPath) || "{}");
    expect(Array.isArray(innerSettings.trustedWorkspaces)).toBe(true);
    expect(innerSettings.trustedWorkspaces).toContain("/workspace/repo");
    expect(innerSettings.trustedWorkspaces).toContain(
      "/workspace/distinct-workspace-path",
    );
  });

  it("merges with existing trustedWorkspaces instead of overwriting them", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    mockLstatSync.mockReset();
    mockUnlinkSync.mockReset();
    mockSymlinkSync.mockReset();
    mockWriteFileSync.mockReset();

    mockExistsSync.mockImplementation((filepath) => {
      if (typeof filepath !== "string") return false;
      if (filepath.endsWith(path.join("antigravity-cli", "settings.json"))) return true;
      return false;
    });

    const existingEntries = ["/already/trusted/path", "/workspace/repo"];
    mockReadFileSync.mockImplementation((filepath) => {
      if (
        typeof filepath === "string" &&
        filepath.endsWith(path.join("antigravity-cli", "settings.json"))
      ) {
        return JSON.stringify({ trustedWorkspaces: existingEntries });
      }
      return "{}";
    });

    const writtenFiles = new Map<string, string>();
    mockWriteFileSync.mockImplementation((filepath, content) => {
      if (typeof filepath === "string") {
        writtenFiles.set(filepath, content as string);
      }
    });

    const env = agent.getEnvironment({
      ...makeLaunchConfig(),
      workspacePath: "/workspace/distinct-workspace-path",
    });
    expect(env).toBeDefined();

    const innerSettingsPath = path.join(
      "/Users/mockuser",
      ".ao-sessions",
      "sess-1",
      ".gemini",
      "antigravity-cli",
      "settings.json",
    );

    const innerSettings = JSON.parse(writtenFiles.get(innerSettingsPath) || "{}");
    expect(innerSettings.trustedWorkspaces).toContain("/already/trusted/path");
    expect(innerSettings.trustedWorkspaces).toContain("/workspace/repo");
    expect(innerSettings.trustedWorkspaces).toContain(
      "/workspace/distinct-workspace-path",
    );
  });

  it("does not overwrite antigravity-cli/settings.json when the existing file cannot be parsed (fail-closed)", () => {
    // CodeRabbit P2 finding (PR #685): the inner-settings pre-seed used to silently
    // swallow JSON.parse errors and then write `{trustedWorkspaces: [...]}`, which
    // would clobber other settings the spawned agy session depends on. The
    // existing trustedFolders pre-seed already fails closed on parse errors; the
    // inner path must do the same.
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    mockLstatSync.mockReset();
    mockUnlinkSync.mockReset();
    mockSymlinkSync.mockReset();
    mockWriteFileSync.mockReset();

    mockExistsSync.mockImplementation((filepath) => {
      if (typeof filepath !== "string") return false;
      if (filepath.endsWith(path.join("antigravity-cli", "settings.json"))) return true;
      return false;
    });

    const corruptJson = "{ trustedWorkspaces: [/already/here], /* unterminated";
    mockReadFileSync.mockImplementation((filepath) => {
      if (
        typeof filepath === "string" &&
        filepath.endsWith(path.join("antigravity-cli", "settings.json"))
      ) {
        return corruptJson;
      }
      return "{}";
    });

    const writtenFiles = new Map<string, string>();
    mockWriteFileSync.mockImplementation((filepath, content) => {
      if (typeof filepath === "string") {
        writtenFiles.set(filepath, content as string);
      }
    });

    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const env = agent.getEnvironment({
      ...makeLaunchConfig(),
      workspacePath: "/workspace/repo",
    });
    expect(env).toBeDefined();

    const innerSettingsPath = path.join(
      "/Users/mockuser",
      ".ao-sessions",
      "sess-1",
      ".gemini",
      "antigravity-cli",
      "settings.json",
    );

    // The existing corrupt file must NOT be replaced with a freshly minted
    // object containing only trustedWorkspaces — that would silently drop
    // whatever other settings the user had in there.
    expect(writtenFiles.has(innerSettingsPath)).toBe(false);

    // A debug log was emitted explaining why we skipped the write.
    const debugCalls = debugSpy.mock.calls.map((args) => String(args[0] ?? ""));
    expect(
      debugCalls.some(
        (msg) =>
          msg.includes("antigravity-cli/settings.json") &&
          msg.includes("skipping write to avoid clobbering"),
      ),
    ).toBe(true);

    debugSpy.mockRestore();
  });

  it("does not throw when antigravity-cli/settings.json is missing", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    mockLstatSync.mockReset();
    mockUnlinkSync.mockReset();
    mockSymlinkSync.mockReset();
    mockWriteFileSync.mockReset();

    mockExistsSync.mockReturnValue(false);

    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    expect(() =>
      agent.getEnvironment({
        ...makeLaunchConfig(),
        workspacePath: "/workspace/any",
      }),
    ).not.toThrow();

    debugSpy.mockRestore();
  });

  // 2026-06-14: trust-prompt regression. The pre-seed originally trusted only
  // the project and workspace path exactly, so workers running from a nested
  // cwd under the worktree (e.g. /Users/jleechan/.worktrees/worldarchitect/wa-1702)
  // re-triggered the "Do you trust this project?" TUI. The fix walks up the
  // directory tree from each seed path and adds every ancestor up to the home
  // dir. Verify the new behavior here.
  it("pre-seeds every ancestor of each launch path (not just the leaf)", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    mockLstatSync.mockReset();
    mockUnlinkSync.mockReset();
    mockSymlinkSync.mockReset();
    mockWriteFileSync.mockReset();

    mockExistsSync.mockImplementation((filepath) => {
      if (typeof filepath !== "string") return false;
      if (filepath.endsWith(path.join("antigravity-cli", "settings.json"))) return true;
      return false;
    });

    const writtenFiles = new Map<string, string>();
    mockWriteFileSync.mockImplementation((filepath, content) => {
      if (typeof filepath === "string") {
        writtenFiles.set(filepath, content as string);
      }
    });

    // Use a deeply-nested workspace path that does NOT live directly under
    // the project path. The seed walk must produce every prefix up to the
    // homedir (/Users/mockuser).
    const env = agent.getEnvironment({
      ...makeLaunchConfig(),
      workspacePath: "/Users/mockuser/.worktrees/agent-orchestrator/ao-9999",
    });
    expect(env).toBeDefined();

    const innerSettingsPath = path.join(
      "/Users/mockuser",
      ".ao-sessions",
      "sess-1",
      ".gemini",
      "antigravity-cli",
      "settings.json",
    );
    const innerSettings = JSON.parse(writtenFiles.get(innerSettingsPath) || "{}");
    const trusted = innerSettings.trustedWorkspaces as string[];

    // Leaf must be present.
    expect(trusted).toContain("/Users/mockuser/.worktrees/agent-orchestrator/ao-9999");
    // Every ancestor up to (but not including) the homedir must be present.
    expect(trusted).toContain("/Users/mockuser/.worktrees/agent-orchestrator");
    expect(trusted).toContain("/Users/mockuser/.worktrees");
    // The homedir itself is the stop boundary — it must NOT be added (would
    // over-trust the entire home directory).
    expect(trusted).not.toContain("/Users/mockuser");
  });

  it("never adds a top-level system root (e.g. /tmp, /var) to trustedWorkspaces", () => {
    // 2026-06-14 Skeptic review: an AO worker launched from /tmp/<x> must
    // not seed the entire /tmp directory (would trust every other
    // /tmp/<y> workspace on the host). The ancestor walk must stop at the
    // first "shared system" root, not just at the homedir.
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    mockLstatSync.mockReset();
    mockUnlinkSync.mockReset();
    mockSymlinkSync.mockReset();
    mockWriteFileSync.mockReset();

    mockExistsSync.mockImplementation((filepath) => {
      if (typeof filepath !== "string") return false;
      if (filepath.endsWith(path.join("antigravity-cli", "settings.json"))) return true;
      return false;
    });

    const writtenFiles = new Map<string, string>();
    mockWriteFileSync.mockImplementation((filepath, content) => {
      if (typeof filepath === "string") {
        writtenFiles.set(filepath, content as string);
      }
    });

    const env = agent.getEnvironment({
      ...makeLaunchConfig(),
      workspacePath: "/tmp/ao-sessions/sess-1",
    });
    expect(env).toBeDefined();

    const innerSettingsPath = path.join(
      "/Users/mockuser",
      ".ao-sessions",
      "sess-1",
      ".gemini",
      "antigravity-cli",
      "settings.json",
    );
    const innerSettings = JSON.parse(writtenFiles.get(innerSettingsPath) || "{}");
    const trusted = innerSettings.trustedWorkspaces as string[];

    // Leaf is added; parent (/tmp) is the stop boundary and must NOT be added.
    expect(trusted).toContain("/tmp/ao-sessions/sess-1");
    expect(trusted).not.toContain("/tmp");
    // The filesystem root must never be added.
    expect(trusted).not.toContain("/");
  });

  it("exercises the realpathSync branch — symlinked seed paths are also trusted at their resolved target", () => {
    // CodeRabbit nitpick (PR #693 round 2): the ancestor-walk in
    // addWithAncestors() calls fs.realpathSync() for every seed path so a
    // symlinked workspace is trusted at BOTH the leaf and the resolved
    // target. If the fs mock has no realpathSync, the call throws and
    // silently falls into the catch branch — masking bugs in the resolved
    // path handling. This test stubs realpathSync to rewrite a leaf to its
    // resolved target and verifies the rewritten path is also in the
    // trusted list.
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    mockLstatSync.mockReset();
    mockUnlinkSync.mockReset();
    mockSymlinkSync.mockReset();
    mockWriteFileSync.mockReset();
    mockRealpathSync.mockReset();

    mockExistsSync.mockImplementation((filepath) => {
      if (typeof filepath !== "string") return false;
      if (filepath.endsWith(path.join("antigravity-cli", "settings.json"))) return true;
      return false;
    });

    // Simulate a symlink: "/Users/mockuser/.worktrees/ao-9999" -> "/private/tmp/ao-9999-real"
    // (the macOS /tmp -> /private/tmp symlink case is the canonical real-world
    // reason this branch exists in the production code).
    mockRealpathSync.mockImplementation((p: string) => {
      if (typeof p !== "string") return p;
      if (p === "/Users/mockuser/.worktrees/ao-9999") {
        return "/private/tmp/ao-9999-real";
      }
      return p;
    });

    const writtenFiles = new Map<string, string>();
    mockWriteFileSync.mockImplementation((filepath, content) => {
      if (typeof filepath === "string") {
        writtenFiles.set(filepath, content as string);
      }
    });

    const env = agent.getEnvironment({
      ...makeLaunchConfig(),
      workspacePath: "/Users/mockuser/.worktrees/ao-9999",
    });
    expect(env).toBeDefined();

    const innerSettingsPath = path.join(
      "/Users/mockuser",
      ".ao-sessions",
      "sess-1",
      ".gemini",
      "antigravity-cli",
      "settings.json",
    );
    const innerSettings = JSON.parse(writtenFiles.get(innerSettingsPath) || "{}");
    const trusted = innerSettings.trustedWorkspaces as string[];

    // Both the symlinked leaf AND its realpath-resolved target must be trusted.
    expect(trusted).toContain("/Users/mockuser/.worktrees/ao-9999");
    expect(trusted).toContain("/private/tmp/ao-9999-real");
    // realpathSync must have been called at least once (not silently swallowed
    // by the catch branch).
    expect(mockRealpathSync).toHaveBeenCalled();
  });

  it("injects the security.folderTrust.enabled=false bypass flag (nested form per Gemini schema)", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    mockLstatSync.mockReset();
    mockUnlinkSync.mockReset();
    mockSymlinkSync.mockReset();
    mockWriteFileSync.mockReset();

    mockExistsSync.mockImplementation((filepath) => {
      if (typeof filepath !== "string") return false;
      if (filepath.endsWith(path.join("antigravity-cli", "settings.json"))) return true;
      return false;
    });

    const writtenFiles = new Map<string, string>();
    mockWriteFileSync.mockImplementation((filepath, content) => {
      if (typeof filepath === "string") {
        writtenFiles.set(filepath, content as string);
      }
    });

    agent.getEnvironment({
      ...makeLaunchConfig(),
      workspacePath: "/workspace/any",
    });

    const innerSettingsPath = path.join(
      "/Users/mockuser",
      ".ao-sessions",
      "sess-1",
      ".gemini",
      "antigravity-cli",
      "settings.json",
    );
    const innerSettings = JSON.parse(writtenFiles.get(innerSettingsPath) || "{}");

    // Nested form is the canonical gemini-cli key per the upstream schema
    // (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/schemas/settings.schema.json).
    // We deliberately do NOT also write a top-level `"security.folderTrust.enabled"`
    // (literal dots) key — Gemini's schema rejects unknown top-level properties
    // and a stray dotted key would surface as a "bad manual settings" warning
    // at agy startup, blocking the trust bypass from taking effect.
    expect(innerSettings?.security?.folderTrust?.enabled).toBe(false);
  });

  it("overrides security.folderTrust.enabled even when the existing file set it to true", () => {
    // Defense in depth: even if the user has folderTrust explicitly enabled
    // in their global settings, the AO operator's intent of "never prompt in
    // workers" wins for the per-session settings that agy reads first.
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    mockLstatSync.mockReset();
    mockUnlinkSync.mockReset();
    mockSymlinkSync.mockReset();
    mockWriteFileSync.mockReset();

    mockExistsSync.mockImplementation((filepath) => {
      if (typeof filepath !== "string") return false;
      if (filepath.endsWith(path.join("antigravity-cli", "settings.json"))) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((filepath) => {
      if (
        typeof filepath === "string" &&
        filepath.endsWith(path.join("antigravity-cli", "settings.json"))
      ) {
        // Simulate a user who had folderTrust ON — we must still flip it OFF.
        // Include a stale top-level dotted key in the user file so we can also
        // verify the pre-seed does NOT preserve it (Gemini's schema rejects
        // unknown top-level properties, so we drop it on the merge).
        return JSON.stringify({
          security: { folderTrust: { enabled: true } },
          "security.folderTrust.enabled": true,
          trustedWorkspaces: ["/already/trusted"],
        });
      }
      return "{}";
    });

    const writtenFiles = new Map<string, string>();
    mockWriteFileSync.mockImplementation((filepath, content) => {
      if (typeof filepath === "string") {
        writtenFiles.set(filepath, content as string);
      }
    });

    agent.getEnvironment({
      ...makeLaunchConfig(),
      workspacePath: "/workspace/repo",
    });

    const innerSettingsPath = path.join(
      "/Users/mockuser",
      ".ao-sessions",
      "sess-1",
      ".gemini",
      "antigravity-cli",
      "settings.json",
    );
    const innerSettings = JSON.parse(writtenFiles.get(innerSettingsPath) || "{}");
    expect(innerSettings?.security?.folderTrust?.enabled).toBe(false);
    // Stale top-level dotted key (invalid per Gemini's schema) must be
    // dropped on the merge — strict settings validation rejects unknown
    // top-level properties, so a leftover `"security.folderTrust.enabled"`
    // would surface as a "bad manual settings" warning at agy startup.
    expect(innerSettings["security.folderTrust.enabled"]).toBeUndefined();
    // The pre-existing trusted entry must be preserved through the merge.
    expect(innerSettings.trustedWorkspaces).toContain("/already/trusted");
  });

  it("emits GEMINI_CLI_TRUST_WORKSPACE=true in the worker env (belt-and-suspenders bypass)", () => {
    // The env var is the official gemini-cli escape hatch for headless /
    // CI environments. It bypasses the prompt even if a stray
    // folderTrust setting sneaks past our pre-seed. See
    // https://geminicli.com/docs/cli/trusted-folders → "Headless and
    // Automated Environments" → "Environment variable: GEMINI_CLI_TRUST_WORKSPACE=true".
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");
    const env = agent.getEnvironment({
      ...makeLaunchConfig(),
      workspacePath: "/workspace/repo",
    });
    expect(env.GEMINI_CLI_TRUST_WORKSPACE).toBe("true");
  });
});
