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

  it("sets COLIMA_HOME and DOCKER_HOST to the user's real home so subprocess colima/docker calls reuse the main colima", () => {
    // Without this, any subprocess in the worker that calls `colima start` or
    // `docker compose up` would derive COLIMA_HOME from the overridden session
    // HOME (= ~/.ao-sessions/<id>) and bootstrap a fresh per-worker VM there
    // (~2GB each, accumulating to dozens of stale VMs over time).
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");
    mockPlatform.mockReturnValue("darwin");

    const env = agent.getEnvironment(makeLaunchConfig());

    expect(env.COLIMA_HOME).toBe(path.join("/Users/mockuser", ".colima"));
    expect(env.DOCKER_HOST).toBe(
      `unix://${path.join("/Users/mockuser", ".colima", "default", "docker.sock")}`
    );
  });

  it("does NOT set DOCKER_HOST on Linux to avoid breaking native Docker", () => {
    // Colima is darwin-only. On Linux, the user has native Docker with a
    // different default socket (/var/run/docker.sock); unconditionally
    // pointing DOCKER_HOST at the colima socket would break every docker
    // call. COLIMA_HOME is harmless on Linux (colima doesn't read it) so we
    // still set it as a stable, predictable default.
    const agent = create();
    mockHomedir.mockReturnValue("/home/linuxuser");
    mockPlatform.mockReturnValue("linux");

    const env = agent.getEnvironment(makeLaunchConfig());

    expect(env.COLIMA_HOME).toBe(path.join("/home/linuxuser", ".colima"));
    expect(env.DOCKER_HOST).toBeUndefined();
  });

  it("preserves user-supplied COLIMA_HOME and DOCKER_HOST from process.env", () => {
    // The runtime layer applies config.environment ON TOP of process.env at
    // spawn time (`{ ...process.env, ...config.environment }` for the process
    // runtime, `tmux -e KEY=VALUE` per-key for the tmux runtime). So if the
    // plugin unconditionally sets these in its getEnvironment return, it
    // clobbers whatever the user set in their shell. The plugin must read
    // process.env first so a user-supplied value survives.
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");
    mockPlatform.mockReturnValue("darwin");

    const originalColimaHome = process.env.COLIMA_HOME;
    const originalDockerHost = process.env.DOCKER_HOST;
    process.env.COLIMA_HOME = "/custom/colima";
    process.env.DOCKER_HOST = "unix:///custom/docker.sock";

    try {
      const env = agent.getEnvironment(makeLaunchConfig());
      expect(env.COLIMA_HOME).toBe("/custom/colima");
      expect(env.DOCKER_HOST).toBe("unix:///custom/docker.sock");
    } finally {
      if (originalColimaHome === undefined) delete process.env.COLIMA_HOME;
      else process.env.COLIMA_HOME = originalColimaHome;
      if (originalDockerHost === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = originalDockerHost;
    }
  });

  it("preserves an empty-string DOCKER_HOST override (uses 'in' check, not truthiness)", () => {
    // Skeptic Gate-5 follow-up: truthiness (`if (process.env.DOCKER_HOST)`)
    // would coerce DOCKER_HOST="" to "unset" and silently fall back to the
    // colima default on darwin. An empty string is a meaningful override
    // (a user may set it to signal "no socket, fall back to native docker
    // socket selection"). The fix uses `"DOCKER_HOST" in process.env` so
    // presence — not truthiness — determines whether to honor the override.
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");
    mockPlatform.mockReturnValue("darwin");

    const originalColimaHome = process.env.COLIMA_HOME;
    const originalDockerHost = process.env.DOCKER_HOST;
    delete process.env.COLIMA_HOME;
    process.env.DOCKER_HOST = "";

    try {
      const env = agent.getEnvironment(makeLaunchConfig());
      // Empty string preserved verbatim, NOT replaced with the colima default.
      expect("DOCKER_HOST" in env).toBe(true);
      expect(env.DOCKER_HOST).toBe("");
      expect(env.DOCKER_HOST).not.toContain("colima");
    } finally {
      if (originalColimaHome === undefined) delete process.env.COLIMA_HOME;
      else process.env.COLIMA_HOME = originalColimaHome;
      if (originalDockerHost === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = originalDockerHost;
    }
  });

  it("preserves an empty-string COLIMA_HOME override (uses ??, not truthiness)", () => {
    // Same Skeptic Gate-5 follow-up applied to COLIMA_HOME: the `??` chain
    // only falls through on null/undefined, so COLIMA_HOME="" is preserved
    // rather than coerced to the default ~/.colima.
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");
    mockPlatform.mockReturnValue("darwin");

    const originalColimaHome = process.env.COLIMA_HOME;
    const originalDockerHost = process.env.DOCKER_HOST;
    process.env.COLIMA_HOME = "";
    delete process.env.DOCKER_HOST;

    try {
      const env = agent.getEnvironment(makeLaunchConfig());
      expect(env.COLIMA_HOME).toBe("");
      expect(env.COLIMA_HOME).not.toContain(".colima");
    } finally {
      if (originalColimaHome === undefined) delete process.env.COLIMA_HOME;
      else process.env.COLIMA_HOME = originalColimaHome;
      if (originalDockerHost === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = originalDockerHost;
    }
  });

  it("omits DOCKER_HOST key entirely on Linux so the runtime does not serialize it as 'DOCKER_HOST=undefined'", () => {
    // Skeptic Gate-8 follow-up: Object.entries(env) includes keys with
    // undefined values, and the runtime layer (tmux `-e KEY=VALUE` /
    // child-process env) stringifies them as the literal "undefined". On
    // Linux that produces `DOCKER_HOST=undefined`, which breaks native
    // Docker (`docker` reads DOCKER_HOST and tries to dial "undefined" as a
    // socket). The plugin must not return the key at all on Linux when
    // there is no user override.
    const agent = create();
    mockHomedir.mockReturnValue("/home/linuxuser");
    mockPlatform.mockReturnValue("linux");

    const originalDockerHost = process.env.DOCKER_HOST;
    delete process.env.DOCKER_HOST;

    try {
      const env = agent.getEnvironment(makeLaunchConfig());
      // Assert the KEY is absent, not just the value being undefined.
      expect("DOCKER_HOST" in env).toBe(false);
      // Defense in depth: assert Object.entries (which is what the runtime
      // iterates) does not see the key.
      const runtimeView = Object.fromEntries(
        Object.entries(env).filter(([, v]) => v !== undefined),
      );
      expect("DOCKER_HOST" in runtimeView).toBe(false);
    } finally {
      if (originalDockerHost !== undefined) process.env.DOCKER_HOST = originalDockerHost;
    }
  });

  it("derives the darwin DOCKER_HOST default from the resolved COLIMA_HOME, not the user home, when COLIMA_HOME is overridden", () => {
    // Skeptic Gate-7 follow-up: if a user supplies COLIMA_HOME via process.env
    // but NOT DOCKER_HOST, the plugin used to set DOCKER_HOST to
    // `unix://${userHome}/.colima/default/docker.sock` (the real home) while
    // COLIMA_HOME pointed to the custom location. That creates a path
    // mismatch where docker dials the wrong socket. The fix: resolve
    // `colimaHome` once and use it for both keys.
    const agent = create();
    mockHomedir.mockReturnValue("/Users/mockuser");
    mockPlatform.mockReturnValue("darwin");

    const originalColimaHome = process.env.COLIMA_HOME;
    const originalDockerHost = process.env.DOCKER_HOST;
    process.env.COLIMA_HOME = "/opt/my-colima";
    delete process.env.DOCKER_HOST;

    try {
      const env = agent.getEnvironment(makeLaunchConfig());
      expect(env.COLIMA_HOME).toBe("/opt/my-colima");
      expect(env.DOCKER_HOST).toBe(
        `unix://${path.join("/opt/my-colima", "default", "docker.sock")}`,
      );
    } finally {
      if (originalColimaHome === undefined) delete process.env.COLIMA_HOME;
      else process.env.COLIMA_HOME = originalColimaHome;
      if (originalDockerHost === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = originalDockerHost;
    }
  });
});

