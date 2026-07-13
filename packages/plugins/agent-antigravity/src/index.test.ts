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

describe("antigravity getLaunchCommand", () => {
  it("defaults missing permissions to --dangerously-skip-permissions", () => {
    const agent = create();

    const cmd = agent.getLaunchCommand(makeLaunchConfig());

    expect(cmd).toContain("agy --prompt-interactive");
    expect(cmd).toContain("--dangerously-skip-permissions");
  });

  it("keeps explicit default permissions non-permissionless", () => {
    const agent = create();

    const cmd = agent.getLaunchCommand(makeLaunchConfig("default"));

    expect(cmd).not.toContain("--dangerously-skip-permissions");
  });

  it("incorporates launchConfig.prompt if provided", () => {
    const agent = create();

    const cmd = agent.getLaunchCommand(makeLaunchConfig(undefined, "hello 'world'"));

    expect(cmd).toContain("agy --prompt-interactive 'hello '\\''world'\\''");
  });

  it("incorporates launchConfig.model if provided", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand({
      ...makeLaunchConfig(),
      model: "gemini-2.5-pro",
    });

    expect(cmd).toContain("--model 'gemini-2.5-pro'");
  });

  it("escapes launchConfig.model if it has special characters", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand({
      ...makeLaunchConfig(),
      model: "my 'custom' model",
    });

    expect(cmd).toContain("--model 'my '\\''custom'\\'' model'");
  });

  it("does not incorporate launchConfig.model if not provided", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand(makeLaunchConfig());

    expect(cmd).not.toContain("--model");
  });
});

describe("antigravity getEnvironment", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns the environment configuration with mapped session HOME and cleared variables", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    const env = agent.getEnvironment(makeLaunchConfig());

    expect(env).toBeDefined();
    expect(env.AO_SESSION).toBe("sess-1");
    expect(env.AO_SESSION_ID).toBe("sess-1");
    expect(env.HOME).toBe(path.join("/Users/mockuser", ".ao-sessions", "sess-1"));
    expect(env.ANTIGRAVITY_PROJECT_ID).toBe("");
    expect(env.ANTIGRAVITY_TRAJECTORY_ID).toBe("");

    expect(mockMkdirSync).toHaveBeenCalledWith(
      path.join("/Users/mockuser", ".ao-sessions", "sess-1"),
      { recursive: true }
    );
  });

  it("symlinks static .gemini entries, copies mutable settings.json, and skips runtime dirs", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    mockExistsSync.mockImplementation((filepath) => {
      if (typeof filepath === "string" && filepath.includes(".gemini")) {
        return true;
      }
      return false;
    });

    mockLstatSync.mockImplementation((filepath) => {
      const isFile = typeof filepath === "string" && (filepath.endsWith(".json") || filepath.endsWith(".config"));
      return {
        isSymbolicLink: () => false,
        isDirectory: () => !isFile,
      };
    });

    mockReaddirSync.mockImplementation((dirpath) => {
      if (typeof dirpath === "string" && dirpath.endsWith(".gemini")) {
        return ["settings.json", "tmp", "history", "antigravity-browser-profile", "valid-subdir"];
      }
      if (typeof dirpath === "string" && dirpath.endsWith("valid-subdir")) {
        return ["config.json"];
      }
      return [];
    });

    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env).toBeDefined();

    expect(mockCopyFileSync).toHaveBeenCalledWith(
      path.join("/Users/mockuser", ".gemini", "settings.json"),
      path.join("/Users/mockuser", ".ao-sessions", "sess-1", ".gemini", "settings.json")
    );

    expect(mockSymlinkSync).toHaveBeenCalledWith(
      path.join("/Users/mockuser", ".gemini", "valid-subdir"),
      path.join("/Users/mockuser", ".ao-sessions", "sess-1", ".gemini", "valid-subdir")
    );

    const allCopiedDests = mockCopyFileSync.mock.calls.map((call) => call[1] as string);
    const hasTmp = allCopiedDests.some((dest) => dest.includes("tmp"));
    const hasHistory = allCopiedDests.some((dest) => dest.includes("history"));
    const hasProfile = allCopiedDests.some((dest) => dest.includes("antigravity-browser-profile"));

    expect(hasTmp).toBe(false);
    expect(hasHistory).toBe(false);
    expect(hasProfile).toBe(false);
  });

  it("skips host symlink entries when materializing .gemini", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    mockExistsSync.mockImplementation((filepath) => {
      if (typeof filepath === "string" && filepath.includes(".gemini")) return true;
      return false;
    });

    mockLstatSync.mockImplementation((filepath) => {
      if (typeof filepath === "string" && filepath.endsWith("symlink-dir")) {
        return { isSymbolicLink: () => true, isDirectory: () => false };
      }
      const isFile = typeof filepath === "string" && filepath.endsWith(".json");
      return { isSymbolicLink: () => false, isDirectory: () => !isFile };
    });

    mockReaddirSync.mockImplementation((dirpath) => {
      if (typeof dirpath === "string" && dirpath.endsWith(".gemini")) {
        return ["settings.json", "symlink-dir"];
      }
      return [];
    });

    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env).toBeDefined();

    expect(mockCopyFileSync).toHaveBeenCalledWith(
      path.join("/Users/mockuser", ".gemini", "settings.json"),
      path.join("/Users/mockuser", ".ao-sessions", "sess-1", ".gemini", "settings.json")
    );

    const allCopiedSrcs = mockCopyFileSync.mock.calls.map((call) => call[0] as string);
    const hasSymlink = allCopiedSrcs.some((src) => src.includes("symlink-dir"));
    expect(hasSymlink).toBe(false);
  });

  it("disables session retention even when general section in settings.json is missing", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    mockExistsSync.mockImplementation((filepath) => {
      if (typeof filepath === "string" && filepath.endsWith("settings.json")) return true;
      return false;
    });

    mockReadFileSync.mockReturnValue(JSON.stringify({})); // Empty settings.json

    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env).toBeDefined();

    expect(mockWriteFileSync).toHaveBeenCalled();
    const writtenContent = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(writtenContent.general).toBeDefined();
    expect(writtenContent.general.sessionRetention).toBeDefined();
    expect(writtenContent.general.sessionRetention.enabled).toBe(false);
  });

  it("handles dangling symlinks and removes them before creating new ones", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    mockLstatSync.mockImplementation((filepath) => {
      // Simulate that the sessionSub already exists as a symlink
      if (typeof filepath === "string" && (filepath.includes("conversations") || filepath.includes("brain"))) {
        return {
          isSymbolicLink: () => true,
          isDirectory: () => false,
        };
      }
      return {
        isSymbolicLink: () => false,
        isDirectory: () => true,
      };
    });

    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env).toBeDefined();

    // Verify that unlinkSync was called to remove the dangling symlink
    expect(mockUnlinkSync).toHaveBeenCalled();
    // Verify that symlinkSync was called to recreate the symlink
    expect(mockSymlinkSync).toHaveBeenCalled();
  });

  it("handles symlink and unlink errors gracefully without throwing", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    mockLstatSync.mockImplementation(() => ({
      isSymbolicLink: () => true,
      isDirectory: () => false,
    }));

    mockUnlinkSync.mockImplementation(() => {
      throw new Error("un-unlinkable symlink (mocked EACCES)");
    });
    mockSymlinkSync.mockImplementation(() => {
      throw new Error("un-symlinkable path (mocked EPERM)");
    });

    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    expect(() => agent.getEnvironment(makeLaunchConfig())).not.toThrow();

    expect(mockUnlinkSync).toHaveBeenCalled();
    expect(mockSymlinkSync).toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it("handles readFileSync / writeFileSync errors in settings.json gracefully without throwing", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    // Reset mocks from prior test to prevent implementation leakage
    mockLstatSync.mockReset();
    mockUnlinkSync.mockReset();
    mockSymlinkSync.mockReset();

    mockExistsSync.mockImplementation((filepath) => {
      if (typeof filepath === "string" && filepath.endsWith("settings.json")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation(() => {
      throw new Error("mocked read error");
    });

    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    expect(() => agent.getEnvironment(makeLaunchConfig())).not.toThrow();
    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });
});
