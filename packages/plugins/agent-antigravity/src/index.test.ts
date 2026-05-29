import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentLaunchConfig } from "@jleechanorg/ao-core";
import path from "node:path";

const {
  mockHomedir,
  mockMkdirSync,
  mockExistsSync,
  mockLstatSync,
  mockReaddirSync,
  mockCopyFileSync,
  mockSymlinkSync,
} = vi.hoisted(() => ({
  mockHomedir: vi.fn(() => "/mock/home"),
  mockMkdirSync: vi.fn(),
  mockExistsSync: vi.fn(() => false),
  mockLstatSync: vi.fn(),
  mockReaddirSync: vi.fn(() => []),
  mockCopyFileSync: vi.fn(),
  mockSymlinkSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  default: {
    homedir: mockHomedir,
  },
  homedir: mockHomedir,
}));

vi.mock("node:fs", () => ({
  default: {
    mkdirSync: mockMkdirSync,
    existsSync: mockExistsSync,
    lstatSync: mockLstatSync,
    readdirSync: mockReaddirSync,
    copyFileSync: mockCopyFileSync,
    symlinkSync: mockSymlinkSync,
  },
  mkdirSync: mockMkdirSync,
  existsSync: mockExistsSync,
  lstatSync: mockLstatSync,
  readdirSync: mockReaddirSync,
  copyFileSync: mockCopyFileSync,
  symlinkSync: mockSymlinkSync,
}));

import { create } from "./index.js";

function makeLaunchConfig(permissions?: AgentLaunchConfig["permissions"]): AgentLaunchConfig {
  return {
    sessionId: "sess-1",
    permissions,
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
});

describe("antigravity getEnvironment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("performs recursive copy of .gemini directory and skips tmp, history, and browser profile", () => {
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

    expect(mockCopyFileSync).toHaveBeenCalledWith(
      path.join("/Users/mockuser", ".gemini", "valid-subdir", "config.json"),
      path.join("/Users/mockuser", ".ao-sessions", "sess-1", ".gemini", "valid-subdir", "config.json")
    );

    const allCopiedDests = mockCopyFileSync.mock.calls.map((call) => call[1] as string);
    const hasTmp = allCopiedDests.some((dest) => dest.includes("tmp"));
    const hasHistory = allCopiedDests.some((dest) => dest.includes("history"));
    const hasProfile = allCopiedDests.some((dest) => dest.includes("antigravity-browser-profile"));

    expect(hasTmp).toBe(false);
    expect(hasHistory).toBe(false);
    expect(hasProfile).toBe(false);
  });

  it("skips symlinks during recursive copy", () => {
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
});
