import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, realpathSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { createSessionManager } from "../session-manager.js";
import { hashProjectId } from "../fork-project-isolation.js";
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
    startupGracePeriodMs: 120_000,
  };
});

afterEach(() => {
  for (const projectId of Object.keys(config.projects)) {
    const wd = join(homedir(), ".worktrees", projectId);
    if (existsSync(wd)) rmSync(wd, { recursive: true, force: true });
  }

  let configHash = "";
  try {
    if (existsSync(configPath)) {
      configHash = createHash("sha256")
        .update(dirname(realpathSync(configPath)))
        .digest("hex")
        .slice(0, 12);
    }
  } catch (err) {
    // Ignore error if file doesn't exist
  }

  rmSync(tmpDir, { recursive: true, force: true });

  if (configHash) {
    const aoDir = join(
      homedir(),
      ".agent-orchestrator",
      `${configHash}-my-app-${hashProjectId("my-app")}`,
    );
    if (existsSync(aoDir)) rmSync(aoDir, { recursive: true, force: true });
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

  it("prunes AO-managed worktrees for custom configured prefixes", async () => {
    config.projects["my-app"] = {
      ...config.projects["my-app"]!,
      sessionPrefix: "app-orchestrator",
    };

    const worktreesDir = join(homedir(), ".worktrees", "my-app");
    mkdirSync(worktreesDir, { recursive: true });

    const staleWorktree = join(worktreesDir, "app-orchestrator-999");
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
      `${configHash}-my-app-${hashProjectId("my-app")}`,
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
      if (cmd === "git" && argsStr.includes("rev-parse --is-inside-work-tree")) {
        return Promise.resolve({ stdout: "true\n", stderr: "" });
      }
      if (cmd === "git" && argsStr.includes("worktree remove")) {
        capturedRemovePath = args?.[args.length - 1];
        // Simulate successful deletion of the folder
        rmSync(zombiePath, { recursive: true, force: true });
        return Promise.resolve({ stdout: "", stderr: "" });
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

    // Write session metadata to disk so listMetadata finds it.
    const configHash = createHash("sha256")
      .update(dirname(realpathSync(configPath)))
      .digest("hex")
      .slice(0, 12);
    const sessionsDir = join(
      homedir(),
      ".agent-orchestrator",
      `${configHash}-my-app-${hashProjectId("my-app")}`,
      "sessions",
    );
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "pr-400"),
      `worktree=${zombiePath}\nstatus=running\n`,
      "utf8",
    );

    const porcelainOutput =
      `worktree ${config.projects["my-app"]!.path}\nHEAD abc123\n\n` +
      `worktree ${zombiePath}\nHEAD def456\ndetached\n`;

    mockExecFile = async (cmd: string, args?: readonly string[]) => {
      if (cmd === "tmux" && args?.[0] === "has-session") {
        return Promise.resolve({ stdout: "", stderr: "" }); // session alive
      }
      const argsStr = args?.join(" ") ?? "";
      if (cmd === "git" && argsStr.includes("worktree list --porcelain")) {
        return Promise.resolve({ stdout: porcelainOutput, stderr: "" });
      }
      if (cmd === "git" && argsStr.includes("rev-parse --is-inside-work-tree")) {
        return Promise.resolve({ stdout: "true\n", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    };

    const sm = createSessionManager({
      config,
      registry: mockRegistry,
      execFileAsync: mockExecFile,
    });
    await sm.pruneStaleWorktrees();

    // Zombie worktree should be preserved because session is still alive (status=running)
    expect(existsSync(zombiePath)).toBe(true);
  });

  it("Pass 2: skips non-AO worktrees outside ~/.worktrees/ (no session record)", async () => {
    const humanPath = join(tmpdir(), "my-custom-worktree");
    mkdirSync(humanPath, { recursive: true });
    mkdirSync(config.projects["my-app"]!.path, { recursive: true });

    // Write an unrelated session metadata file so Pass 2 has sessions to iterate,
    // but none of them match the human worktree path.
    const configHash = createHash("sha256")
      .update(dirname(realpathSync(configPath)))
      .digest("hex")
      .slice(0, 12);
    const sessionsDir = join(
      homedir(),
      ".agent-orchestrator",
      `${configHash}-my-app-${hashProjectId("my-app")}`,
      "sessions",
    );
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "pr-401"),
      `worktree=${join(tmpdir(), "other-worktree")}\nstatus=killed\n`,
      "utf8",
    );

    const porcelainOutput =
      `worktree ${config.projects["my-app"]!.path}\nHEAD abc123\n\n` +
      `worktree ${humanPath}\nHEAD def456\nbranch refs/heads/feature-x\n`;

    mockExecFile = async (cmd: string, args?: readonly string[]) => {
      const argsStr = args?.join(" ") ?? "";
      if (cmd === "git" && argsStr.includes("worktree list --porcelain")) {
        return Promise.resolve({ stdout: porcelainOutput, stderr: "" });
      }
      if (cmd === "git" && argsStr.includes("rev-parse --is-inside-work-tree")) {
        return Promise.resolve({ stdout: "true\n", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    };

    const sm = createSessionManager({
      config,
      registry: mockRegistry,
      execFileAsync: mockExecFile,
    });
    await sm.pruneStaleWorktrees();

    // Human worktree should be preserved — no matching AO session record
    expect(existsSync(humanPath)).toBe(true);
  });

  it("Pass 2: skips the main linked worktree (project root) and never targets it for deletion", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });

    // Write dead session metadata to disk matching the main worktree path.
    const configHash = createHash("sha256")
      .update(dirname(realpathSync(configPath)))
      .digest("hex")
      .slice(0, 12);
    const sessionsDir = join(
      homedir(),
      ".agent-orchestrator",
      `${configHash}-my-app-${hashProjectId("my-app")}`,
      "sessions",
    );
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "pr-main-project"),
      `worktree=${projectPath}\nstatus=killed\n`,
      "utf8",
    );

    const porcelainOutputMain = `worktree ${projectPath}\nHEAD abc123\nbranch refs/heads/main\n`;

    let gitWorktreeRemoveCalled = false;
    mockExecFile = async (cmd: string, args?: readonly string[], _opts?: object) => {
      const argsStr = args?.join(" ") ?? "";
      if (cmd === "git" && argsStr.includes("worktree list --porcelain")) {
        return Promise.resolve({ stdout: porcelainOutputMain, stderr: "" });
      }
      if (cmd === "git" && argsStr.includes("rev-parse --is-inside-work-tree")) {
        return Promise.resolve({ stdout: "true\n", stderr: "" });
      }
      if (cmd === "git" && argsStr.includes("worktree remove")) {
        gitWorktreeRemoveCalled = true;
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    };

    const smMain = createSessionManager({
      config,
      registry: mockRegistry,
      execFileAsync: mockExecFile,
    });

    await smMain.pruneStaleWorktrees();

    expect(existsSync(projectPath)).toBe(true);
    expect(gitWorktreeRemoveCalled).toBe(false);
  });

  it("Pass 2: skips the main linked worktree (project root) when it is a symlink", async () => {
    // Create the real path and symlink path
    const projectPathReal = join(tmpDir, "my-app-real");
    const projectPathSymlink = config.projects["my-app"]!.path;
    mkdirSync(projectPathReal, { recursive: true });
    symlinkSync(projectPathReal, projectPathSymlink);

    // Write dead session metadata to disk matching the real project path (git resolves it to realpath).
    const configHash = createHash("sha256")
      .update(dirname(realpathSync(configPath)))
      .digest("hex")
      .slice(0, 12);
    const sessionsDir = join(
      homedir(),
      ".agent-orchestrator",
      `${configHash}-my-app-${hashProjectId("my-app")}`,
      "sessions",
    );
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "pr-main-project"),
      `worktree=${projectPathReal}\nstatus=killed\n`,
      "utf8",
    );

    const porcelainOutputMain = `worktree ${projectPathReal}\nHEAD abc123\nbranch refs/heads/main\n`;

    let gitWorktreeRemoveCalled = false;
    mockExecFile = async (cmd: string, args?: readonly string[], _opts?: object) => {
      const argsStr = args?.join(" ") ?? "";
      if (cmd === "git" && argsStr.includes("worktree list --porcelain")) {
        return Promise.resolve({ stdout: porcelainOutputMain, stderr: "" });
      }
      if (cmd === "git" && argsStr.includes("rev-parse --is-inside-work-tree")) {
        return Promise.resolve({ stdout: "true\n", stderr: "" });
      }
      if (cmd === "git" && argsStr.includes("worktree remove")) {
        gitWorktreeRemoveCalled = true;
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    };

    const smMain = createSessionManager({
      config,
      registry: mockRegistry,
      execFileAsync: mockExecFile,
    });

    await smMain.pruneStaleWorktrees();

    // The real project directory and symlink should both be preserved
    expect(existsSync(projectPathReal)).toBe(true);
    expect(existsSync(projectPathSymlink)).toBe(true);
    expect(gitWorktreeRemoveCalled).toBe(false);
  });

  it("Pass 2: should NOT delete the main project directory when a killed session references project.path as worktree", async () => {
    const mainRepoPath = config.projects["my-app"]!.path;
    mkdirSync(mainRepoPath, { recursive: true });

    // Resolve the real path of the repository to simulate production where git/metadata resolves symlinks
    const realRepoPath = realpathSync(mainRepoPath);

    // Write a killed session metadata file whose worktree matches the resolved real repo path
    const configHash = createHash("sha256")
      .update(dirname(realpathSync(configPath)))
      .digest("hex")
      .slice(0, 12);
    const sessionsDir = join(
      homedir(),
      ".agent-orchestrator",
      `${configHash}-my-app-${hashProjectId("my-app")}`,
      "sessions",
    );
    mkdirSync(sessionsDir, { recursive: true });
    // This simulates the main ao-orchestrator session which can have status=killed
    // and worktree pointing to the main project repository.
    writeFileSync(
      join(sessionsDir, `${config.projects["my-app"]!.sessionPrefix}-orchestrator`),
      `worktree=${realRepoPath}\nstatus=killed\n`,
      "utf8",
    );

    // git worktree list --porcelain always lists the main worktree as the first entry
    const porcelainOutput =
      `worktree ${realRepoPath}\nHEAD abc123\nbranch refs/heads/main\n\n`;

    const removedPaths: string[] = [];
    mockExecFile = async (cmd: string, args?: readonly string[]) => {
      const argsStr = args?.join(" ") ?? "";
      if (cmd === "git" && argsStr.includes("worktree list --porcelain")) {
        return Promise.resolve({ stdout: porcelainOutput, stderr: "" });
      }
      if (cmd === "git" && argsStr.includes("rev-parse --is-inside-work-tree")) {
        return Promise.resolve({ stdout: "true\n", stderr: "" });
      }
      if (cmd === "git" && argsStr.includes("worktree remove")) {
        const pathArg = args?.[args.length - 1];
        if (pathArg) {
          removedPaths.push(pathArg);
        }
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    };

    const sm = createSessionManager({
      config,
      registry: mockRegistry,
      execFileAsync: mockExecFile,
    });
    await sm.pruneStaleWorktrees();

    // Guard must prevent deletion of the main project dir,
    // so neither the unresolved main repo path nor its resolved real path should be removed.
    expect(removedPaths).not.toContain(realRepoPath);
    expect(removedPaths).not.toContain(mainRepoPath);
    expect(existsSync(mainRepoPath)).toBe(true);
  });
});
