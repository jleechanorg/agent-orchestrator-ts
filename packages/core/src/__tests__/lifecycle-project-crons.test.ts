import { describe, it, expect, vi, beforeEach } from "vitest";

import type {
  OrchestratorConfig,
  PluginRegistry,
  ProjectConfig,
  Session,
  SessionManager,
} from "../types.js";
import type { ProjectObserver } from "../observability.js";

const {
  mockDrainSpawnQueue,
  mockBackfillUncoveredPRs,
  mockDrainTaskQueue,
  mockRunLocalSkepticCron,
} = vi.hoisted(() => ({
  mockDrainSpawnQueue: vi.fn(),
  mockBackfillUncoveredPRs: vi.fn(),
  mockDrainTaskQueue: vi.fn(),
  mockRunLocalSkepticCron: vi.fn(),
}));

vi.mock("../spawn-queue.js", () => ({
  drainSpawnQueue: mockDrainSpawnQueue,
}));

vi.mock("../backfill-extensions.js", () => ({
  backfillUncoveredPRs: mockBackfillUncoveredPRs,
}));

vi.mock("../task-queue.js", () => ({
  drainTaskQueue: mockDrainTaskQueue,
}));

vi.mock("../skeptic-cron-local.js", () => ({
  runLocalSkepticCron: mockRunLocalSkepticCron,
}));

import {
  maybeWarnBackfillDisabledWithOpenPRs,
  runLifecycleProjectCrons,
} from "../lifecycle-project-crons.js";

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "My App",
    repo: "org/my-app",
    path: "/tmp/my-app",
    defaultBranch: "main",
    sessionPrefix: "app",
    scm: { plugin: "github" },
    ...overrides,
  };
}

function makeObserver(): ProjectObserver {
  return {
    recordOperation: vi.fn(),
    recordSessionStateChange: vi.fn(),
    recordSloStatus: vi.fn(),
  } as unknown as ProjectObserver;
}

describe("runLifecycleProjectCrons", () => {
  let registry: PluginRegistry;
  let sessionManager: SessionManager;
  let observer: ProjectObserver;
  let project: ProjectConfig;
  let activeSessions: Session[];
  let config: OrchestratorConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDrainSpawnQueue.mockResolvedValue(0);
    mockBackfillUncoveredPRs.mockResolvedValue(false);
    mockDrainTaskQueue.mockResolvedValue(0);

    registry = {
      register: vi.fn(),
      get: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn(),
      loadFromConfig: vi.fn(),
    };
    sessionManager = {
      spawn: vi.fn(),
      spawnOrchestrator: vi.fn(),
      restore: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      kill: vi.fn(),
      cleanup: vi.fn(),
      send: vi.fn(),
      claimPR: vi.fn(),
    } as unknown as SessionManager;
    observer = makeObserver();
    project = makeProject({
      backfillAllPRs: false,
      taskQueue: {
        enabled: true,
        maxConcurrent: 1,
        beads: ["bd-test"],
      },
    });
    activeSessions = [];
    config = {
      configPath: "/tmp/agent-orchestrator.yaml",
      port: 3000,
      readyThresholdMs: 300_000,
      startupGracePeriodMs: 0,
      defaults: {
        runtime: "mock",
        agent: "mock",
        workspace: "mock",
        notifiers: [],
      },
      projects: { "my-app": project },
      notifiers: {},
      notificationRouting: {
        urgent: [],
        action: [],
        warning: [],
        info: [],
      },
      reactions: {},
    };
  });

  it("runs non-skeptic lifecycle crons when backfill is disabled", async () => {
    const result = await runLifecycleProjectCrons(
      { registry, sessionManager, observer },
      {
        projectId: "my-app",
        project,
        config,
        activeSessions,
        correlationId: "corr-1",
        nowMs: Date.now(),
        lastBackfillWarnTimeByProject: new Map(),
        backfillWarnIntervalMs: 600_000,
      },
    );

    expect(mockDrainSpawnQueue).toHaveBeenCalledTimes(1);
    expect(mockBackfillUncoveredPRs).not.toHaveBeenCalled();
    expect(mockDrainTaskQueue).toHaveBeenCalledTimes(1);
    expect(result.spawned).toBe(false);
  });

  it("returns spawned=true when the spawn queue creates work and does not drain later queues", async () => {
    mockDrainSpawnQueue.mockResolvedValueOnce(1);

    const result = await runLifecycleProjectCrons(
      { registry, sessionManager, observer },
      {
        projectId: "my-app",
        project,
        config,
        activeSessions,
        correlationId: "corr-spawn",
        nowMs: Date.now(),
        lastBackfillWarnTimeByProject: new Map(),
        backfillWarnIntervalMs: 600_000,
      },
    );

    expect(result.spawned).toBe(true);
    expect(mockDrainSpawnQueue).toHaveBeenCalledTimes(1);
    expect(mockBackfillUncoveredPRs).not.toHaveBeenCalled();
    expect(mockDrainTaskQueue).not.toHaveBeenCalled();
  });

  it("returns spawned=true when the task queue creates work", async () => {
    mockDrainTaskQueue.mockResolvedValueOnce(1);

    const result = await runLifecycleProjectCrons(
      { registry, sessionManager, observer },
      {
        projectId: "my-app",
        project,
        config,
        activeSessions,
        correlationId: "corr-task",
        nowMs: Date.now(),
        lastBackfillWarnTimeByProject: new Map(),
        backfillWarnIntervalMs: 600_000,
      },
    );

    expect(result.spawned).toBe(true);
    expect(mockDrainSpawnQueue).toHaveBeenCalledTimes(1);
    expect(mockDrainTaskQueue).toHaveBeenCalledTimes(1);
  });

  it("does not run local skeptic verification from the project cron path", async () => {
    await runLifecycleProjectCrons(
      { registry, sessionManager, observer },
      {
        projectId: "my-app",
        project,
        config,
        activeSessions,
        correlationId: "corr-no-skeptic",
        nowMs: Date.now(),
        lastBackfillWarnTimeByProject: new Map(),
        backfillWarnIntervalMs: 600_000,
      },
    );

    expect(mockRunLocalSkepticCron).not.toHaveBeenCalled();
  });

  it("isolates cron failures so one broken drainer does not block the next one", async () => {
    mockDrainSpawnQueue.mockRejectedValueOnce(new Error("spawn queue unavailable"));

    await runLifecycleProjectCrons(
      { registry, sessionManager, observer },
      {
        projectId: "my-app",
        project,
        config,
        activeSessions,
        correlationId: "corr-2",
        nowMs: Date.now(),
        lastBackfillWarnTimeByProject: new Map(),
        backfillWarnIntervalMs: 600_000,
      },
    );

    expect(mockDrainTaskQueue).toHaveBeenCalledTimes(1);
    expect(observer.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "lifecycle.spawn_queue.cron_failed",
        outcome: "failure",
        projectId: "my-app",
      }),
    );
  });

  it("uses injected time when recording the disabled-backfill warning throttle", async () => {
    const lastBackfillWarnTimeByProject = new Map<string, number>();
    const listOpenPRs = vi.fn().mockResolvedValue([{ number: 1, isDraft: false }]);
    vi.mocked(registry.get).mockReturnValue({ listOpenPRs });

    await maybeWarnBackfillDisabledWithOpenPRs({
      projectId: "my-app",
      project,
      nowMs: 1_234_567,
      correlationId: "corr-time",
      observer,
      registry,
      lastBackfillWarnTimeByProject,
      BACKFILL_WARN_INTERVAL_MS: 600_000,
    });

    expect(lastBackfillWarnTimeByProject.get("my-app")).toBe(1_234_567);
  });
});
