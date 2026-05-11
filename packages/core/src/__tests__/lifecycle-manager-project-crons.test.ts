import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const { mockRunLifecycleProjectCrons } = vi.hoisted(() => ({
  mockRunLifecycleProjectCrons: vi.fn(),
}));

vi.mock("../lifecycle-project-crons.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lifecycle-project-crons.js")>();
  return {
    ...actual,
    runLifecycleProjectCrons: mockRunLifecycleProjectCrons,
  };
});

import { createLifecycleManager } from "../lifecycle-manager.js";
import { getProjectBaseDir, getSessionsDir } from "../paths.js";
import { clearAllMessageHashesForSession, clearLastSentHeadSha } from "../dedup-head-sha-store.js";
import type {
  ActivityState,
  Agent,
  Notifier,
  OrchestratorConfig,
  PluginRegistry,
  Runtime,
  Session,
  SessionManager,
} from "../types.js";

let tmpDir: string;
let configPath: string;
let sessionsDir: string;
let config: OrchestratorConfig;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockNotifier: Notifier;
let mockRegistry: PluginRegistry;
let mockSessionManager: SessionManager;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "working",
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

beforeEach(() => {
  clearAllMessageHashesForSession("app-1");
  clearLastSentHeadSha("app-1");
  vi.restoreAllMocks();
  mockRunLifecycleProjectCrons.mockReset();

  tmpDir = join(tmpdir(), `ao-test-lifecycle-project-crons-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");
  sessionsDir = getSessionsDir(configPath, join(tmpDir, "my-app"));
  mkdirSync(sessionsDir, { recursive: true });

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

  mockNotifier = {
    name: "mock-notifier",
    notify: vi.fn().mockResolvedValue(undefined),
  };

  mockRegistry = {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string) => {
      if (slot === "runtime") return mockRuntime;
      if (slot === "agent") return mockAgent;
      if (slot === "notifier") return mockNotifier;
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
    list: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    kill: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    claimPR: vi.fn(),
  } as unknown as SessionManager;

  config = {
    configPath,
    port: 3000,
    defaults: {
      runtime: "mock",
      agent: "mock-agent",
      workspace: "mock-ws",
      notifiers: ["mock-notifier"],
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
      info: ["mock-notifier"],
    },
    reactions: {
      "all-complete": {
        auto: true,
        action: "notify",
        priority: "info",
      },
    },
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

describe("lifecycle manager project crons", () => {
  it("emits all-complete after prior sessions finish when project crons do not spawn work", async () => {
    mockRunLifecycleProjectCrons.mockResolvedValue({ spawned: false });
    vi.mocked(mockSessionManager.list)
      .mockResolvedValueOnce([makeSession()])
      .mockResolvedValueOnce([makeSession()])
      .mockResolvedValue([]);

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      projectId: "my-app",
    });

    try {
      lm.start(25);
      await vi.waitUntil(() => vi.mocked(mockNotifier.notify).mock.calls.length > 0, { timeout: 5000 });
      expect(vi.mocked(mockNotifier.notify).mock.calls[0]?.[0].data).toMatchObject({
        reactionKey: "all-complete",
      });
    } finally {
      lm.stop();
    }
  });

  it("suppresses all-complete when a project cron spawns work from a stale active-session snapshot", async () => {
    mockRunLifecycleProjectCrons.mockResolvedValue({ spawned: true });
    vi.mocked(mockSessionManager.list)
      .mockResolvedValueOnce([makeSession()])
      .mockResolvedValueOnce([makeSession()])
      .mockResolvedValue([]);

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      projectId: "my-app",
    });

    try {
      lm.start(25);
      await vi.waitUntil(
        () => mockRunLifecycleProjectCrons.mock.calls.some((call) => call[1]?.activeSessions?.length === 0),
        { timeout: 5000 },
      );
      expect(mockNotifier.notify).not.toHaveBeenCalled();
    } finally {
      lm.stop();
    }
  });
});
