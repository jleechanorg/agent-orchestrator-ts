import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLifecycleManager } from "../lifecycle-manager.js";
import { writeMetadata } from "../metadata.js";
import { getSessionsDir, getProjectBaseDir } from "../paths.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  SessionManager,
  Session,
  Runtime,
  Agent,
  SCM,
  ActivityState,
} from "../types.js";

// Mock fork-lifecycle-postmerge.js BEFORE importing createLifecycleManager
vi.mock("../fork-lifecycle-postmerge.js", () => ({
  reapPostMergeCoWorkers: vi.fn().mockResolvedValue({
    killed: [],
    hadErrors: false,
    summary: "no co-worker sessions eligible for reaping",
  }),
}));

let tmpDir: string;
let configPath: string;
let sessionsDir: string;
let mockSessionManager: SessionManager;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "spawning",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: tmpDir,
    runtimeHandle: { id: "rt-1", runtimeName: "mock", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makePR(overrides: Partial<import("../types.js").PRInfo> = {}): import("../types.js").PRInfo {
  return {
    number: 42,
    url: "https://github.com/org/repo/pull/42",
    title: "Fix things",
    owner: "org",
    repo: "repo",
    branch: "feat/test",
    baseBranch: "main",
    isDraft: false,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-test-lifecycle-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");

  mockRuntime = {
    name: "mock",
    create: vi.fn(),
    destroy: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getOutput: vi.fn().mockResolvedValue("$ some terminal output\n"),
    isAlive: vi.fn().mockResolvedValue(true),
  };

  mockAgent = {
    name: "mock-agent",
    processName: "mock",
    getLaunchCommand: vi.fn(),
    getEnvironment: vi.fn(),
    detectActivity: vi.fn().mockReturnValue("active" as ActivityState),
    getActivityState: vi.fn().mockResolvedValue({ state: "active" as ActivityState }),
    isProcessRunning: vi.fn().mockResolvedValue(true),
    getSessionInfo: vi.fn().mockResolvedValue(null),
  };

  mockRegistry = {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string) => {
      if (slot === "runtime") return mockRuntime;
      if (slot === "agent") return mockAgent;
      return null;
    }),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn(),
    loadFromConfig: vi.fn(),
  };

  mockSessionManager = {
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    restore: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    kill: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    claimPR: vi.fn(),
  } as SessionManager;

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
      },
    },
    notifiers: {},
    notificationRouting: {
      urgent: ["desktop"],
      action: ["desktop"],
      warning: [],
      info: [],
    },
    reactions: {},
    readyThresholdMs: 300_000,
  };

  sessionsDir = getSessionsDir(configPath, join(tmpDir, "my-app"));
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  const projectBaseDir = getProjectBaseDir(configPath, join(tmpDir, "my-app"));
  if (existsSync(projectBaseDir)) {
    rmSync(projectBaseDir, { recursive: true, force: true });
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("bd-5o1: skip reactions when agent is dead", () => {
  // These tests verify that when the runtime is dead AND the PR state changes,
  // the agentDead flag is preserved through determineStatus() so that checkSession
  // skips reactions (send-to-agent) and auto-merge retry for dead sessions.

  let mockSCM: SCM;

  beforeEach(() => {
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(true);
    mockSCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn(),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };
  });

  function makeRegistryWithSCM(): PluginRegistry {
    return {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };
  }

  it("skips send-to-agent reaction when agent is dead + PR gets changes_requested", async () => {
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);
    vi.mocked(mockSCM.getPRState).mockResolvedValue("open");
    vi.mocked(mockSCM.getReviewDecision).mockResolvedValue("changes_requested");
    vi.mocked(mockSCM.getMergeability).mockResolvedValue({ mergeable: false, noConflicts: true });

    const reactionsConfig: OrchestratorConfig = {
      ...config,
      reactions: {
        "changes-requested": { auto: true, action: "send-to-agent", message: "fix comments" },
      },
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: tmpDir,
      branch: "feat/test",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config: reactionsConfig,
      registry: makeRegistryWithSCM(),
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("changes_requested");
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("skips auto-merge when agent is dead + PR is mergeable", async () => {
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);
    vi.mocked(mockSCM.getPRState).mockResolvedValue("open");
    vi.mocked(mockSCM.getReviewDecision).mockResolvedValue("approved");
    vi.mocked(mockSCM.getMergeability).mockResolvedValue({ mergeable: true, noConflicts: true });
    vi.mocked(mockSCM.getCISummary).mockResolvedValue("passing");

    const reactionsConfig: OrchestratorConfig = {
      ...config,
      reactions: {
        "approved-and-green": { auto: true, action: "auto-merge", mergeMethod: "squash" },
      },
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: tmpDir,
      branch: "feat/test",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config: reactionsConfig,
      registry: makeRegistryWithSCM(),
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("mergeable");
    expect(mockSCM.mergePR).not.toHaveBeenCalled();
  });

  it("fires send-to-agent reaction when agent is alive + PR gets changes_requested", async () => {
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(true);
    vi.mocked(mockAgent.getActivityState).mockResolvedValue({ state: "active" });
    vi.mocked(mockSCM.getPRState).mockResolvedValue("open");
    vi.mocked(mockSCM.getReviewDecision).mockResolvedValue("changes_requested");
    vi.mocked(mockSCM.getMergeability).mockResolvedValue({ mergeable: false, noConflicts: true });

    const reactionsConfig: OrchestratorConfig = {
      ...config,
      reactions: {
        "changes-requested": { auto: true, action: "send-to-agent", message: "fix comments" },
      },
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: tmpDir,
      branch: "feat/test",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config: reactionsConfig,
      registry: makeRegistryWithSCM(),
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("changes_requested");
    expect(mockSessionManager.send).toHaveBeenCalled();
  });

  it("fires auto-merge reaction when agent is dead but PR becomes mergeable (bd-5o1)", async () => {
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(true);
    vi.mocked(mockAgent.getActivityState).mockResolvedValue({ state: "exited" as ActivityState });
    vi.mocked(mockSCM.getPRState).mockResolvedValue("open");
    vi.mocked(mockSCM.getCISummary).mockResolvedValue("passing");
    vi.mocked(mockSCM.getReviewDecision).mockResolvedValue("approved");
    vi.mocked(mockSCM.getMergeability).mockResolvedValue({ mergeable: true, noConflicts: true });
    vi.mocked(mockSCM.mergePR).mockResolvedValue(undefined);

    const reactionsConfig: OrchestratorConfig = {
      ...config,
      projects: {
        "my-app": { ...config.projects!["my-app"], mergeGate: { enabled: false } },
      },
      reactions: {
        "approved-and-green": { auto: true, action: "auto-merge", mergeMethod: "squash" },
      },
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: tmpDir,
      branch: "feat/test",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config: reactionsConfig,
      registry: makeRegistryWithSCM(),
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("mergeable");
    expect(mockSCM.mergePR).toHaveBeenCalled();
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });
});
