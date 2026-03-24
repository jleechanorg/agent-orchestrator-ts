import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
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

type MockReadMeta = (
  dataDir: string,
  sessionId: string,
) => Record<string, string> | null;

let tmpDir: string;
let configPath: string;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockWorkspace: Workspace;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;
let mockExecFile: ExecFileAsync;

// Per-test session data for readMetadataRaw injection
let mockMeta: Record<string, Record<string, string> | null>;

function clearMockMeta() {
  for (const k of Object.keys(mockMeta)) delete mockMeta[k];
}

function setMockMeta(sessionId: string, data: Record<string, string>) {
  mockMeta[sessionId] = data;
}

function makeReadMeta(mock: typeof mockMeta): MockReadMeta {
  return (_dataDir: string, sessionId: string) => mock[sessionId] ?? null;
}

beforeEach(() => {
  mockMeta = {};

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
  clearMockMeta();
  for (const projectId of Object.keys(config.projects)) {
    const wd = join(homedir(), ".worktrees", projectId);
    if (existsSync(wd)) rmSync(wd, { recursive: true, force: true });
  }
  rmSync(tmpDir, { recursive: true, force: true });
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
        return Promise.resolve({ stdout: config.projects["my-app"]!.path, stderr: "" });
      }
      if (cmd === "git" && args?.[0] === "worktree") {
        return Promise.reject(new Error("path not found"));
      }
      return Promise.resolve({ stdout: "", stderr: "" });
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
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
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

    const execFileCalls: string[] = [];
    mockExecFile = async (cmd: string) => {
      execFileCalls.push(cmd);
      return Promise.resolve({ stdout: "", stderr: "" });
    };

    const sm = createSessionManager({ config, registry: mockRegistry, execFileAsync: mockExecFile });
    await sm.pruneStaleWorktrees();

    expect(existsSync(humanWorktree)).toBe(true);
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
        return Promise.resolve({ stdout: config.projects["my-app"]!.path, stderr: "" });
      }
      if (cmd === "git" && args?.[0] === "worktree") {
        return Promise.reject(new Error("path not found"));
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    };

    const sm = createSessionManager({ config, registry: mockRegistry, execFileAsync: mockExecFile });
    await sm.pruneStaleWorktrees();

    expect(capturedTmuxName).toBeDefined();
    expect(capturedTmuxName!).toMatch(/^[a-f0-9]{12}-ao-999$/);
    expect(existsSync(staleWorktree)).toBe(false);
  });

  it("skips worktrees whose project is not in config", async () => {
    const otherProjectDir = join(homedir(), ".worktrees", "other-project");
    mkdirSync(otherProjectDir, { recursive: true });
    const orphanedWorktree = join(otherProjectDir, "ao-777");
    mkdirSync(orphanedWorktree, { recursive: true });

    // Pass 2 iterates config.projects (my-app only), not ~/.worktrees/ project names.
    // So no tmux/git calls targeting other-project should happen.
    const otherProjectCalls: string[] = [];
    mockExecFile = async (cmd: string, args?: readonly string[]) => {
      if (args && args.some((a) => a.includes("other-project"))) {
        otherProjectCalls.push(`${cmd} ${args.join(" ")}`);
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    };

    const sm = createSessionManager({ config, registry: mockRegistry, execFileAsync: mockExecFile });
    await sm.pruneStaleWorktrees();

    expect(existsSync(orphanedWorktree)).toBe(true);
    // Pass 1 skips other-project (not in config); Pass 2 only iterates config.projects
    expect(otherProjectCalls.length).toBe(0);
  });

  // ─── Pass 2 tests: zombie worktrees outside ~/.worktrees/ ───────────────────────

  it("Pass 2: removes zombie worktrees outside ~/.worktrees/ when session is dead (orch-tzc)", async () => {
    const zombiePath = join(tmpdir(), "pr360-worktree");
    mkdirSync(zombiePath, { recursive: true });
    mkdirSync(config.projects["my-app"]!.path, { recursive: true });

    // Write dead session metadata to disk so listMetadata finds it.
    // Must match implementation's hash: sha256(dirname(realpathSync(configPath)))[0:12]
    const configHash = createHash("sha256")
      .update(dirname(realpathSync(configPath)))
      .digest("hex")
      .slice(0, 12);
    const sessionsDir = join(
      homedir(),
      ".agent-orchestrator",
      `${configHash}-my-app`,
      "sessions",
    );
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "pr-360"),
      `worktree=${zombiePath}\nstatus=killed\ntmuxName=bb5e6b7f8db3-pr-360\n`,
      "utf8",
    );

    const porcelainOutput =
      `worktree ${config.projects["my-app"]!.path}\nHEAD abc123\nbranch refs/heads/main\n\n` +
      `worktree ${zombiePath}\nHEAD def456\ndetached\n`;

    let capturedRemovePath: string | undefined;
    mockExecFile = async (cmd: string, args?: readonly string[], _opts?: object) => {
      if (cmd === "tmux" && args?.[0] === "has-session") {
        return Promise.reject(new Error("no server"));
      }
      const argsStr = args?.join(" ") ?? "";
      if (cmd === "git" && argsStr.includes("worktree list --porcelain")) {
        return Promise.resolve({ stdout: porcelainOutput, stderr: "" });
      }
      if (cmd === "git" && argsStr.includes("rev-parse --show-toplevel")) {
        return Promise.resolve({ stdout: config.projects["my-app"]!.path, stderr: "" });
      }
      if (cmd === "git" && argsStr.startsWith("worktree remove")) {
        capturedRemovePath = args?.[args.length - 1];
        return Promise.reject(new Error("simulated"));
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    };

    const sm = createSessionManager({
      config,
      registry: mockRegistry,
      execFileAsync: mockExecFile,
    });

    await sm.pruneStaleWorktrees();

    // Zombie worktree should be removed (session is dead, worktree outside ~/.worktrees/)
    expect(existsSync(zombiePath)).toBe(false);
    // git worktree remove should have been called with the zombie path
    expect(capturedRemovePath).toBe(zombiePath);
  });

  it("Pass 2: skips worktrees outside ~/.worktrees/ when session is still alive", async () => {
    const zombiePath = join(tmpdir(), "pr400-worktree");
    mkdirSync(zombiePath, { recursive: true });
    mkdirSync(config.projects["my-app"]!.path, { recursive: true });

    // Session is alive (status = running, not terminal)
    setMockMeta("pr-400", { worktree: zombiePath, status: "running" });

    const porcelainOutput =
      `worktree ${config.projects["my-app"]!.path}\nHEAD abc123\n\n` +
      `worktree ${zombiePath}\nHEAD def456\ndetached\n`;

    mockExecFile = async (cmd: string, args?: readonly string[]) => {
      if (cmd === "tmux" && args?.[0] === "has-session") {
        return Promise.resolve({ stdout: "", stderr: "" }); // session alive
      }
      if (cmd === "git" && args?.join(" ") === "worktree list --porcelain") {
        return Promise.resolve({ stdout: porcelainOutput, stderr: "" });
      }
      if (cmd === "git" && args?.join(" ") === "rev-parse --show-toplevel") {
        return Promise.resolve({ stdout: config.projects["my-app"]!.path, stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    };

    const sm = createSessionManager({
      config,
      registry: mockRegistry,
      execFileAsync: mockExecFile,
      readMetadataRaw: makeReadMeta(mockMeta),
    });
    await sm.pruneStaleWorktrees();

    expect(existsSync(zombiePath)).toBe(true);
  });

  it("Pass 2: skips non-AO worktrees outside ~/.worktrees/ (no session record)", async () => {
    const humanPath = join(tmpdir(), "my-custom-worktree");
    mkdirSync(humanPath, { recursive: true });
    mkdirSync(config.projects["my-app"]!.path, { recursive: true });

    // No mock sessions → readMetadataRaw returns null for all session IDs
    const porcelainOutput =
      `worktree ${config.projects["my-app"]!.path}\nHEAD abc123\n\n` +
      `worktree ${humanPath}\nHEAD def456\nbranch refs/heads/feature-x\n`;

    mockExecFile = async (cmd: string, args?: readonly string[]) => {
      if (cmd === "git" && args?.join(" ") === "worktree list --porcelain") {
        return Promise.resolve({ stdout: porcelainOutput, stderr: "" });
      }
      if (cmd === "git" && args?.join(" ") === "rev-parse --show-toplevel") {
        return Promise.resolve({ stdout: config.projects["my-app"]!.path, stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    };

    const sm = createSessionManager({
      config,
      registry: mockRegistry,
      execFileAsync: mockExecFile,
      readMetadataRaw: makeReadMeta(mockMeta),
    });
    await sm.pruneStaleWorktrees();

    expect(existsSync(humanPath)).toBe(true);
  });
});
