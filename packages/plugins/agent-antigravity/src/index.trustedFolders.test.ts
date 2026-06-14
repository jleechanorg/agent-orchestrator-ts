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

describe("antigravity getEnvironment trustedFolders.json", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("automatically trusts the launchConfig project workspace path in both the session-specific and global trustedFolders.json", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    mockLstatSync.mockReset();
    mockUnlinkSync.mockReset();
    mockSymlinkSync.mockReset();

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

    const sessionPath = path.join("/Users/mockuser", ".ao-sessions", "sess-1", ".gemini", "trustedFolders.json");
    const globalPath = path.join("/Users/mockuser", ".gemini", "trustedFolders.json");

    expect(writtenFiles.has(sessionPath)).toBe(true);
    expect(writtenFiles.has(globalPath)).toBe(true);

    const sessionContent = JSON.parse(writtenFiles.get(sessionPath) || "{}");
    const globalContent = JSON.parse(writtenFiles.get(globalPath) || "{}");

    expect(sessionContent["/workspace/repo"]).toBe("TRUST_FOLDER");
    expect(globalContent["/workspace/repo"]).toBe("TRUST_FOLDER");
    expect(sessionContent["/workspace/distinct-workspace-path"]).toBe("TRUST_FOLDER");
    expect(globalContent["/workspace/distinct-workspace-path"]).toBe("TRUST_FOLDER");
  });

  it("handles malformed (null/array) settings.json and trustedFolders.json gracefully without throwing or writing invalid data", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    mockLstatSync.mockReset();
    mockUnlinkSync.mockReset();
    mockSymlinkSync.mockReset();

    mockExistsSync.mockImplementation((filepath) => {
      if (typeof filepath !== "string") return false;
      // The OUTER settings.json (the one the agent plugin reads at line 181) is malformed
      // and exists; the inner antigravity-cli/settings.json is intentionally absent in
      // this test so the pre-seed path is skipped.
      if (filepath === path.join("/Users/mockuser", ".gemini", "settings.json")) return true;
      if (filepath.endsWith("trustedFolders.json")) return true;
      return false;
    });

    // Mock settings.json as null and trustedFolders.json as array to check robustness
    mockReadFileSync.mockImplementation((filepath) => {
      if (typeof filepath === "string") {
        if (filepath === path.join("/Users/mockuser", ".gemini", "settings.json")) {
          return "null";
        }
        if (filepath.endsWith("trustedFolders.json")) return "[]";
      }
      return "{}";
    });

    let writtenTrustedFolders = "";
    let writtenOuterSettings = "";
    mockWriteFileSync.mockImplementation((filepath, content) => {
      if (typeof filepath !== "string") return;
      if (filepath.endsWith("trustedFolders.json")) {
        writtenTrustedFolders = content as string;
      } else if (filepath === path.join("/Users/mockuser", ".ao-sessions", "sess-1", ".gemini", "settings.json")) {
        writtenOuterSettings = content as string;
      }
    });

    expect(() => agent.getEnvironment(makeLaunchConfig())).not.toThrow();

    // Verify that the OUTER settings.json was not written because it was malformed (null)
    expect(writtenOuterSettings).toBe("");

    // Verify that trustedFolders.json was written as a correct plain object and NOT an array
    expect(writtenTrustedFolders).toContain("/workspace/repo");
    const parsedFolders = JSON.parse(writtenTrustedFolders);
    expect(parsedFolders).not.toBeNull();
    expect(Array.isArray(parsedFolders)).toBe(false);
    expect(parsedFolders["/workspace/repo"]).toBe("TRUST_FOLDER");
  });

  it("does not write to trustedFolders.json on parse failure to prevent clobbering", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    mockLstatSync.mockReset();
    mockUnlinkSync.mockReset();
    mockSymlinkSync.mockReset();
    mockWriteFileSync.mockReset();

    mockExistsSync.mockImplementation((filepath) => {
      if (typeof filepath === "string") {
        if (filepath.endsWith("settings.json")) return false;
        if (filepath.endsWith("trustedFolders.json")) return true;
      }
      return false;
    });

    // Mock trustedFolders.json with syntax error to cause parse failure
    mockReadFileSync.mockImplementation((filepath) => {
      if (typeof filepath === "string" && filepath.endsWith("trustedFolders.json")) {
        return "{invalid-json";
      }
      return "{}";
    });

    let writtenTrustedFolders = "";
    mockWriteFileSync.mockImplementation((filepath, content) => {
      if (typeof filepath === "string" && filepath.endsWith("trustedFolders.json")) {
        writtenTrustedFolders = content as string;
      }
    });

    expect(() => agent.getEnvironment(makeLaunchConfig())).not.toThrow();

    // Verify that trustedFolders.json was NOT written due to parse failure
    expect(writtenTrustedFolders).toBe("");
  });

  it("expands tilde (~) in projectConfig.path and workspacePath when writing trustedFolders.json", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    mockLstatSync.mockReset();
    mockUnlinkSync.mockReset();
    mockSymlinkSync.mockReset();

    const writtenFiles = new Map<string, string>();
    mockWriteFileSync.mockImplementation((filepath, content) => {
      if (typeof filepath === "string") {
        writtenFiles.set(filepath, content as string);
      }
    });

    const env = agent.getEnvironment({
      ...makeLaunchConfig(),
      projectConfig: {
        ...makeLaunchConfig().projectConfig,
        path: "~/project-tilde-path",
      },
      workspacePath: "~",
    });
    expect(env).toBeDefined();

    const sessionPath = path.join("/Users/mockuser", ".ao-sessions", "sess-1", ".gemini", "trustedFolders.json");
    const globalPath = path.join("/Users/mockuser", ".gemini", "trustedFolders.json");

    expect(writtenFiles.has(sessionPath)).toBe(true);
    expect(writtenFiles.has(globalPath)).toBe(true);

    const sessionContent = JSON.parse(writtenFiles.get(sessionPath) || "{}");
    const globalContent = JSON.parse(writtenFiles.get(globalPath) || "{}");

    // The tilde paths must be expanded to the user's home directory
    expect(sessionContent["/Users/mockuser/project-tilde-path"]).toBe("TRUST_FOLDER");
    expect(globalContent["/Users/mockuser/project-tilde-path"]).toBe("TRUST_FOLDER");
    expect(sessionContent["/Users/mockuser"]).toBe("TRUST_FOLDER");
    expect(globalContent["/Users/mockuser"]).toBe("TRUST_FOLDER");

    // Literal tilde paths should NOT be present
    expect(sessionContent["~/project-tilde-path"]).toBeUndefined();
    expect(globalContent["~/project-tilde-path"]).toBeUndefined();
    expect(sessionContent["~"]).toBeUndefined();
    expect(globalContent["~"]).toBeUndefined();
  });
});
