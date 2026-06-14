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

  it("injects the security.folderTrust.enabled=false bypass flag in both nested and dotted form", () => {
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

    // Nested form (the canonical gemini-cli key).
    expect(innerSettings?.security?.folderTrust?.enabled).toBe(false);
    // Dotted form (VS Code-style; some agy builds read this).
    expect(innerSettings["security.folderTrust.enabled"]).toBe(false);
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
    expect(innerSettings["security.folderTrust.enabled"]).toBe(false);
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
