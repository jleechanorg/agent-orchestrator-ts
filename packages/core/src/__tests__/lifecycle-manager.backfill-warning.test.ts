import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createLifecycleManager } from "../lifecycle-manager.js";
import { clearAllMessageHashesForSession, clearLastSentHeadSha } from "../dedup-head-sha-store.js";
import { getProjectBaseDir } from "../paths.js";
import type {
  ActivityState,
  Agent,
  OrchestratorConfig,
  PluginRegistry,
  PRInfo,
  Runtime,
  SCM,
  Session,
  SessionManager,
} from "../types.js";
import type { ProjectObserver } from "../observability.js";

let tmpDir: string;
let configPath: string;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockSCM: SCM;
let mockRegistry: PluginRegistry;
let mockSessionManager: SessionManager;
let config: OrchestratorConfig;

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
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

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "changes_requested",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: makePR(),
    workspacePath: tmpDir,
    runtimeHandle: { id: "rt-1", runtimeName: "mock", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function getTestingApi() {
  const manager = createLifecycleManager({
    config,
    registry: mockRegistry,
    sessionManager: mockSessionManager,
  }) as LifecycleManagerForTesting;

  return manager._testing;
}

type LifecycleManagerForTesting = ReturnType<typeof createLifecycleManager> & {
  _testing: {
    executeReaction: (
      sessionId: string,
      projectId: string,
      reactionKey: string,
      reactionConfig: { action: string; message?: string },
      session?: Session,
    ) => Promise<unknown>;
    getReactionConfigForSession: (session: Session, reactionKey: string) => { action: string; message?: string } | null;
    maybeWarnBackfillDisabledWithOpenPRs: (args: {
      projectId: string;
      project: OrchestratorConfig["projects"][string];
      nowMs: number;
      correlationId: string;
      observer: ProjectObserver;
      registry: PluginRegistry;
      lastBackfillWarnTimeByProject: Map<string, number>;
      BACKFILL_WARN_INTERVAL_MS: number;
    }) => Promise<void>;
  };
};

beforeEach(() => {
  clearAllMessageHashesForSession("app-1");
  clearLastSentHeadSha("app-1");
  vi.restoreAllMocks();

  tmpDir = join(tmpdir(), `ao-test-backfill-warning-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");

  mockRuntime = {
    name: "mock",
    create: vi.fn(),
    destroy: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getOutput: vi.fn().mockResolvedValue(""),
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

  mockSCM = {
    name: "mock-scm",
    detectPR: vi.fn(),
    getPRState: vi.fn().mockResolvedValue("open"),
    mergePR: vi.fn(),
    closePR: vi.fn(),
    getCIChecks: vi.fn(),
    getCISummary: vi.fn().mockResolvedValue("passing"),
    getReviews: vi.fn(),
    getReviewDecision: vi.fn().mockResolvedValue("changes_requested"),
    getPendingComments: vi.fn().mockResolvedValue([]),
    getAutomatedComments: vi.fn().mockResolvedValue([]),
    getMergeability: vi.fn(),
    listOpenPRs: vi.fn().mockResolvedValue([]),
  };

  mockRegistry = {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string) => {
      if (slot === "runtime") return mockRuntime;
      if (slot === "agent") return mockAgent;
      if (slot === "scm") return mockSCM;
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
      notifiers: [],
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
      urgent: [],
      action: [],
      warning: [],
      info: [],
    },
    reactions: {},
    readyThresholdMs: 300_000,
    startupGracePeriodMs: 0,
  };
});

afterEach(() => {
  const projectBaseDir = getProjectBaseDir(configPath, join(tmpDir, "my-app"));
  if (existsSync(projectBaseDir)) {
    rmSync(projectBaseDir, { recursive: true, force: true });
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("PR #406 regression coverage", () => {
  it("preserves literal dollar signs when injecting send-to-agent context", async () => {
    config.reactions = {
      "changes-requested": {
        auto: true,
        action: "send-to-agent",
        message: "Review changes requested. Address feedback: {{context}}",
      },
    };

    vi.mocked(mockSCM.getPendingComments).mockResolvedValue([
      {
        id: "c1",
        author: "reviewer",
        body: "Keep literal $1 and $& in the guidance.",
        path: "src/example.ts",
        line: 12,
        isResolved: false,
        createdAt: new Date(),
        url: "https://github.com/org/repo/pull/42/files#diff-1",
      },
    ]);

    const session = makeSession();
    const { executeReaction, getReactionConfigForSession } = getTestingApi();
    const reactionConfig = getReactionConfigForSession(session, "changes-requested");

    expect(reactionConfig).not.toBeNull();

    await executeReaction(session.id, session.projectId, "changes-requested", reactionConfig!, session);

    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    const sentMessage = vi.mocked(mockSessionManager.send).mock.calls[0]![1];
    expect(sentMessage).toContain("Keep literal $1 and $& in the guidance.");
    expect(sentMessage).not.toContain("{{context}}");
  });

  it("records a warning when backfill is disabled and non-draft PRs exist", async () => {
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([
      makePR({ number: 1, isDraft: false }),
      makePR({ number: 2, isDraft: true }),
    ]);

    const observer: ProjectObserver = {
      component: "test",
      recordOperation: vi.fn(),
      setHealth: vi.fn(),
    };

    const { maybeWarnBackfillDisabledWithOpenPRs } = getTestingApi();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(600_001);
    const lastBackfillWarnTimeByProject = new Map<string, number>();

    await maybeWarnBackfillDisabledWithOpenPRs({
      projectId: "my-app",
      project: config.projects["my-app"],
      nowMs: 600_001,
      correlationId: "corr-1",
      observer,
      registry: mockRegistry,
      lastBackfillWarnTimeByProject,
      BACKFILL_WARN_INTERVAL_MS: 600_000,
    });

    expect(mockSCM.listOpenPRs).toHaveBeenCalledTimes(1);
    expect(observer.recordOperation).toHaveBeenCalledWith(expect.objectContaining({
      operation: "lifecycle.backfill.disabled_with_open_prs",
      level: "warn",
      data: { nonDraftOpenPRs: 1 },
    }));
    expect(lastBackfillWarnTimeByProject.get("my-app")).toBe(600_001);

    nowSpy.mockRestore();
  });

  it("suppresses repeated backfill-disabled scans inside the throttle window", async () => {
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([makePR({ number: 1, isDraft: false })]);

    const observer: ProjectObserver = {
      component: "test",
      recordOperation: vi.fn(),
      setHealth: vi.fn(),
    };

    const { maybeWarnBackfillDisabledWithOpenPRs } = getTestingApi();
    const nowSpy = vi.spyOn(Date, "now");
    const lastBackfillWarnTimeByProject = new Map<string, number>();

    nowSpy.mockReturnValue(600_001);
    await maybeWarnBackfillDisabledWithOpenPRs({
      projectId: "my-app",
      project: config.projects["my-app"],
      nowMs: 600_001,
      correlationId: "corr-1",
      observer,
      registry: mockRegistry,
      lastBackfillWarnTimeByProject,
      BACKFILL_WARN_INTERVAL_MS: 600_000,
    });

    nowSpy.mockReturnValue(600_002);
    await maybeWarnBackfillDisabledWithOpenPRs({
      projectId: "my-app",
      project: config.projects["my-app"],
      nowMs: 600_002,
      correlationId: "corr-2",
      observer,
      registry: mockRegistry,
      lastBackfillWarnTimeByProject,
      BACKFILL_WARN_INTERVAL_MS: 600_000,
    });

    expect(mockSCM.listOpenPRs).toHaveBeenCalledTimes(1);

    nowSpy.mockRestore();
  });

  it("updates the throttle window even when listOpenPRs fails", async () => {
    vi.mocked(mockSCM.listOpenPRs!).mockRejectedValue(new Error("rate limited"));

    const observer: ProjectObserver = {
      component: "test",
      recordOperation: vi.fn(),
      setHealth: vi.fn(),
    };

    const { maybeWarnBackfillDisabledWithOpenPRs } = getTestingApi();
    const nowSpy = vi.spyOn(Date, "now");
    const lastBackfillWarnTimeByProject = new Map<string, number>();

    nowSpy.mockReturnValue(600_001);
    await maybeWarnBackfillDisabledWithOpenPRs({
      projectId: "my-app",
      project: config.projects["my-app"],
      nowMs: 600_001,
      correlationId: "corr-1",
      observer,
      registry: mockRegistry,
      lastBackfillWarnTimeByProject,
      BACKFILL_WARN_INTERVAL_MS: 600_000,
    });

    nowSpy.mockReturnValue(600_002);
    await maybeWarnBackfillDisabledWithOpenPRs({
      projectId: "my-app",
      project: config.projects["my-app"],
      nowMs: 600_002,
      correlationId: "corr-2",
      observer,
      registry: mockRegistry,
      lastBackfillWarnTimeByProject,
      BACKFILL_WARN_INTERVAL_MS: 600_000,
    });

    expect(mockSCM.listOpenPRs).toHaveBeenCalledTimes(1);
    expect(observer.recordOperation).not.toHaveBeenCalled();
    expect(lastBackfillWarnTimeByProject.get("my-app")).toBe(600_001);

    nowSpy.mockRestore();
  });
});
