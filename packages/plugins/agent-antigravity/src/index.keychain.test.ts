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

describe("antigravity Library/Keychains symlink (Darwin)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("always symlinks Library/Keychains to the real user keychains on Darwin, even in headless mode", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");
    mockPlatform.mockReturnValue("darwin");

    mockLstatSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env).toBeDefined();

    expect(mockMkdirSync).toHaveBeenCalledWith(
      path.join("/Users/mockuser", ".ao-sessions", "sess-1", "Library"),
      { recursive: true }
    );
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      "/Users/mockuser/Library/Keychains",
      path.join("/Users/mockuser", ".ao-sessions", "sess-1", "Library", "Keychains")
    );
  });

  it("does not recreate the symlink if it already exists and points to the correct target", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");
    mockPlatform.mockReturnValue("darwin");

    mockLstatSync.mockImplementation(() => ({
      isSymbolicLink: () => true,
      isDirectory: () => false,
    }));
    mockReadlinkSync.mockReturnValue("/Users/mockuser/Library/Keychains");

    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env).toBeDefined();

    const keychainCalls = mockSymlinkSync.mock.calls.filter(call => call[1].includes("Keychains"));
    expect(keychainCalls.length).toBe(0);
    const keychainUnlinks = mockUnlinkSync.mock.calls.filter(call => call[0].includes("Keychains"));
    expect(keychainUnlinks.length).toBe(0);
  });

  it("recreates the symlink if it points to an incorrect target", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");
    mockPlatform.mockReturnValue("darwin");

    mockLstatSync.mockImplementation(() => ({
      isSymbolicLink: () => true,
      isDirectory: () => false,
    }));
    mockReadlinkSync.mockReturnValue("/wrong/path");

    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env).toBeDefined();

    expect(mockUnlinkSync).toHaveBeenCalledWith(
      path.join("/Users/mockuser", ".ao-sessions", "sess-1", "Library", "Keychains")
    );
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      "/Users/mockuser/Library/Keychains",
      path.join("/Users/mockuser", ".ao-sessions", "sess-1", "Library", "Keychains")
    );
  });

  it("removes a real directory and creates the symlink if the path exists but is not a symlink", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");
    mockPlatform.mockReturnValue("darwin");

    mockLstatSync.mockImplementation(() => ({
      isSymbolicLink: () => false,
      isDirectory: () => true,
    }));

    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env).toBeDefined();

    const sessionKeychainDir = path.join(
      "/Users/mockuser", ".ao-sessions", "sess-1", "Library", "Keychains"
    );
    expect(mockRmSync).toHaveBeenCalledWith(sessionKeychainDir, {
      recursive: true,
      force: true,
    });
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      "/Users/mockuser/Library/Keychains",
      sessionKeychainDir
    );
  });

  it("respects process.env.AO_ORIGINAL_HOME as the base user home if set", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");
    mockPlatform.mockReturnValue("darwin");

    const originalAOOriginalHome = process.env.AO_ORIGINAL_HOME;
    process.env.AO_ORIGINAL_HOME = "/Users/custom-original-home";

    mockLstatSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    try {
      const env = agent.getEnvironment(makeLaunchConfig());
      expect(env).toBeDefined();

      expect(mockMkdirSync).toHaveBeenCalledWith(
        path.join("/Users/custom-original-home", ".ao-sessions", "sess-1", "Library"),
        { recursive: true }
      );
      expect(mockSymlinkSync).toHaveBeenCalledWith(
        "/Users/custom-original-home/Library/Keychains",
        path.join("/Users/custom-original-home", ".ao-sessions", "sess-1", "Library", "Keychains")
      );
    } finally {
      if (originalAOOriginalHome === undefined) {
        delete process.env.AO_ORIGINAL_HOME;
      } else {
        process.env.AO_ORIGINAL_HOME = originalAOOriginalHome;
      }
    }
  });
});

describe("antigravity Playwright cache symlink", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("symlinks ms-playwright-go and ms-playwright if they exist in the user home", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");
    mockPlatform.mockReturnValue("darwin");

    // Simulate that the real cache dirs exist on host
    mockExistsSync.mockImplementation((p) => {
      if (typeof p === "string" && p.includes("/Users/mockuser/Library/Caches/ms-playwright")) {
        return true;
      }
      return false;
    });

    mockLstatSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env).toBeDefined();

    // Verify ms-playwright-go and ms-playwright symlinks are attempted for existing ones
    expect(mockMkdirSync).toHaveBeenCalledWith(
      path.join("/Users/mockuser", ".ao-sessions", "sess-1", "Library", "Caches"),
      { recursive: true }
    );
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      "/Users/mockuser/Library/Caches/ms-playwright-go",
      path.join("/Users/mockuser", ".ao-sessions", "sess-1", "Library", "Caches", "ms-playwright-go")
    );
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      "/Users/mockuser/Library/Caches/ms-playwright",
      path.join("/Users/mockuser", ".ao-sessions", "sess-1", "Library", "Caches", "ms-playwright")
    );
  });

  it("uses ~/.cache instead of Library/Caches on Linux", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/home/mockuser");
    mockPlatform.mockReturnValue("linux");

    // Simulate that the real cache dirs exist on host, under the Linux cache root
    mockExistsSync.mockImplementation((p) => {
      if (typeof p === "string" && p.includes("/home/mockuser/.cache/ms-playwright")) {
        return true;
      }
      return false;
    });

    mockLstatSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env).toBeDefined();

    expect(mockMkdirSync).toHaveBeenCalledWith(
      path.join("/home/mockuser", ".ao-sessions", "sess-1", ".cache"),
      { recursive: true }
    );
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      "/home/mockuser/.cache/ms-playwright-go",
      path.join("/home/mockuser", ".ao-sessions", "sess-1", ".cache", "ms-playwright-go")
    );
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      "/home/mockuser/.cache/ms-playwright",
      path.join("/home/mockuser", ".ao-sessions", "sess-1", ".cache", "ms-playwright")
    );

    // Darwin-only Keychains symlink must not be attempted on Linux.
    const keychainCalls = mockSymlinkSync.mock.calls.filter(
      (call) => typeof call[1] === "string" && call[1].includes("Keychains")
    );
    expect(keychainCalls.length).toBe(0);
  });
});

