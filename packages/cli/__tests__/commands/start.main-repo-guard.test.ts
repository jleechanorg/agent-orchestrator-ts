import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionManager } from "@jleechanorg/ao-core";
import { stringify as yamlStringify } from "yaml";

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

vi.mock("node:child_process", async (importOriginal) => {
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
import { registerStart, registerStop } from "../../src/commands/start.js";

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

function mockCwd(dir: string): void {
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
}

describe("start command — main repo guard (bd-8gld)", () => {
  let originalRealpath: typeof realpathSync.native;
  let mainRepoDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    originalRealpath = realpathSync.native;
    originalHome = process.env["HOME"];

    mainRepoDir = mkdtempSync(join(tmpdir(), "ao-main-repo-guard-"));
    process.env["AO_MAIN_REPO"] = mainRepoDir;
    process.env["HOME"] = tmpdir();

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
  });

  afterEach(() => {
    delete process.env["AO_MAIN_REPO"];
    if (originalHome !== undefined) {
      process.env["HOME"] = originalHome;
    } else {
      delete process.env["HOME"];
    }
    rmSync(mainRepoDir, { recursive: true, force: true });
  });

  it("throws when project path resolves to the main repo", async () => {
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ path: mainRepoDir }),
    });

    vi.spyOn(realpathSync, "native").mockImplementation((p: string) => {
      return originalRealpath(p) === mainRepoDir ? mainRepoDir : originalRealpath(p);
    });

    await expect(
      program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi.mocked(console.error).mock.calls.map((c) => c.join(" ")).join("\n");
    expect(errors).toContain("Refusing to operate on the main repo");
  });

  it("starts normally when project path is NOT the main repo", async () => {
    const otherProjectDir = mkdtempSync(join(tmpdir(), "ao-other-proj-"));
    try {
      mockConfigRef.current = makeConfig({
        "my-app": makeProject({ path: otherProjectDir }),
      });
      vi.spyOn(realpathSync, "native").mockImplementation((p: string) => originalRealpath(p));
      await program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]);
      const errors = vi.mocked(console.error).mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errors).not.toContain("Refusing to operate on the main repo");
    } finally {
      rmSync(otherProjectDir, { recursive: true, force: true });
    }
  });

  it("allows the main repo when --allow-main-repo flag is set (Site 3) (bd-cj5s)", async () => {
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ path: mainRepoDir }),
    });

    vi.spyOn(realpathSync, "native").mockImplementation((p: string) => {
      return originalRealpath(p) === mainRepoDir ? mainRepoDir : originalRealpath(p);
    });

    await program.parseAsync([
      "node",
      "test",
      "start",
      "--no-dashboard",
      "--no-orchestrator",
      "--allow-main-repo",
    ]);

    const errors = vi.mocked(console.error).mock.calls.map((c) => c.join(" ")).join("\n");
    expect(errors).not.toContain("Refusing to operate on the main repo");
  });

  it("throws when local path argument resolves to the main repo (Site 2) (bd-cj5s)", async () => {
    mockConfigRef.current = makeConfig({});
    vi.spyOn(realpathSync, "native").mockImplementation((p: string) => {
      return originalRealpath(p) === mainRepoDir ? mainRepoDir : originalRealpath(p);
    });

    await expect(
      program.parseAsync(["node", "test", "start", mainRepoDir, "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi.mocked(console.error).mock.calls.map((c) => c.join(" ")).join("\n");
    expect(errors).toContain("Refusing to operate on the main repo");
  });

  it("allows local path argument when --allow-main-repo flag is set (Site 2) (bd-cj5s)", async () => {
    mockConfigRef.current = makeConfig({});
    vi.spyOn(realpathSync, "native").mockImplementation((p: string) => {
      return originalRealpath(p) === mainRepoDir ? mainRepoDir : originalRealpath(p);
    });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "start",
        mainRepoDir,
        "--no-dashboard",
        "--no-orchestrator",
        "--allow-main-repo",
      ])
    ).resolves.toBeDefined();

    const errors = vi.mocked(console.error).mock.calls.map((c) => c.join(" ")).join("\n");
    expect(errors).not.toContain("Refusing to operate on the main repo");
  });

  it("throws when no-argument start cwd resolves to the main repo (Site 4) (bd-cj5s)", async () => {
    mockConfigRef.current = { simulateMissingConfig: true };
    mockCwd(mainRepoDir);
    mockProcessCwd.mockReturnValue(mainRepoDir);
    vi.spyOn(realpathSync, "native").mockImplementation((p: string) => {
      return originalRealpath(p) === mainRepoDir ? mainRepoDir : originalRealpath(p);
    });

    await expect(
      program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi.mocked(console.error).mock.calls.map((c) => c.join(" ")).join("\n");
    expect(errors).toContain("Refusing to operate on the main repo");
  });

  it("allows no-argument start cwd when --allow-main-repo flag is set (Site 4) (bd-cj5s)", async () => {
    mockConfigRef.current = { simulateMissingConfig: true };
    mockCwd(mainRepoDir);
    mockProcessCwd.mockReturnValue(mainRepoDir);
    vi.spyOn(realpathSync, "native").mockImplementation((p: string) => {
      return originalRealpath(p) === mainRepoDir ? mainRepoDir : originalRealpath(p);
    });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "start",
        "--no-dashboard",
        "--no-orchestrator",
        "--allow-main-repo",
      ])
    ).rejects.toThrow("process.exit(1)");

    const errors = vi.mocked(console.error).mock.calls.map((c) => c.join(" ")).join("\n");
    expect(errors).not.toContain("Refusing to operate on the main repo");
  });

  it("throws when URL start target path resolves to the main repo (Site 1) (bd-cj5s)", async () => {
    mockConfigRef.current = makeConfig({});
    vi.spyOn(realpathSync, "native").mockImplementation(() => {
      return mainRepoDir;
    });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "start",
        "https://github.com/owner/my-app.git",
        "--no-dashboard",
        "--no-orchestrator",
      ]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi.mocked(console.error).mock.calls.map((c) => c.join(" ")).join("\n");
    expect(errors).toContain("Refusing to operate on the main repo");
  });

  it("allows URL start when --allow-main-repo flag is set (Site 1) (bd-cj5s)", async () => {
    mockConfigRef.current = makeConfig({});
    vi.spyOn(realpathSync, "native").mockImplementation(() => {
      return mainRepoDir;
    });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "start",
        "https://github.com/owner/my-app.git",
        "--no-dashboard",
        "--no-orchestrator",
        "--allow-main-repo",
      ])
    ).resolves.toBeDefined();

    const errors = vi.mocked(console.error).mock.calls.map((c) => c.join(" ")).join("\n");
    expect(errors).not.toContain("Refusing to operate on the main repo");
  });
});
