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
  mockReadFileSync,
  mockWriteFileSync,
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
  mockReadFileSync: vi.fn(() => "{}"),
  mockWriteFileSync: vi.fn(),
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
  const actual = await importOriginal() as any;
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
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
  },
  mkdirSync: mockMkdirSync,
  existsSync: mockExistsSync,
  lstatSync: mockLstatSync,
  readdirSync: mockReaddirSync,
  copyFileSync: mockCopyFileSync,
  symlinkSync: mockSymlinkSync,
  unlinkSync: mockUnlinkSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
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

    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env).toBeDefined();

    const sessionPath = path.join("/Users/mockuser", ".ao-sessions", "sess-1", ".gemini", "trustedFolders.json");
    const globalPath = path.join("/Users/mockuser", ".gemini", "trustedFolders.json");

    expect(writtenFiles.has(sessionPath)).toBe(true);
    expect(writtenFiles.has(globalPath)).toBe(true);

    const sessionContent = JSON.parse(writtenFiles.get(sessionPath) || "{}");
    const globalContent = JSON.parse(writtenFiles.get(globalPath) || "{}");

    expect(sessionContent["/workspace/repo"]).toBe("TRUST_FOLDER");
    expect(globalContent["/workspace/repo"]).toBe("TRUST_FOLDER");
  });


  it("handles malformed (null/array) settings.json and trustedFolders.json gracefully without throwing or writing invalid data", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");

    mockLstatSync.mockReset();
    mockUnlinkSync.mockReset();
    mockSymlinkSync.mockReset();

    mockExistsSync.mockImplementation((filepath) => {
      if (typeof filepath === "string") {
        if (filepath.endsWith("settings.json")) return true;
        if (filepath.endsWith("trustedFolders.json")) return true;
      }
      return false;
    });

    // Mock settings.json as null and trustedFolders.json as array to check robustness
    mockReadFileSync.mockImplementation((filepath) => {
      if (typeof filepath === "string") {
        if (filepath.endsWith("settings.json")) return "null";
        if (filepath.endsWith("trustedFolders.json")) return "[]";
      }
      return "{}";
    });

    let writtenTrustedFolders = "";
    let writtenSettings = "";
    mockWriteFileSync.mockImplementation((filepath, content) => {
      if (typeof filepath === "string") {
        if (filepath.endsWith("trustedFolders.json")) {
          writtenTrustedFolders = content as string;
        } else if (filepath.endsWith("settings.json")) {
          writtenSettings = content as string;
        }
      }
    });

    expect(() => agent.getEnvironment(makeLaunchConfig())).not.toThrow();

    // Verify that settings.json was not written because it was malformed (null)
    expect(writtenSettings).toBe("");

    // Verify that trustedFolders.json was written as a correct plain object and NOT an array
    expect(writtenTrustedFolders).toContain("/workspace/repo");
    const parsedFolders = JSON.parse(writtenTrustedFolders);
    expect(parsedFolders).not.toBeNull();
    expect(Array.isArray(parsedFolders)).toBe(false);
    expect(parsedFolders["/workspace/repo"]).toBe("TRUST_FOLDER");
  });

  it("ensures no keychain symlinks or mutations in headless mode and fails closed if removal fails", () => {
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");
    mockPlatform.mockReturnValue("darwin");

    // Force headless mode via env override and clearing TTY/SSH env variables
    const originalEnv = { ...process.env };
    process.env.AO_HEADLESS = "true";
    process.env.AO_INTERACTIVE = "false";
    delete process.env.TERM_PROGRAM;
    delete process.env.COLORTERM;
    delete process.env.SSH_TTY;
    delete process.env.SSH_CLIENT;
    delete process.env.SSH_CONNECTION;

    try {
      // 1. Success case: verifies no security commands are run and existing symlink is removed
      mockExecFileSync.mockReset();
      mockSymlinkSync.mockReset();
      mockUnlinkSync.mockReset();
      
      mockLstatSync.mockImplementation(() => ({
        isSymbolicLink: () => true,
      } as any));
      mockExistsSync.mockImplementation(() => true);

      const env = agent.getEnvironment(makeLaunchConfig());
      expect(env).toBeDefined();

      // No security default-keychain or create-keychain should be called
      expect(mockExecFileSync).not.toHaveBeenCalled();
      // The symlink should be unlinked
      expect(mockUnlinkSync).toHaveBeenCalled();

      // 2. Failure/Fail-Closed case: if unlink fails, we throw an error (fail-closed)
      mockUnlinkSync.mockImplementation((filepath) => {
        console.log("mockUnlinkSync called with:", filepath);
        if (typeof filepath === "string" && filepath.includes("Keychains")) {
          throw new Error("mocked unlink failure");
        }
      });

      expect(() => agent.getEnvironment(makeLaunchConfig())).toThrow(
        /Headless safety check failed/
      );
    } finally {
      process.env = originalEnv;
    }
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
        const err = new Error("mocked EEXIST") as any;
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
});
