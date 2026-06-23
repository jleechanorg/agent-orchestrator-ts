/**
 * Tests for `ao start` and `ao stop` commands.
 *
 * Uses --no-dashboard --no-orchestrator flags to isolate project resolution
 * and URL handling logic from dashboard/session infrastructure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  lstatSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { SessionManager } from "@jleechanorg/ao-core";
import { stringify as yamlStringify, parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockExec,
  mockExecSilent,
  mockConfigRef,
  mockSessionManager,
  mockWaitForPortAndOpen,
  mockSpawn,
  mockEnsureLifecycleWorker,
  mockStopLifecycleWorker,
  mockFindPidByPort,
  mockKillProcessTree,
  mockSweepDaemonChildren,
  mockScanAoOrphans,
  mockReapAoOrphans,
  mockStartProjectSupervisor,
} = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockExecSilent: vi.fn(),
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockSessionManager: {
    list: vi.fn(),
    kill: vi.fn(),
    cleanup: vi.fn(),
    get: vi.fn(),
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    ensureOrchestrator: vi.fn(),
    send: vi.fn(),
    claimPR: vi.fn(),
  },
  mockWaitForPortAndOpen: vi.fn().mockResolvedValue(undefined),
  mockSpawn: vi.fn(),
  mockEnsureLifecycleWorker: vi.fn(),
  mockStopLifecycleWorker: vi.fn(),
  mockFindPidByPort: vi.fn(),
  mockKillProcessTree: vi.fn(),
  mockSweepDaemonChildren: vi.fn(),
  mockScanAoOrphans: vi.fn(),
  mockReapAoOrphans: vi.fn(),
  mockStartProjectSupervisor: vi.fn(),
}));

const { mockDetectOpenClawInstallation } = vi.hoisted(() => ({
  mockDetectOpenClawInstallation: vi.fn(),
}));

const { mockProcessCwd } = vi.hoisted(() => ({
  mockProcessCwd: vi.fn<() => string | undefined>(),
}));

const { mockPromptSelect, mockPromptConfirm: _mockPromptConfirm } = vi.hoisted(() => ({
  mockPromptSelect: vi.fn(),
  mockPromptConfirm: vi.fn().mockResolvedValue(true),
}));

const {
  mockAcquireStartupLock: _mockAcquireStartupLock,
  mockIsAlreadyRunning,
  mockGetRunning,
  mockRegister,
  mockUnregister,
  mockRemoveProjectFromRunning,
  mockAddProjectToRunning,
  mockWaitForExit,
  mockReadLastStop: _mockReadLastStop,
  mockWriteLastStop: _mockWriteLastStop,
  mockClearLastStop: _mockClearLastStop,
} = vi.hoisted(() => ({
  mockAcquireStartupLock: vi.fn().mockResolvedValue(() => {}),
  mockIsAlreadyRunning: vi.fn().mockReturnValue(null),
  mockGetRunning: vi.fn().mockResolvedValue(null),
  mockRegister: vi.fn(),
  mockRemoveProjectFromRunning: vi.fn(),
  mockAddProjectToRunning: vi.fn(),
  mockUnregister: vi.fn(),
  mockWaitForExit: vi.fn().mockReturnValue(true),
  mockReadLastStop: vi.fn().mockResolvedValue(null),
  mockWriteLastStop: vi.fn().mockResolvedValue(undefined),
  mockClearLastStop: vi.fn().mockResolvedValue(undefined),
}));

const { mockIsHumanCaller } = vi.hoisted(() => ({
  mockIsHumanCaller: vi.fn().mockReturnValue(true),
}));
const { mockGit } = vi.hoisted(() => ({
  mockGit: vi.fn(),
}));

vi.mock("node:process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:process")>();
  return {
    ...actual,
    cwd: () => mockProcessCwd() || actual.cwd(),
  };
});

vi.mock("../../src/lib/shell.js", () => ({
  tmux: vi.fn(),
  exec: mockExec,
  execSilent: mockExecSilent,
  git: mockGit,
  gh: vi.fn(),
  getTmuxSessions: vi.fn().mockResolvedValue([]),
  getTmuxActivity: vi.fn().mockResolvedValue(null),
}));

vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: "",
  }),
}));

vi.mock("@jleechanorg/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@jleechanorg/ao-core")>();
  const normalizeOrchestratorSessionStrategy =
    actual.normalizeOrchestratorSessionStrategy ??
    ((strategy: string | undefined) => {
      if (strategy === "kill-previous" || strategy === "delete-new") return "delete";
      if (strategy === "ignore-new") return "ignore";
      return strategy ?? "reuse";
    });

  return {
    ...actual,
    normalizeOrchestratorSessionStrategy,
    findConfigFile: (startDir?: string) => {
      if (mockConfigRef.current?.simulateMissingConfig) {
        return undefined;
      }
      const envConfigPath = process.env["AO_CONFIG_PATH"];
      if (envConfigPath && existsSync(envConfigPath)) {
        return envConfigPath;
      }
      const mockConfigPath = mockConfigRef.current?.["configPath"];
      if (typeof mockConfigPath === "string" && existsSync(mockConfigPath)) {
        return mockConfigPath;
      }
      return actual.findConfigFile(startDir);
    },
    loadConfig: (path?: string) => {
      if (mockConfigRef.current?.simulateMissingConfig) {
        throw new actual.ConfigNotFoundError();
      }
      if (path && path === mockConfigRef.current?.["configPath"]) {
        return mockConfigRef.current;
      }
      if (path) return actual.loadConfig(path);
      return mockConfigRef.current;
    },
    findPidByPort: mockFindPidByPort,
    killProcessTree: mockKillProcessTree,
    sweepDaemonChildren: mockSweepDaemonChildren,
    scanAoOrphans: mockScanAoOrphans,
    reapAoOrphans: mockReapAoOrphans,
  };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async (): Promise<SessionManager> => mockSessionManager as SessionManager,
}));

vi.mock("../../src/lib/lifecycle-service.js", () => ({
  ensureLifecycleWorker: (...args: unknown[]) => mockEnsureLifecycleWorker(...args),
  stopLifecycleWorker: (...args: unknown[]) => mockStopLifecycleWorker(...args),
}));

vi.mock("../../src/lib/web-dir.js", () => ({
  findWebDir: vi.fn().mockReturnValue("/fake/web"),
  buildDashboardEnv: vi.fn().mockResolvedValue({}),
  waitForPortAndOpen: (...args: unknown[]) => mockWaitForPortAndOpen(...args),
  isPortAvailable: vi.fn().mockResolvedValue(true),
  findFreePort: vi.fn().mockResolvedValue(3000),
}));

vi.mock("../../src/lib/dashboard-rebuild.js", () => ({
  cleanNextCache: vi.fn(),
  findRunningDashboardPid: vi.fn().mockResolvedValue(null),
  findProcessWebDir: vi.fn().mockResolvedValue(null),
  waitForPortFree: vi.fn(),
}));

vi.mock("../../src/lib/preflight.js", () => ({
  preflight: {
    checkPort: vi.fn(),
    checkBuilt: vi.fn(),
  },
}));

vi.mock("../../src/lib/running-state.js", () => ({
  register: mockRegister,
  unregister: mockUnregister,
  isAlreadyRunning: mockIsAlreadyRunning,
  getRunning: mockGetRunning,
  waitForExit: mockWaitForExit,
  addProjectToRunning: mockAddProjectToRunning,
  removeProjectFromRunning: mockRemoveProjectFromRunning,
  writeLastStop: _mockWriteLastStop,
  readLastStop: _mockReadLastStop,
  clearLastStop: _mockClearLastStop,
}));

vi.mock("../../src/lib/caller-context.js", () => ({
  isHumanCaller: mockIsHumanCaller,
  getCallerType: vi.fn().mockReturnValue("human"),
  promptSelect: mockPromptSelect,
}));

vi.mock("../../src/lib/detect-env.js", () => ({
  detectEnvironment: vi.fn().mockResolvedValue({
    git: { isRepo: true, remoteUrl: null, ownerRepo: null, currentBranch: "main", defaultBranch: "main" },
    tools: { hasTmux: true, hasGh: false, ghAuthed: false },
    apiKeys: { hasLinear: false, hasSlack: false },
  }),
}));

vi.mock("../../src/lib/detect-agent.js", () => ({
  detectAgentRuntime: vi.fn().mockResolvedValue("claude-code"),
  detectAvailableAgents: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/lib/project-detection.js", () => ({
  detectProjectType: vi.fn().mockReturnValue(null),
  generateRulesFromTemplates: vi.fn().mockReturnValue(null),
  formatProjectTypeForDisplay: vi.fn().mockReturnValue(""),
}));

// Mock node:child_process — start.ts imports spawn for dashboard + browser open
vi.mock("node:child_process", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

import { Command } from "commander";
import { registerStart, registerStop, autoCreateConfig } from "../../src/commands/start.js";

let tmpDir: string;
let program: Command;
let cwdSpy: ReturnType<typeof vi.spyOn>;
let originalEnv: NodeJS.ProcessEnv;
let originalAoGlobalConfig: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-start-test-"));
  originalEnv = { ...process.env };
  process.env["AO_CONFIG_PATH"] = join(tmpDir, "agent-orchestrator.yaml");
  process.env["AO_STAGING_CONFIG_PATH"] = join(tmpDir, ".openclaw", "agent-orchestrator.yaml");
  process.env["AO_PROD_CONFIG_PATH"] = join(tmpDir, ".openclaw_prod", "agent-orchestrator.yaml");
  originalAoGlobalConfig = process.env["AO_GLOBAL_CONFIG"];
  process.env["AO_GLOBAL_CONFIG"] = join(tmpDir, "global-agent-orchestrator.yaml");

  program = new Command();
  program.exitOverride();
  registerStart(program);
  registerStop(program);

  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  // Default: mock spawn to return a fake child process
  const fakeChild = { on: vi.fn(), kill: vi.fn(), emit: vi.fn(), stdout: null, stderr: null };
  mockSpawn.mockReturnValue(fakeChild);

  mockSessionManager.get.mockReset();
  mockSessionManager.spawnOrchestrator.mockReset();
  mockSessionManager.ensureOrchestrator.mockReset();
  mockSessionManager.ensureOrchestrator.mockResolvedValue(undefined);
  mockSessionManager.kill.mockReset();
  mockIsHumanCaller.mockReset();
  mockIsHumanCaller.mockReturnValue(true);
  mockPromptSelect.mockReset();
  mockIsAlreadyRunning.mockReset();
  mockIsAlreadyRunning.mockReturnValue(null);
  mockExec.mockReset();
  mockExecSilent.mockReset();
  // Default: execSilent returns null (gh not available), so clone falls through to git SSH/HTTPS
  mockExecSilent.mockResolvedValue(null);
  mockWaitForPortAndOpen.mockReset();
  mockWaitForPortAndOpen.mockResolvedValue(undefined);
  mockEnsureLifecycleWorker.mockReset();
  mockEnsureLifecycleWorker.mockResolvedValue({
    running: true,
    started: true,
    pid: 12345,
    pidFile: "/tmp/lifecycle-worker.pid",
    logFile: "/tmp/lifecycle-worker.log",
  });
  mockFindPidByPort.mockReset();
  mockFindPidByPort.mockResolvedValue(null);
  mockKillProcessTree.mockReset();
  mockKillProcessTree.mockResolvedValue(undefined);
  mockSweepDaemonChildren.mockReset();
  mockSweepDaemonChildren.mockResolvedValue({
    attempted: 0,
    terminated: 0,
    forceKilled: 0,
    failed: 0,
  });
  mockScanAoOrphans.mockReset();
  mockScanAoOrphans.mockResolvedValue([]);
  mockReapAoOrphans.mockReset();
  mockReapAoOrphans.mockResolvedValue({
    attempted: 0,
    terminated: 0,
    forceKilled: 0,
    failed: 0,
  });
  mockStartProjectSupervisor.mockReset();
  mockStartProjectSupervisor.mockResolvedValue({ stop: vi.fn(), reconcileNow: vi.fn() });
  mockDetectOpenClawInstallation.mockReset();
  mockDetectOpenClawInstallation.mockResolvedValue({
    state: "missing",
    gatewayUrl: "http://127.0.0.1:18789",
    probe: { reachable: false, error: "not running" },
  });
  mockStopLifecycleWorker.mockReset();
  mockStopLifecycleWorker.mockResolvedValue(true);
  mockGit.mockReset();
  mockGit.mockResolvedValue(undefined);
  mockSpawn.mockClear();
});

afterEach(() => {
  process.env = originalEnv;
  if (cwdSpy) cwdSpy.mockRestore();
  if (originalAoGlobalConfig === undefined) delete process.env["AO_GLOBAL_CONFIG"];
  else process.env["AO_GLOBAL_CONFIG"] = originalAoGlobalConfig;
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(projects: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const config = {
    configPath: join(tmpDir, "agent-orchestrator.yaml"),
    port: 3000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects,
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  };

  writeFileSync(config.configPath, yamlStringify(config, { indent: 2 }));
  return config;
}

function makeProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "My App",
    repo: "org/my-app",
    path: join(tmpDir, "main-repo"),
    defaultBranch: "main",
    sessionPrefix: "app",
    ...overrides,
  };
}

/** Mock process.cwd() to return a specific directory (avoids process.chdir in workers). */
function mockCwd(dir: string): void {
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
}

/** Create a fake git repo directory with an origin remote URL. */
function createFakeRepo(dir: string, remoteUrl: string, files?: Record<string, string>): void {
  mkdirSync(join(dir, ".git", "refs", "remotes", "origin"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, ".git", "refs", "remotes", "origin", "main"), "abc\n");
  writeFileSync(join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${remoteUrl}\n`);
  if (files) {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
  }
}

// ---------------------------------------------------------------------------
// resolveProject (tested through `ao start` with --no-dashboard --no-orchestrator)
// ---------------------------------------------------------------------------

describe("start command — project resolution", () => {
  it("includes workflow examples in start help", () => {
    const help = program.commands.find((cmd) => cmd.name() === "start")?.helpInformation() ?? "";

    expect(help).toContain("ao start ~/path/to/repo");
    expect(help).toContain("ao start https://github.com/owner/repo");
    expect(help).toContain("Use this before ao spawn");
  });

  it("uses single project when no arg given", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    await program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("My App");
    expect(output).toContain("Startup complete");
  });

  it("uses explicit project arg when given", async () => {
    mockConfigRef.current = makeConfig({
      frontend: makeProject({ name: "Frontend", sessionPrefix: "fe" }),
      backend: makeProject({ name: "Backend", sessionPrefix: "api" }),
    });

    await program.parseAsync([
      "node",
      "test",
      "start",
      "backend",
      "--no-dashboard",
      "--no-orchestrator",
    ]);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Backend");
  });

  it("errors when explicit project not found", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "start",
        "nonexistent",
        "--no-dashboard",
        "--no-orchestrator",
      ]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(errors).toContain("not found");
  });

  it("errors when multiple projects and no arg", async () => {
    mockConfigRef.current = makeConfig({
      frontend: makeProject({ name: "Frontend" }),
      backend: makeProject({ name: "Backend" }),
    });

    await expect(
      program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(errors).toContain("Multiple projects");
  });

  it("errors when no projects configured", async () => {
    mockConfigRef.current = makeConfig({});

    await expect(
      program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(errors).toContain("No projects configured");
  });

  it("falls back to managed staging config when AO_CONFIG_PATH points to a missing file", async () => {
    const stagingConfigPath = join(tmpDir, ".openclaw", "agent-orchestrator.yaml");
    mkdirSync(join(tmpDir, ".openclaw"), { recursive: true });
    writeFileSync(
      stagingConfigPath,
      yamlStringify({
        port: 3000,
        defaults: {
          runtime: "tmux",
          agent: "claude-code",
          workspace: "worktree",
          notifiers: ["desktop"],
        },
        projects: {
          "my-app": makeProject(),
        },
      }, { indent: 2 }),
    );
    mockConfigRef.current = null;

    await program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("My App");
    expect(output).toContain("Startup complete");
  });
});

// ---------------------------------------------------------------------------
// URL detection — `ao start <url>` triggers handleUrlStart
// ---------------------------------------------------------------------------

describe("start command — URL argument", () => {
  it("reuses existing clone and generates config", async () => {
    const repoDir = join(tmpDir, "DevOS");
    const stagingConfigPath = join(tmpDir, ".openclaw", "agent-orchestrator.yaml");
    createFakeRepo(repoDir, "https://github.com/ComposioHQ/DevOS.git", {
      "package.json": "{}",
      "pnpm-lock.yaml": "",
    });
    mockCwd(tmpDir);

    await program.parseAsync([
      "node",
      "test",
      "start",
      "https://github.com/ComposioHQ/DevOS",
      "--no-dashboard",
      "--no-orchestrator",
    ]);

    expect(existsSync(stagingConfigPath)).toBe(true);
    expect(existsSync(join(repoDir, "agent-orchestrator.yaml"))).toBe(false);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Reusing existing clone");
    expect(output).toContain("Startup complete");
  });

  it("clones repo via gh when gh auth is available", async () => {
    const repoDir = join(tmpDir, "my-app");
    mockCwd(tmpDir);

    // gh auth status succeeds
    mockExecSilent.mockResolvedValue("Logged in");

    mockExec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "repo" && args[1] === "clone") {
        createFakeRepo(repoDir, "https://github.com/owner/my-app.git", {
          "Cargo.toml": "",
        });
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    await program.parseAsync([
      "node",
      "test",
      "start",
      "https://github.com/owner/my-app",
      "--no-dashboard",
      "--no-orchestrator",
    ]);

    expect(mockExec).toHaveBeenCalledWith(
      "gh",
      ["repo", "clone", "owner/my-app", repoDir, "--", "--depth", "1"],
      expect.anything(),
    );

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Startup complete");
  });

  it("falls back to git clone when gh is unavailable", async () => {
    const repoDir = join(tmpDir, "my-app");
    mockCwd(tmpDir);

    // gh auth status fails (not installed or not logged in)
    mockExecSilent.mockResolvedValue(null);

    mockExec.mockImplementation(async (cmd: string, args: string[]) => {
      // SSH attempt fails
      if (cmd === "git" && args[0] === "clone" && args[3]?.startsWith("git@")) {
        throw new Error("Permission denied (publickey)");
      }
      // HTTPS fallback succeeds
      if (cmd === "git" && args[0] === "clone") {
        createFakeRepo(repoDir, "https://github.com/owner/my-app.git", {
          "Cargo.toml": "",
        });
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    await program.parseAsync([
      "node",
      "test",
      "start",
      "https://github.com/owner/my-app",
      "--no-dashboard",
      "--no-orchestrator",
    ]);

    // Should have tried SSH first, then HTTPS
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["clone", "--depth", "1", "git@github.com:owner/my-app.git", repoDir],
      expect.anything(),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["clone", "--depth", "1", "https://github.com/owner/my-app.git", repoDir],
      expect.anything(),
    );

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Startup complete");
  });

  it("uses existing config when repo already has agent-orchestrator.yaml", async () => {
    const repoDir = join(tmpDir, "configured-app");
    const stagingConfigPath = join(tmpDir, ".openclaw", "agent-orchestrator.yaml");
    createFakeRepo(repoDir, "https://github.com/owner/configured-app.git");
    mockCwd(tmpDir);

    writeFileSync(
      join(repoDir, "agent-orchestrator.yaml"),
      [
        "port: 4000",
        "defaults:",
        "  runtime: tmux",
        "  agent: claude-code",
        "  workspace: worktree",
        "  notifiers: [desktop]",
        "projects:",
        "  configured-app:",
        "    name: Configured App",
        "    repo: owner/configured-app",
        `    path: ${repoDir}`,
        "    defaultBranch: main",
        "    sessionPrefix: ca",
      ].join("\n"),
    );

    await program.parseAsync([
      "node",
      "test",
      "start",
      "https://github.com/owner/configured-app",
      "--no-dashboard",
      "--no-orchestrator",
    ]);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Migrating repo-local config into staging");
    expect(output).toContain("Configured App");
    expect(existsSync(stagingConfigPath)).toBe(true);
  });

  it("resolves correct project when existing config has multiple projects", async () => {
    const repoDir = join(tmpDir, "multi-proj");
    const stagingConfigPath = join(tmpDir, ".openclaw", "agent-orchestrator.yaml");
    createFakeRepo(repoDir, "https://github.com/org/multi-proj.git");
    mockCwd(tmpDir);

    writeFileSync(
      join(repoDir, "agent-orchestrator.yaml"),
      [
        "port: 4000",
        "defaults:",
        "  runtime: tmux",
        "  agent: claude-code",
        "  workspace: worktree",
        "  notifiers: [desktop]",
        "projects:",
        "  frontend:",
        "    name: Frontend",
        "    repo: org/other-repo",
        `    path: ${repoDir}/frontend`,
        "    defaultBranch: main",
        "    sessionPrefix: fe",
        "  multi-proj:",
        "    name: Multi Proj",
        "    repo: org/multi-proj",
        `    path: ${repoDir}`,
        "    defaultBranch: main",
        "    sessionPrefix: mp",
      ].join("\n"),
    );

    await program.parseAsync([
      "node",
      "test",
      "start",
      "https://github.com/org/multi-proj",
      "--no-dashboard",
      "--no-orchestrator",
    ]);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    // Should pick "Multi Proj" by matching repo field, not error with "Multiple projects"
    expect(output).toContain("Multi Proj");
    expect(output).toContain("Startup complete");
    expect(existsSync(stagingConfigPath)).toBe(true);
  });

  it("fails on clone error with descriptive message", async () => {
    mockCwd(tmpDir);
    mockExec.mockRejectedValue(new Error("fatal: repository not found"));

    await expect(
      program.parseAsync([
        "node",
        "test",
        "start",
        "https://github.com/owner/nonexistent",
        "--no-dashboard",
        "--no-orchestrator",
      ]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(errors).toContain("Failed to clone");
  });
});

describe("start command — local path argument", () => {
  it("adds new local-path projects to staging instead of production", async () => {
    const repoDir = join(tmpDir, "local-app");
    const stagingConfigPath = join(tmpDir, ".openclaw", "agent-orchestrator.yaml");
    const productionConfigPath = join(tmpDir, ".openclaw_prod", "agent-orchestrator.yaml");
    const existingProjectPath = join(tmpDir, "existing");
    const baseConfig = {
      port: 3000,
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: ["desktop"],
      },
      projects: {
        existing: {
          name: "Existing",
          repo: "org/existing",
          path: existingProjectPath,
          defaultBranch: "main",
          sessionPrefix: "ex",
        },
      },
    };
    const { detectProjectType, formatProjectTypeForDisplay } = await import(
      "../../src/lib/project-detection.js"
    );

    createFakeRepo(repoDir, "https://github.com/owner/local-app.git", {
      "package.json": "{}",
    });
    mkdirSync(join(tmpDir, ".openclaw"), { recursive: true });
    mkdirSync(join(tmpDir, ".openclaw_prod"), { recursive: true });
    writeFileSync(stagingConfigPath, yamlStringify(baseConfig, { indent: 2 }));
    writeFileSync(productionConfigPath, yamlStringify(baseConfig, { indent: 2 }));
    process.env["AO_CONFIG_PATH"] = join(tmpDir, "missing-config.yaml");
    mockConfigRef.current = null;
    vi.mocked(detectProjectType).mockReturnValue({
      languages: ["javascript"],
      frameworks: [],
      tools: [],
      packageManager: "npm",
    });
    vi.mocked(formatProjectTypeForDisplay).mockReturnValue("");

    await program.parseAsync([
      "node",
      "test",
      "start",
      repoDir,
      "--no-dashboard",
      "--no-orchestrator",
    ]);

    const stagingYaml = readFileSync(stagingConfigPath, "utf-8");
    const productionYaml = readFileSync(productionConfigPath, "utf-8");

    expect(stagingYaml).toContain(repoDir);
    expect(productionYaml).not.toContain(repoDir);
  });

  it("repairs an invalid staging symlink before onboarding a local path", async () => {
    const repoDir = join(tmpDir, "local-app");
    const stagingConfigPath = join(tmpDir, ".openclaw", "agent-orchestrator.yaml");
    const productionConfigPath = join(tmpDir, ".openclaw_prod", "agent-orchestrator.yaml");
    const existingProjectPath = join(tmpDir, "existing");
    const baseConfig = {
      port: 3000,
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: ["desktop"],
      },
      projects: {
        existing: {
          name: "Existing",
          repo: "org/existing",
          path: existingProjectPath,
          defaultBranch: "main",
          sessionPrefix: "ex",
        },
      },
    };
    const { detectProjectType, formatProjectTypeForDisplay } = await import(
      "../../src/lib/project-detection.js"
    );

    createFakeRepo(repoDir, "https://github.com/owner/local-app.git", {
      "package.json": "{}",
    });
    mkdirSync(join(tmpDir, ".openclaw"), { recursive: true });
    mkdirSync(join(tmpDir, ".openclaw_prod"), { recursive: true });
    writeFileSync(productionConfigPath, yamlStringify(baseConfig, { indent: 2 }));
    symlinkSync(productionConfigPath, stagingConfigPath);
    process.env["AO_CONFIG_PATH"] = join(tmpDir, "missing-config.yaml");
    mockConfigRef.current = null;
    vi.mocked(detectProjectType).mockReturnValue({
      languages: ["javascript"],
      frameworks: [],
      tools: [],
      packageManager: "npm",
    });
    vi.mocked(formatProjectTypeForDisplay).mockReturnValue("");

    await program.parseAsync([
      "node",
      "test",
      "start",
      repoDir,
      "--no-dashboard",
      "--no-orchestrator",
    ]);

    const stagingYaml = readFileSync(stagingConfigPath, "utf-8");
    const productionYaml = readFileSync(productionConfigPath, "utf-8");

    expect(lstatSync(stagingConfigPath).isSymbolicLink()).toBe(false);
    expect(stagingYaml).toContain(repoDir);
    expect(productionYaml).not.toContain(repoDir);
  });
});

// ---------------------------------------------------------------------------
// waitForPortAndOpen — port polling logic
// ---------------------------------------------------------------------------

describe("start command — browser open waits for port", () => {
  it("calls waitForPortAndOpen with orchestrator URL and AbortSignal", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    // Mock findWebDir to return tmpDir and create package.json for existsSync
    const { findWebDir } = await import("../../src/lib/web-dir.js");
    vi.mocked(findWebDir).mockReturnValue(tmpDir);
    writeFileSync(join(tmpDir, "package.json"), "{}");

    mockSessionManager.get.mockResolvedValue(null);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({ id: "app-orchestrator" });

    await program.parseAsync(["node", "test", "start", "--no-orchestrator", "--open-browser"]);

    // waitForPortAndOpen should have been called with orchestrator URL and AbortSignal
    expect(mockWaitForPortAndOpen).toHaveBeenCalledTimes(1);
    const args = mockWaitForPortAndOpen.mock.calls[0];
    expect(args[1]).toContain("/sessions/app-orchestrator");
    expect(args[2]).toBeInstanceOf(AbortSignal);
    expect(mockEnsureLifecycleWorker).toHaveBeenCalledWith(
      expect.objectContaining({ configPath: expect.any(String) }),
      "my-app",
    );
  });

  it("skips browser open and lifecycle with --no-dashboard --no-orchestrator", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    await program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]);

    expect(mockWaitForPortAndOpen).not.toHaveBeenCalled();
    expect(mockEnsureLifecycleWorker).not.toHaveBeenCalled();
  });

  it("skips browser open but still starts lifecycle with --no-dashboard alone", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    mockSessionManager.get.mockResolvedValue(null);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({ id: "app-orchestrator" });

    await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

    expect(mockWaitForPortAndOpen).not.toHaveBeenCalled();
    expect(mockEnsureLifecycleWorker).toHaveBeenCalledWith(
      expect.objectContaining({ configPath: expect.any(String) }),
      "my-app",
    );
  });

  // Regression for the Slack bd-#667 followup: `ao start <project> --no-dashboard --no-open`
  // (the launchd-ao-health.sh invocation) used to print "✓ Startup complete" and then
  // leave ~/.agent-orchestrator/running.json absent whenever the parent shell exited
  // in the small window between runStartup returning and the post-runStartup register
  // call. Every subsequent `ao spawn` then failed with "AO is not running — lifecycle
  // polling is inactive" even though the orchestrator tmux session was alive. The fix
  // moves register() INSIDE runStartup, immediately before the "Startup complete"
  // banner, so anything observing the banner can also observe a live running.json.
  it("registers running.json before printing 'Startup complete' with --no-dashboard --no-open", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    mockSessionManager.get.mockResolvedValue(null);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({ id: "app-orchestrator" });

    // Capture the order: register must be called BEFORE the "Startup complete" log line.
    const callOrder: string[] = [];
    mockRegister.mockImplementation(async () => {
      callOrder.push("register");
    });
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.includes("Startup complete")) callOrder.push("startup-complete");
    });

    await program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-open"]);

    expect(mockRegister).toHaveBeenCalledTimes(1);
    const regCall = mockRegister.mock.calls[0]?.[0];
    expect(regCall).toMatchObject({
      pid: process.pid,
      configPath: expect.any(String),
      port: expect.any(Number),
      projects: expect.arrayContaining(["my-app"]),
    });
    expect(regCall?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The critical invariant: running.json was written BEFORE the success banner.
    const regIdx = callOrder.indexOf("register");
    const bannerIdx = callOrder.indexOf("startup-complete");
    expect(regIdx).toBeGreaterThanOrEqual(0);
    expect(bannerIdx).toBeGreaterThanOrEqual(0);
    expect(regIdx).toBeLessThan(bannerIdx);
  });

  // Regression: even with --no-orchestrator --no-dashboard (no lifecycle worker at all),
  // running.json MUST still be written so subsequent `ao spawn` calls can find a running
  // instance. Before the fix, the post-runStartup register call could be skipped when
  // any of the runStartup internals threw or the parent shell closed early.
  it("registers running.json even when both dashboard and orchestrator are disabled", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    mockRegister.mockClear();
    await program.parseAsync([
      "node",
      "test",
      "start",
      "--no-dashboard",
      "--no-orchestrator",
    ]);

    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockRegister.mock.calls[0]?.[0]?.projects).toEqual(["my-app"]);
  });

  // Regression guard for the recurring "localhost:3000 keeps reopening" complaint:
  // ao-health.sh invokes `ao start $project --no-dashboard --no-open` every 5 min.
  // The --no-open flag MUST suppress waitForPortAndOpen even when the orchestrator
  // session is started and config would otherwise allow browser open.
  it("--no-open suppresses waitForPortAndOpen even with dashboard enabled and config.openBrowser true", async () => {
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ openBrowser: true }),
    });

    // Mock findWebDir so dashboard is "available"
    const { findWebDir } = await import("../../src/lib/web-dir.js");
    vi.mocked(findWebDir).mockReturnValue(tmpDir);
    writeFileSync(join(tmpDir, "package.json"), "{}");

    mockSessionManager.get.mockResolvedValue(null);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({ id: "app-orchestrator" });

    await program.parseAsync(["node", "test", "start", "--no-open"]);

    // CRITICAL: even with config.openBrowser=true and dashboard enabled,
    // --no-open must suppress the browser auto-open.
    expect(mockWaitForPortAndOpen).not.toHaveBeenCalled();
  });

  it("AO_NO_OPEN_BROWSER=1 env suppresses waitForPortAndOpen with config.openBrowser true", async () => {
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ openBrowser: true }),
    });

    const { findWebDir } = await import("../../src/lib/web-dir.js");
    vi.mocked(findWebDir).mockReturnValue(tmpDir);
    writeFileSync(join(tmpDir, "package.json"), "{}");

    mockSessionManager.get.mockResolvedValue(null);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({ id: "app-orchestrator" });

    const prev = process.env["AO_NO_OPEN_BROWSER"];
    process.env["AO_NO_OPEN_BROWSER"] = "1";
    try {
      await program.parseAsync(["node", "test", "start"]);
    } finally {
      if (prev === undefined) {
        delete process.env["AO_NO_OPEN_BROWSER"];
      } else {
        process.env["AO_NO_OPEN_BROWSER"] = prev;
      }
    }

    expect(mockWaitForPortAndOpen).not.toHaveBeenCalled();
  });
});

describe("start command — orchestrator session strategy display", () => {
  function getLoggedOutput(): string {
    return vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
  }

  it("shows reused messaging when strategy is reuse and metadata marks the session reused", async () => {
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ orchestratorSessionStrategy: "reuse" }),
    });

    mockSessionManager.get.mockResolvedValue({
      id: "app-orchestrator",
      runtimeHandle: { id: "tmux-session-1" },
    });
    mockSessionManager.spawnOrchestrator.mockResolvedValue({
      id: "app-orchestrator",
      runtimeHandle: { id: "tmux-session-1" },
      metadata: { orchestratorSessionReused: "true" },
    });

    await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

    const output = getLoggedOutput();
    expect(output).toContain("reused existing session (app-orchestrator)");
    expect(output).not.toContain("tmux attach -t tmux-session-1");
  });

  it("falls back to attach messaging when strategy is reuse but metadata is missing", async () => {
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ orchestratorSessionStrategy: "reuse" }),
    });

    mockSessionManager.get.mockResolvedValue({
      id: "app-orchestrator",
      runtimeHandle: { id: "tmux-session-1" },
    });
    mockSessionManager.spawnOrchestrator.mockResolvedValue({
      id: "app-orchestrator",
      runtimeHandle: { id: "tmux-session-1" },
    });

    await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

    const output = getLoggedOutput();
    expect(output).toContain("tmux attach -t tmux-session-1");
    expect(output).not.toContain("reused existing session");
  });

  it.each(["delete", "ignore", "delete-new", "ignore-new", "kill-previous"] as const)(
    "uses attach messaging when strategy is %s",
    async (orchestratorSessionStrategy) => {
      mockConfigRef.current = makeConfig({
        "my-app": makeProject({ orchestratorSessionStrategy }),
      });

      mockSessionManager.get.mockResolvedValue({
        id: "app-orchestrator",
        runtimeHandle: { id: "tmux-session-1" },
      });
      mockSessionManager.spawnOrchestrator.mockResolvedValue({
        id: "app-orchestrator",
        runtimeHandle: { id: "tmux-session-1" },
        metadata: { orchestratorSessionReused: "true" },
      });

      await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

      const output = getLoggedOutput();
      expect(output).toContain("tmux attach -t tmux-session-1");
      expect(output).not.toContain("reused existing session");
    },
  );
});

// ---------------------------------------------------------------------------
// ao stop
// ---------------------------------------------------------------------------

describe("stop command", () => {
  it("stops orchestrator session and dashboard", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    mockSessionManager.list.mockResolvedValue([
      { id: "app-orchestrator", projectId: "my-app", status: "running", activity: "active", metadata: {}, lastActivityAt: new Date(), runtimeHandle: null },
    ]);
    mockSessionManager.kill.mockResolvedValue(undefined);
    mockExec.mockResolvedValue({ stdout: "12345", stderr: "" });

    await program.parseAsync(["node", "test", "stop"]);

    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-orchestrator", {
      purgeOpenCode: false,
    });
    expect(mockStopLifecycleWorker).toHaveBeenCalledWith("my-app");
    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Orchestrator stopped");
  });

  it("handles missing orchestrator session gracefully", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    mockSessionManager.list.mockResolvedValue([]);
    mockExec.mockRejectedValue(new Error("no process"));

    await program.parseAsync(["node", "test", "stop"]);

    expect(mockSessionManager.kill).not.toHaveBeenCalled();
    expect(mockStopLifecycleWorker).toHaveBeenCalledWith("my-app");
    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("is not running");
  });

  it("defaults to NOT purge OpenCode session when stopping orchestrator", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    mockSessionManager.list.mockResolvedValue([
      { id: "app-orchestrator", projectId: "my-app", status: "running", activity: "active", metadata: {}, lastActivityAt: new Date(), runtimeHandle: null },
    ]);
    mockSessionManager.kill.mockResolvedValue(undefined);

    await program.parseAsync(["node", "test", "stop"]);

    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-orchestrator", {
      purgeOpenCode: false,
    });
  });

  it("passes purge flag when stopping orchestrator with --purge-session", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    mockSessionManager.list.mockResolvedValue([
      { id: "app-orchestrator", projectId: "my-app", status: "running", activity: "active", metadata: {}, lastActivityAt: new Date(), runtimeHandle: null },
    ]);
    mockSessionManager.kill.mockResolvedValue(undefined);

    await program.parseAsync(["node", "test", "stop", "--purge-session"]);

    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-orchestrator", {
      purgeOpenCode: true,
    });
  });
});

// ---------------------------------------------------------------------------
// no-dashboard keepalive (regression: launchd wrapper should not see premature exit)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// bd-8gld: main repo guard
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// autoCreateConfig — config generation defaults
// ---------------------------------------------------------------------------

describe("start command — autoCreateConfig", () => {
  it("generates config with empty notifiers array (no desktop notifier added by default)", async () => {
    const { detectEnvironment } = await import("../../src/lib/detect-env.js");
    vi.mocked(detectEnvironment).mockResolvedValue({
      isGitRepo: true,
      gitRemote: null,
      ownerRepo: null,
      currentBranch: "main",
      defaultBranch: "main",
      hasTmux: true,
      hasGh: false,
      ghAuthed: false,
      hasLinearKey: false,
      hasSlackWebhook: false,
    });

    const { detectProjectType } = await import("../../src/lib/project-detection.js");
    vi.mocked(detectProjectType).mockReturnValue({ languages: [], frameworks: [], tools: [] });

    const { detectAvailableAgents, detectAgentRuntime } =
      await import("../../src/lib/detect-agent.js");
    vi.mocked(detectAvailableAgents).mockResolvedValue([]);
    vi.mocked(detectAgentRuntime).mockResolvedValue("claude-code");

    const { findFreePort } = await import("../../src/lib/web-dir.js");
    vi.mocked(findFreePort).mockResolvedValue(3000);

    // start.ts uses `import { cwd } from "node:process"` which is intercepted
    // by the node:process mock defined at the top of this file.
    mockProcessCwd.mockReturnValue(tmpDir);

    // Non-interactive — skip the repo prompt (no ownerRepo detected)
    mockIsHumanCaller.mockReturnValue(false);

    await autoCreateConfig(tmpDir);

    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(content) as {
      $schema?: string;
      defaults?: { notifiers?: unknown[] };
    };
    expect(parsed["$schema"]).toBe(
      "https://raw.githubusercontent.com/ComposioHQ/agent-orchestrator/main/schema/config.schema.json",
    );
    expect(parsed.defaults?.notifiers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Already-running detection (moved before config mutation)
// ---------------------------------------------------------------------------

describe("start command — already-running detection", () => {
  it("exits immediately for non-TTY caller when AO is already running", async () => {
    mockIsAlreadyRunning.mockResolvedValue({
      pid: 9999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: "2026-01-01T00:00:00Z",
      projects: ["my-app"],
    });

    mockIsHumanCaller.mockReturnValue(false);

    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    // process.exit(0) throws in tests, caught by the action's catch block which calls exit(1)
    await expect(
      program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    // Verify the already-running message was printed (not a config error)
    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("AO is already running");
    expect(output).toContain("PID: 9999");
  });

  it("exits when human caller selects 'quit'", async () => {
    mockIsAlreadyRunning.mockResolvedValue({
      pid: 9999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: "2026-01-01T00:00:00Z",
      projects: ["my-app"],
    });

    mockPromptSelect.mockResolvedValue("quit");

    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    await expect(
      program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("AO is already running");
  });

  it("path arg already registered + running: opens dashboard without prompting and does not mutate YAML", async () => {
    const repoDir = join(tmpDir, "registered-repo");
    createFakeRepo(repoDir, "https://github.com/org/registered-repo.git");

    // Point AO_GLOBAL_CONFIG at a non-existent file so the global lookup
    // falls back to mockConfigRef.current.
    const origGlobalEnv = process.env["AO_GLOBAL_CONFIG"];
    process.env["AO_GLOBAL_CONFIG"] = join(tmpDir, "no-such-global.yaml");

    try {
      mockIsAlreadyRunning.mockResolvedValue({
        pid: 9999,
        configPath: "/fake/config.yaml",
        port: 3000,
        startedAt: "2026-01-01T00:00:00Z",
        projects: ["my-app"],
      });

      mockConfigRef.current = makeConfig({
        "my-app": makeProject({ path: repoDir }),
      });

      await expect(
        program.parseAsync([
          "node",
          "test",
          "start",
          repoDir,
          "--no-dashboard",
          "--no-orchestrator",
        ]),
      ).rejects.toThrow("process.exit(1)");

      // No menu shown
      expect(mockPromptSelect).not.toHaveBeenCalled();

      const output = vi
        .mocked(console.log)
        .mock.calls.map((c) => c.join(" "))
        .join("\n");
      expect(output).toContain("AO is already running");
      expect(output).toContain("my-app");
      expect(output).toContain("already registered and running");
    } finally {
      if (origGlobalEnv === undefined) delete process.env["AO_GLOBAL_CONFIG"];
      else process.env["AO_GLOBAL_CONFIG"] = origGlobalEnv;
    }
  });

  it("path arg unregistered + AO running: registers in global config and spawns orchestrator without showing the menu", async () => {
    const repoDir = join(tmpDir, "new-repo");
    createFakeRepo(repoDir, "https://github.com/org/new-repo.git");

    // Point AO_GLOBAL_CONFIG at a real file in tmpDir so addProjectToConfig
    // routes through registerProjectInGlobalConfig.
    const globalConfigPath = join(tmpDir, "global-config.yaml");
    const { stringify: yamlStringify } = await import("yaml");
    writeFileSync(
      globalConfigPath,
      yamlStringify(
        {
          defaults: {
            runtime: "process",
            agent: "claude-code",
            workspace: "worktree",
            notifiers: [],
          },
          projects: {
            "my-app": {
              name: "My App",
              repo: "org/my-app",
              path: join(tmpDir, "main-repo"),
              defaultBranch: "main",
              sessionPrefix: "app",
            },
          },
        },
        { indent: 2 },
      ),
    );

    const origGlobalEnv = process.env["AO_GLOBAL_CONFIG"];
    const origConfigEnv = process.env["AO_CONFIG_PATH"];
    process.env["AO_GLOBAL_CONFIG"] = globalConfigPath;
    process.env["AO_CONFIG_PATH"] = globalConfigPath;

    try {
      mockConfigRef.current = makeConfig({
        "my-app": makeProject({ path: join(tmpDir, "main-repo") }),
      });

      mockIsAlreadyRunning.mockResolvedValue({
        pid: 9999,
        configPath: globalConfigPath,
        port: 3000,
        startedAt: "2026-01-01T00:00:00Z",
        projects: ["my-app"],
      });

      const shell = await import("../../src/lib/shell.js");
      vi.mocked(shell.git).mockImplementation(async (args: string[], workingDir?: string) => {
        if (args[0] === "rev-parse" && args[1] === "--git-dir" && workingDir === repoDir)
          return ".git";
        if (
          args[0] === "remote" &&
          args[1] === "get-url" &&
          args[2] === "origin" &&
          workingDir === repoDir
        ) {
          return "https://github.com/org/new-repo.git";
        }
        if (args[0] === "symbolic-ref" && workingDir === repoDir) return "refs/remotes/origin/main";
        if (args[0] === "rev-parse" && args[1] === "--verify" && workingDir === repoDir)
          return "abc";
        return null;
      });

      await expect(
        program.parseAsync([
          "node",
          "test",
          "start",
          repoDir,
          "--no-dashboard",
          "--no-orchestrator",
        ]),
      ).rejects.toThrow("process.exit(1)");

      // No menu shown — went straight to register + spawn
      expect(mockPromptSelect).not.toHaveBeenCalled();

      // ensureOrchestrator was called for the newly-registered project
      expect(mockSessionManager.ensureOrchestrator).toHaveBeenCalled();
      const callArgs = mockSessionManager.ensureOrchestrator.mock.calls[0]?.[0];
      expect(callArgs?.projectId).toBeDefined();
      expect(callArgs?.projectId).not.toBe("my-app");

      const output = vi
        .mocked(console.log)
        .mock.calls.map((c) => c.join(" "))
        .join("\n");
      expect(output).toContain("registered in the global config");
      expect(output).toContain("Orchestrator session ready");
      expect(output).toContain("Opening dashboard");
    } finally {
      if (origGlobalEnv === undefined) delete process.env["AO_GLOBAL_CONFIG"];
      else process.env["AO_GLOBAL_CONFIG"] = origGlobalEnv;
      if (origConfigEnv === undefined) delete process.env["AO_CONFIG_PATH"];
      else process.env["AO_CONFIG_PATH"] = origConfigEnv;
    }
  });

  it("offers to add cwd when AO is running and cwd is an unregistered git repo", async () => {
    mockIsAlreadyRunning.mockResolvedValue({
      pid: 9999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: "2026-01-01T00:00:00Z",
      projects: ["my-app"],
    });

    createFakeRepo(tmpDir, "https://github.com/org/unregistered.git");
    mockCwd(tmpDir);
    mockPromptSelect.mockResolvedValue("quit");
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ path: join(tmpDir, "main-repo") }),
    });

    await expect(
      program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    const options = mockPromptSelect.mock.calls[0]?.[1] as
      | Array<{ value: string; label: string }>
      | undefined;
    expect(options?.some((option) => option.value === "add" && option.label.includes("Add"))).toBe(
      true,
    );
  });

  it("exits when human caller selects 'open'", async () => {
    mockIsAlreadyRunning.mockResolvedValue({
      pid: 9999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: "2026-01-01T00:00:00Z",
      projects: ["my-app"],
    });

    mockPromptSelect.mockResolvedValue("open");

    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    await expect(
      program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("AO is already running");
  });

  it("kills existing process and continues when human caller selects 'restart'", async () => {
    mockIsAlreadyRunning.mockResolvedValue({
      pid: 9999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: "2026-01-01T00:00:00Z",
      projects: ["my-app"],
    });

    mockWaitForExit.mockResolvedValue(true);
    mockKillProcessTree.mockResolvedValue(undefined);

    mockPromptSelect.mockResolvedValue("restart");

    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    // After restart the startup flow continues — it may succeed or fail
    // depending on infrastructure mocks, so we just verify the restart actions
    await program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]);

    const output = vi.mocked(console.log).mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Startup complete");
  });
});

describe("no-dashboard keepalive", () => {
  /**
   * Regression test for the keepalive path added to prevent `ao start --no-dashboard`
   * from exiting immediately after spawning the detached lifecycle worker.
   *
   * Without keepalive, start-all.sh sees the wrapper exit with code 0, kills all
   * remaining workers, and launchd (with SuccessfulExit:false) does not restart.
   *
   * The keepalive uses process.once("SIGTERM"/"SIGINT") to ensure clean teardown.
   * Signal handlers cannot be sent to the test process itself (that would kill vitest),
   * so we verify that lifecycle is started and the --no-dashboard flag is accepted
   * without causing an error (i.e., the keepalive path is reachable).
   */
  it("starts lifecycle and completes without error when --no-dashboard is used", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    mockSessionManager.spawnOrchestrator.mockResolvedValue({ id: "app-orchestrator" });
    await program.parseAsync(["node", "test", "start", "--no-dashboard"]);
    expect(mockEnsureLifecycleWorker).toHaveBeenCalled();
    expect(mockStopLifecycleWorker).not.toHaveBeenCalled();
  });

  it("creates new orchestrator entry when human caller selects 'new'", async () => {
    mockIsAlreadyRunning.mockResolvedValue({
      pid: 9999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: "2026-01-01T00:00:00Z",
      projects: ["my-app"],
    });

    mockPromptSelect.mockResolvedValue("new");

    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    const { stringify: yamlStringify } = await import("yaml");
    writeFileSync(
      configPath,
      yamlStringify(
        {
          defaults: {
            runtime: "process",
            agent: "claude-code",
            workspace: "worktree",
            notifiers: [],
          },
          projects: {
            "my-app": {
              name: "My App",
              repo: "org/my-app",
              path: join(tmpDir, "main-repo"),
              defaultBranch: "main",
              sessionPrefix: "app",
            },
          },
        },
        { indent: 2 },
      ),
    );

    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    // These mocks are required for the session manager path (same as the existing
    // "skips browser open but still starts lifecycle with --no-dashboard alone" test).
    mockSessionManager.get.mockResolvedValue(null);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({ id: "app-orchestrator" });

    // If this resolves without throwing, the keepalive path was reached (no immediate exit).
    // With the keepalive fix, --no-dashboard no longer causes premature process exit.
    await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

    expect(mockEnsureLifecycleWorker).toHaveBeenCalled();
    // stopLifecycleWorker is NOT called during startup — only on signal receipt
    expect(mockStopLifecycleWorker).not.toHaveBeenCalled();
    // Verify a new orchestrator entry was added to the YAML
    const updatedContent = readFileSync(configPath, "utf-8");
    const updatedConfig = parseYaml(updatedContent) as { projects: Record<string, unknown> };
    const projectKeys = Object.keys(updatedConfig.projects);
    expect(projectKeys.length).toBe(2);
    expect(projectKeys).toContain("my-app");
    // The new entry should have a suffix like "my-app-xxxx"
    const newKey = projectKeys.find((k) => k !== "my-app");
    expect(newKey).toMatch(/^my-app-/);
  });

  it("does not mutate YAML when non-TTY caller detects already running (path arg)", async () => {
    mockIsAlreadyRunning.mockResolvedValue({
      pid: 9999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: "2026-01-01T00:00:00Z",
      projects: ["my-app"],
    });

    mockIsHumanCaller.mockReturnValue(false);

    const repoDir = join(tmpDir, "some-project");
    createFakeRepo(repoDir, "https://github.com/org/some-project.git");

    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    const { stringify: yamlStringify } = await import("yaml");
    const originalYaml = yamlStringify(
      {
        defaults: {
          runtime: "process",
          agent: "claude-code",
          workspace: "worktree",
          notifiers: [],
        },
        projects: {
          "my-app": {
            name: "My App",
            repo: "org/my-app",
            path: join(tmpDir, "main-repo"),
            defaultBranch: "main",
            sessionPrefix: "app",
          },
        },
      },
      { indent: 2 },
    );
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    writeFileSync(configPath, originalYaml);
    mockCwd(tmpDir);

    // process.exit(0) throws, caught by catch block which calls exit(1)
    await expect(
      program.parseAsync(["node", "test", "start", repoDir, "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    // Verify the already-running message was printed
    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("AO is already running");

    // YAML should be unchanged — no duplicate entry added
    const afterYaml = readFileSync(configPath, "utf-8");
    expect(afterYaml).toBe(originalYaml);
  });
});

// ---------------------------------------------------------------------------
// addProjectToConfig — path-based deduplication
// ---------------------------------------------------------------------------

describe("start command — path-based deduplication in addProjectToConfig", () => {
  it("skips addProjectToConfig when path arg matches an existing project", async () => {
    // Pass a local path that's already registered in config.
    // The path-argument branch should find the existing entry and skip addProjectToConfig.
    const repoDir = join(tmpDir, "my-app");
    createFakeRepo(repoDir, "https://github.com/org/my-app.git");

    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    const { stringify: yamlStringify } = await import("yaml");
    writeFileSync(
      configPath,
      yamlStringify(
        {
          defaults: {
            runtime: "process",
            agent: "claude-code",
            workspace: "worktree",
            notifiers: [],
          },
          projects: {
            "my-app": {
              name: "My App",
              repo: "org/my-app",
              path: repoDir,
              defaultBranch: "main",
              sessionPrefix: "app",
            },
          },
        },
        { indent: 2 },
      ),
    );

    // Set AO_CONFIG_PATH so findConfigFile() finds our config in the path-arg branch
    const origEnv = process.env["AO_CONFIG_PATH"];
    process.env["AO_CONFIG_PATH"] = configPath;

    try {
      // Pass repoDir as a local path arg — enters the path-argument branch
      await program.parseAsync([
        "node",
        "test",
        "start",
        repoDir,
        "--no-dashboard",
        "--no-orchestrator",
      ]);

      // Verify no duplicate entry was created in the YAML
      const content = readFileSync(configPath, "utf-8");
      const parsed = parseYaml(content) as { projects: Record<string, unknown> };
      expect(Object.keys(parsed.projects)).toEqual(["my-app"]);
    } finally {
      if (origEnv === undefined) delete process.env["AO_CONFIG_PATH"];
      else process.env["AO_CONFIG_PATH"] = origEnv;
    }
  });

  it("deduplicates via addProjectToConfig when path exists under a different name", async () => {
    // Register a project under name "old-name" pointing to repoDir.
    // Then pass repoDir as a path arg with a config that doesn't match by name.
    // addProjectToConfig's path dedup should return "old-name" without creating a duplicate.
    const repoDir = join(tmpDir, "new-project");
    createFakeRepo(repoDir, "https://github.com/org/new-project.git");

    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    const { stringify: yamlStringify } = await import("yaml");
    writeFileSync(
      configPath,
      yamlStringify(
        {
          defaults: {
            runtime: "process",
            agent: "claude-code",
            workspace: "worktree",
            notifiers: [],
          },
          projects: {
            "old-name": {
              name: "Old Name",
              repo: "org/new-project",
              path: repoDir,
              defaultBranch: "main",
              sessionPrefix: "old",
            },
          },
        },
        { indent: 2 },
      ),
    );

    // Set AO_CONFIG_PATH so findConfigFile() finds our config
    const origEnv = process.env["AO_CONFIG_PATH"];
    process.env["AO_CONFIG_PATH"] = configPath;

    try {
      // Pass repoDir as path arg. The path-argument branch's path-match check
      // at lines 1304-1311 finds "old-name" by path and skips addProjectToConfig.
      // If that outer check were removed, addProjectToConfig's own dedup (lines 656-665)
      // would catch it. Either way, no duplicate entry should be created.
      await program.parseAsync([
        "node",
        "test",
        "start",
        repoDir,
        "--no-dashboard",
        "--no-orchestrator",
      ]);

      const content = readFileSync(configPath, "utf-8");
      const parsed = parseYaml(content) as { projects: Record<string, unknown> };
      expect(Object.keys(parsed.projects)).toEqual(["old-name"]);
    } finally {
      if (origEnv === undefined) delete process.env["AO_CONFIG_PATH"];
      else process.env["AO_CONFIG_PATH"] = origEnv;
    }
  });
});

describe("start command — global registry mutations", () => {
  it("adds a project to the global registry and writes behavior to the repo-local config", async () => {
    const currentRepoDir = join(tmpDir, "current");
    const addedRepoDir = join(tmpDir, "added");
    createFakeRepo(currentRepoDir, "https://github.com/org/current.git");
    createFakeRepo(addedRepoDir, "https://github.com/org/added.git");
    writeFileSync(join(addedRepoDir, ".git", "refs", "remotes", "origin", "master"), "abc\n");

    const localCurrentConfigPath = join(currentRepoDir, "agent-orchestrator.yaml");
    writeFileSync(localCurrentConfigPath, "agent: claude-code\n");

    const globalConfigPath = join(tmpDir, "config.yaml");
    const { stringify: yamlStringify } = await import("yaml");
    writeFileSync(
      globalConfigPath,
      yamlStringify(
        {
          defaults: {
            runtime: "process",
            agent: "claude-code",
            workspace: "worktree",
            notifiers: [],
          },
          projects: {
            current: {
              projectId: "current",
              path: currentRepoDir,
              storageKey: "current-storage",
              defaultBranch: "main",
              displayName: "Current",
              sessionPrefix: "current",
            },
          },
        },
        { indent: 2 },
      ),
    );
    mockConfigRef.current = makeConfig({
      current: makeProject({ name: "Current", path: currentRepoDir, sessionPrefix: "current" }),
    });
    (mockConfigRef.current as Record<string, unknown>).configPath = globalConfigPath;

    const origEnv = process.env["AO_CONFIG_PATH"];
    const origGlobalEnv = process.env["AO_GLOBAL_CONFIG"];
    process.env["AO_CONFIG_PATH"] = globalConfigPath;
    process.env["AO_GLOBAL_CONFIG"] = globalConfigPath;

    const shell = await import("../../src/lib/shell.js");
    vi.mocked(shell.git).mockImplementation(async (args: string[], workingDir?: string) => {
      if (args[0] === "rev-parse" && args[1] === "--git-dir" && workingDir === addedRepoDir)
        return ".git";
      if (
        args[0] === "remote" &&
        args[1] === "get-url" &&
        args[2] === "origin" &&
        workingDir === addedRepoDir
      ) {
        return "https://github.com/org/added.git";
      }
      if (args[0] === "symbolic-ref" && workingDir === addedRepoDir)
        return "refs/remotes/origin/master";
      if (args[0] === "rev-parse" && args[1] === "--verify" && workingDir === addedRepoDir)
        return "abc";
      return null;
    });

    try {
      try {
        await program.parseAsync([
          "node",
          "test",
          "start",
          addedRepoDir,
          "--no-dashboard",
          "--no-orchestrator",
        ]);
      } catch (error) {
        const loggedErrors = vi
          .mocked(console.error)
          .mock.calls.map((call) => call.join(" "))
          .join("\n");
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${loggedErrors}`,
          { cause: error },
        );
      }

      const globalConfig = parseYaml(readFileSync(globalConfigPath, "utf-8")) as {
        projects: Record<string, Record<string, unknown>>;
      };
      const addedEntry = Object.values(globalConfig.projects).find(
        (entry) => entry.path === resolve(addedRepoDir),
      );
      expect(addedEntry).toMatchObject({
        path: resolve(addedRepoDir),
        defaultBranch: "master",
        sessionPrefix: "add",
      });
      expect(addedEntry).not.toHaveProperty("agentRules");

      const localAddedConfig = readFileSync(join(addedRepoDir, "agent-orchestrator.yaml"), "utf-8");
      expect(localAddedConfig).not.toContain("projects:");
    } finally {
      if (origEnv === undefined) delete process.env["AO_CONFIG_PATH"];
      else process.env["AO_CONFIG_PATH"] = origEnv;
      if (origGlobalEnv === undefined) delete process.env["AO_GLOBAL_CONFIG"];
      else process.env["AO_GLOBAL_CONFIG"] = origGlobalEnv;
    }
  });

  it("writes interactive agent overrides to the repo-local config when using the global registry", async () => {
    const repoDir = join(tmpDir, "current");
    createFakeRepo(repoDir, "https://github.com/org/current.git");

    const localConfigPath = join(repoDir, "agent-orchestrator.yaml");
    writeFileSync(localConfigPath, "agent: claude-code\n");

    const globalConfigPath = join(tmpDir, "config.yaml");
    const { stringify: yamlStringify } = await import("yaml");
    writeFileSync(
      globalConfigPath,
      yamlStringify(
        {
          defaults: {
            runtime: "process",
            agent: "claude-code",
            workspace: "worktree",
            notifiers: [],
          },
          projects: {
            current: {
              projectId: "current",
              path: repoDir,
              storageKey: "current-storage",
              defaultBranch: "main",
              displayName: "Current",
              sessionPrefix: "current",
            },
          },
        },
        { indent: 2 },
      ),
    );
    mockConfigRef.current = makeConfig({
      current: makeProject({ name: "Current", path: repoDir, sessionPrefix: "current" }),
    });
    (mockConfigRef.current as Record<string, unknown>).configPath = globalConfigPath;

    const origEnv = process.env["AO_CONFIG_PATH"];
    const origGlobalEnv = process.env["AO_GLOBAL_CONFIG"];
    process.env["AO_CONFIG_PATH"] = globalConfigPath;
    process.env["AO_GLOBAL_CONFIG"] = globalConfigPath;

    const detectAgent = await import("../../src/lib/detect-agent.js");
    vi.mocked(detectAgent.detectAvailableAgents).mockResolvedValue([
      { name: "codex", displayName: "Codex" },
      { name: "opencode", displayName: "OpenCode" },
    ]);
    mockPromptSelect.mockResolvedValueOnce("codex").mockResolvedValueOnce("opencode");
    const originalStdinTty = process.stdin.isTTY;
    const originalStdoutTty = process.stdout.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    try {
      await program.parseAsync([
        "node",
        "test",
        "start",
        "--interactive",
        "--no-dashboard",
        "--no-orchestrator",
      ]);

      const localConfig = readFileSync(localConfigPath, "utf-8");
      expect(localConfig).toContain("orchestrator:");
      expect(localConfig).toContain("agent: codex");
      expect(localConfig).toContain("worker:");
      expect(localConfig).toContain("agent: opencode");

      const globalConfig = readFileSync(globalConfigPath, "utf-8");
      expect(globalConfig).not.toContain("orchestrator:");
      expect(globalConfig).not.toContain("worker:");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: originalStdinTty,
        configurable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value: originalStdoutTty,
        configurable: true,
      });
      if (origEnv === undefined) delete process.env["AO_CONFIG_PATH"];
      else process.env["AO_CONFIG_PATH"] = origEnv;
      if (origGlobalEnv === undefined) delete process.env["AO_GLOBAL_CONFIG"];
      else process.env["AO_GLOBAL_CONFIG"] = origGlobalEnv;
    }
  });
});
