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
});
