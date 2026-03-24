import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createSessionManager } from "../session-manager.js";
import {
  type OrchestratorConfig,
  type PluginRegistry,
  type Runtime,
  type Agent,
  type Workspace,
} from "../types.js";

type ExecFileAsync = (
  file: string,
  args?: readonly string[],
  opts?: object,
) => Promise<{ stdout: string; stderr: string }>;

let tmpDir: string;
let configPath: string;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockWorkspace: Workspace;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;
let mockExecFile: ExecFileAsync;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-test-prune-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects:\n", "utf8");

  mockRuntime = {
    name: "mock",
    create: vi.fn().mockResolvedValue({ id: "rt-1", runtimeName: "mock", data: {} }),
    destroy: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getOutput: vi.fn().mockResolvedValue(""),
    isAlive: vi.fn().mockResolvedValue(true),
  };

  mockAgent = {
    name: "mock-agent",
    processName: "mock",
    getLaunchCommand: vi.fn().mockReturnValue("mock-agent --start"),
    getEnvironment: vi.fn().mockReturnValue({}),
    detectActivity: vi.fn().mockReturnValue("active"),
    getActivityState: vi.fn().mockResolvedValue({ state: "active" }),
    isProcessRunning: vi.fn().mockResolvedValue(true),
    getSessionInfo: vi.fn().mockResolvedValue(null),
  };

  mockWorkspace = {
    name: "mock-ws",
    create: vi.fn().mockResolvedValue({
      path: join(tmpDir, "my-app"),
      branch: "feat/TEST-1",
      sessionId: "app-1",
      projectId: "my-app",
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  };

  mockRegistry = {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string) => {
      if (slot === "runtime") return mockRuntime;
      if (slot === "agent") return mockAgent;
      if (slot === "workspace") return mockWorkspace;
      return null;
    }),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn().mockResolvedValue(undefined),
    loadFromConfig: vi.fn().mockResolvedValue(undefined),
  };

  config = {
    configPath,
    port: 3000,
    defaults: {
      runtime: "mock",
      agent: "mock-agent",
      workspace: "mock-ws",
      notifiers: ["desktop"],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: join(tmpDir, "my-app"),
        defaultBranch: "main",
        sessionPrefix: "app",
        scm: { plugin: "github" },
        tracker: { plugin: "github" },
        configPath,
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
    readyThresholdMs: 300_000,
  };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  // Clean up worktrees directories (live under ~/.worktrees, outside tmpDir)
  for (const projectId of Object.keys(config.projects)) {
    const wd = join(homedir(), ".worktrees", projectId);
    if (existsSync(wd)) rmSync(wd, { recursive: true, force: true });
  }
});

describe("pruneStaleWorktrees", () => {
  it("removes worktrees with dead tmux sessions", async () => {
    const worktreesDir = join(homedir(), ".worktrees", "my-app");
    mkdirSync(worktreesDir, { recursive: true });

    const staleWorktree = join(worktreesDir, "ao-999");
    mkdirSync(staleWorktree, { recursive: true });
    mkdirSync(config.projects["my-app"]!.path, { recursive: true });

    mockExecFile = async (cmd: string, args?: readonly string[]) => {
      if (cmd === "tmux" && args?.[0] === "has-session") {
        return Promise.reject(new Error("no server"));
      }
      if (cmd === "git" && args?.[0] === "-C") {
        return Promise.resolve([config.projects["my-app"]!.path, ""]);
      }
      if (cmd === "git" && args?.[0] === "worktree") {
        return Promise.reject(new Error("path not found"));
      }
      return Promise.resolve(["", ""]);
    };

    const sm = createSessionManager({ config, registry: mockRegistry, execFileAsync: mockExecFile });
    await sm.pruneStaleWorktrees();

    expect(existsSync(staleWorktree)).toBe(false);
  });

  it("preserves worktrees with alive tmux sessions", async () => {
    const worktreesDir = join(homedir(), ".worktrees", "my-app");
    mkdirSync(worktreesDir, { recursive: true });

    const liveWorktree = join(worktreesDir, "ao-888");
    mkdirSync(liveWorktree, { recursive: true });

    mockExecFile = async (cmd: string, args?: readonly string[]) => {
      if (cmd === "tmux" && args?.[0] === "has-session") {
        return Promise.resolve(["", ""]);
      }
      return Promise.resolve(["", ""]);
    };

    const sm = createSessionManager({ config, registry: mockRegistry, execFileAsync: mockExecFile });
    await sm.pruneStaleWorktrees();

    expect(existsSync(liveWorktree)).toBe(true);
  });

  it("skips non-AO worktrees (human-created, wrong naming pattern)", async () => {
    const worktreesDir = join(homedir(), ".worktrees", "my-app");
    mkdirSync(worktreesDir, { recursive: true });

    const humanWorktree = join(worktreesDir, "feature-foo");
    mkdirSync(humanWorktree, { recursive: true });

    let execFileCalls: string[] = [];
    mockExecFile = async (cmd: string) => {
      execFileCalls.push(cmd);
      return Promise.resolve(["", ""]);
    };

    const sm = createSessionManager({ config, registry: mockRegistry, execFileAsync: mockExecFile });
    await sm.pruneStaleWorktrees();

    expect(existsSync(humanWorktree)).toBe(true);
    // No tmux calls should have been made for the non-AO worktree
    expect(execFileCalls.filter((c) => c === "tmux").length).toBe(0);
  });

  it("uses full tmux session name (with hash prefix) for has-session check", async () => {
    const worktreesDir = join(homedir(), ".worktrees", "my-app");
    mkdirSync(worktreesDir, { recursive: true });

    const staleWorktree = join(worktreesDir, "ao-999");
    mkdirSync(staleWorktree, { recursive: true });
    mkdirSync(config.projects["my-app"]!.path, { recursive: true });

    let capturedTmuxName: string | undefined;
    mockExecFile = async (cmd: string, args?: readonly string[]) => {
      if (cmd === "tmux" && args?.[0] === "has-session") {
        capturedTmuxName = args?.[2];
        return Promise.reject(new Error("no server"));
      }
      if (cmd === "git" && args?.[0] === "-C") {
        return Promise.resolve([config.projects["my-app"]!.path, ""]);
      }
      if (cmd === "git" && args?.[0] === "worktree") {
        return Promise.reject(new Error("path not found"));
      }
      return Promise.resolve(["", ""]);
    };

    const sm = createSessionManager({ config, registry: mockRegistry, execFileAsync: mockExecFile });
    await sm.pruneStaleWorktrees();

    // The tmux session name MUST include the 12-char hash prefix (e.g. "aabbccddeeff-ao-999")
    // It must NOT be just "ao-999" (the bare worktree name — that was the bug)
    expect(capturedTmuxName).toBeDefined();
    expect(capturedTmuxName!).toMatch(/^[a-f0-9]{12}-ao-999$/);
    expect(existsSync(staleWorktree)).toBe(false);
  });

  it("skips worktrees whose project is not in config", async () => {
    // Create a worktree under a project not in config.projects
    const otherProjectDir = join(homedir(), ".worktrees", "other-project");
    mkdirSync(otherProjectDir, { recursive: true });
    const orphanedWorktree = join(otherProjectDir, "ao-777");
    mkdirSync(orphanedWorktree, { recursive: true });

    let execFileCalls: string[] = [];
    mockExecFile = async (cmd: string) => {
      execFileCalls.push(cmd);
      return Promise.resolve(["", ""]);
    };

    const sm = createSessionManager({ config, registry: mockRegistry, execFileAsync: mockExecFile });
    await sm.pruneStaleWorktrees();

    // Worktree should NOT be removed (project not in config → skipped)
    expect(existsSync(orphanedWorktree)).toBe(true);
    // No execFile calls should have been made (project not in config)
    expect(execFileCalls.length).toBe(0);
  });
});
