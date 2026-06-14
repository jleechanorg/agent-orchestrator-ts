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

describe("antigravity trustedFolders.json lock acquisition", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("skips writing global trustedFolders.json if lock acquisition times out to prevent clobbering", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    mockLstatSync.mockReset();
    mockUnlinkSync.mockReset();
    mockSymlinkSync.mockReset();
    mockWriteFileSync.mockReset();

    // Mock existsSync for lockPath so it always exists, simulating a timed out lock
    mockExistsSync.mockImplementation((filepath) => {
      if (typeof filepath === "string" && filepath.endsWith("trustedFolders.lock")) {
        return true;
      }
      return false;
    });

    // Mock writeFileSync to throw EEXIST when trying to acquire the lock
    mockWriteFileSync.mockImplementation((filepath) => {
      if (typeof filepath === "string" && filepath.endsWith("trustedFolders.lock")) {
        const err = new Error("mocked EEXIST") as NodeJS.ErrnoException;
        err.code = "EEXIST";
        throw err;
      }
    });

    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env).toBeDefined();

    // Verify that global trustedFolders.json was NOT written because lock timed out
    const globalPath = path.join("/Users/mockuser", ".gemini", "trustedFolders.json");
    const writtenPaths = mockWriteFileSync.mock.calls.map((call) => call[0] as string);
    expect(writtenPaths).not.toContain(globalPath);
  }, 15000);

  it("asserts an old holder cannot release a successor's lock if ownership has changed", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    mockLstatSync.mockReset();
    mockUnlinkSync.mockReset();
    mockSymlinkSync.mockReset();
    mockWriteFileSync.mockReset();
    mockReadFileSync.mockReset();

    // The lock is successfully acquired by our process initially
    let lockPathExists = false;
    mockExistsSync.mockImplementation((filepath) => {
      if (typeof filepath === "string" && filepath.endsWith("trustedFolders.lock")) {
        return lockPathExists;
      }
      if (typeof filepath === "string" && filepath.endsWith("trustedFolders.json")) {
        return true;
      }
      return false;
    });

    mockWriteFileSync.mockImplementation((filepath, _content) => {
      if (typeof filepath === "string" && filepath.endsWith("trustedFolders.lock")) {
        lockPathExists = true;
      }
    });

    mockReadFileSync.mockImplementation((filepath) => {
      if (typeof filepath === "string" && filepath.endsWith("trustedFolders.lock")) {
        // Simulate a successor process stealing/updating the lock with their PID
        return "99999";
      }
      return "{}";
    });

    // Run getEnvironment which will acquire the lock, write trustedFolders, and then release lock
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env).toBeDefined();

    // Since the lock file content was mocked to be "99999" (not process.pid),
    // releaseLock should NOT have unlinked the lockPath.
    const unlinkedPaths = mockUnlinkSync.mock.calls.map((call) => call[0] as string);
    const globalLockPath = path.join("/Users/mockuser", ".gemini", "trustedFolders.lock");
    expect(unlinkedPaths).not.toContain(globalLockPath);
  });
});
