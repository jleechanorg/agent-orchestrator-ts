import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
  lstatSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { SessionManager } from "@jleechanorg/ao-core";
import { stringify as yamlStringify, parse as parseYaml } from "yaml";

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
});

afterEach(() => {
  process.env = originalEnv;
  if (cwdSpy) cwdSpy.mockRestore();
  if (originalAoGlobalConfig === undefined) delete process.env["AO_GLOBAL_CONFIG"];
  else process.env["AO_GLOBAL_CONFIG"] = originalAoGlobalConfig;
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

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

describe("start command — browser open regression tests (bd-#667)", () => {
  it("skips browser open when AO_NO_OPEN_BROWSER env var is set (regression: bd-#667)", async () => {
    const prev = process.env["AO_NO_OPEN_BROWSER"];
    process.env["AO_NO_OPEN_BROWSER"] = "1";
    try {
      mockConfigRef.current = makeConfig({ "my-app": makeProject() });

      const { findWebDir } = await import("../../src/lib/web-dir.js");
      vi.mocked(findWebDir).mockReturnValue(tmpDir);
      writeFileSync(join(tmpDir, "package.json"), "{}");

      mockSessionManager.get.mockResolvedValue(null);
      mockSessionManager.spawnOrchestrator.mockResolvedValue({ id: "app-orchestrator" });

      await program.parseAsync(["node", "test", "start", "--no-orchestrator"]);

      expect(mockWaitForPortAndOpen).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env["AO_NO_OPEN_BROWSER"];
      else process.env["AO_NO_OPEN_BROWSER"] = prev;
    }
  });

  it("skips browser open when openBrowser: false in YAML config (regression: bd-#667)", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    const cfg = mockConfigRef.current as Record<string, unknown>;
    (cfg as { openBrowser?: boolean }).openBrowser = false;
    writeFileSync(cfg.configPath as string, yamlStringify(cfg, { indent: 2 }));

    const { findWebDir } = await import("../../src/lib/web-dir.js");
    vi.mocked(findWebDir).mockReturnValue(tmpDir);
    writeFileSync(join(tmpDir, "package.json"), "{}");

    mockSessionManager.get.mockResolvedValue(null);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({ id: "app-orchestrator" });

    await program.parseAsync(["node", "test", "start", "--no-orchestrator"]);

    expect(mockWaitForPortAndOpen).not.toHaveBeenCalled();
  });

  it("skips browser open when --no-open-browser CLI flag is set (regression: bd-#667)", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    const { findWebDir } = await import("../../src/lib/web-dir.js");
    vi.mocked(findWebDir).mockReturnValue(tmpDir);
    writeFileSync(join(tmpDir, "package.json"), "{}");

    mockSessionManager.get.mockResolvedValue(null);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({ id: "app-orchestrator" });

    await program.parseAsync(["node", "test", "start", "--no-orchestrator", "--no-open-browser"]);

    expect(mockWaitForPortAndOpen).not.toHaveBeenCalled();
  });

  it("still calls waitForPortAndOpen when no suppression is set (regression: bd-#667)", async () => {
    const prev = process.env["AO_NO_OPEN_BROWSER"];
    delete process.env["AO_NO_OPEN_BROWSER"];
    try {
      mockConfigRef.current = makeConfig({ "my-app": makeProject() });

      const { findWebDir } = await import("../../src/lib/web-dir.js");
      vi.mocked(findWebDir).mockReturnValue(tmpDir);
      writeFileSync(join(tmpDir, "package.json"), "{}");

      mockSessionManager.get.mockResolvedValue(null);
      mockSessionManager.spawnOrchestrator.mockResolvedValue({ id: "app-orchestrator" });

      await program.parseAsync(["node", "test", "start", "--no-orchestrator"]);

      expect(mockWaitForPortAndOpen).toHaveBeenCalledTimes(1);
    } finally {
      if (prev !== undefined) process.env["AO_NO_OPEN_BROWSER"] = prev;
    }
  });
});
