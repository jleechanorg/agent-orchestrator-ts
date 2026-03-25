import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  drainTaskQueue,
  resolveBead,
  _resetDrainTimer,
  type TaskQueueDeps,
  type TaskQueueParams,
} from "../task-queue.js";
import type {
  PluginRegistry,
  SessionManager,
  Session,
  ProjectConfig,
} from "../types.js";
import type { ProjectObserver } from "../observability.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s-1",
    projectId: "proj",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/ws",
    runtimeHandle: { id: "rt-1", runtimeName: "mock", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "test",
    repo: "org/repo",
    path: "/tmp/repo",
    defaultBranch: "main",
    sessionPrefix: "test",
    ...overrides,
  };
}

describe("drainTaskQueue", () => {
  let mockSessionManager: SessionManager;
  let mockObserver: ProjectObserver;
  let mockRegistry: PluginRegistry;
  let deps: TaskQueueDeps;

  beforeEach(() => {
    _resetDrainTimer();

    mockObserver = {
      recordOperation: vi.fn(),
    } as unknown as ProjectObserver;

    mockRegistry = {} as PluginRegistry;

    mockSessionManager = {
      spawn: vi.fn<(config: {projectId: string; issueId?: string; prompt?: string}) => Promise<Session>>(),
    } as unknown as SessionManager;

    deps = { registry: mockRegistry, sessionManager: mockSessionManager, observer: mockObserver };
  });

  it("returns 0 when taskQueue is not defined", async () => {
    const project = makeProject();
    const params: TaskQueueParams = {
      projectId: "proj",
      project,
      activeSessions: [],
      correlationId: "corr-1",
    };
    const result = await drainTaskQueue(deps, params);
    expect(result).toBe(0);
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  });

  it("returns 0 when taskQueue.enabled is false", async () => {
    const project = makeProject({
      taskQueue: { enabled: false, maxConcurrent: 4, beads: ["wc-abc"] },
    });
    const params: TaskQueueParams = {
      projectId: "proj",
      project,
      activeSessions: [],
      correlationId: "corr-1",
    };
    const result = await drainTaskQueue(deps, params);
    expect(result).toBe(0);
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  });

  it("returns 0 when taskQueue.beads is empty", async () => {
    const project = makeProject({
      taskQueue: { enabled: true, maxConcurrent: 4, beads: [] },
    });
    const params: TaskQueueParams = {
      projectId: "proj",
      project,
      activeSessions: [],
      correlationId: "corr-1",
    };
    const result = await drainTaskQueue(deps, params);
    expect(result).toBe(0);
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  });

  it("returns 0 when all slots are in use", async () => {
    const project = makeProject({
      taskQueue: { enabled: true, maxConcurrent: 2, beads: ["wc-abc", "wc-def"] },
    });
    const activeSessions = [
      makeSession({ id: "s-1", metadata: { queuedBeadId: "wc-abc" } }),
      makeSession({ id: "s-2", metadata: { queuedBeadId: "wc-def" } }),
    ];
    const params: TaskQueueParams = {
      projectId: "proj",
      project,
      activeSessions,
      correlationId: "corr-1",
    };
    const result = await drainTaskQueue(deps, params);
    expect(result).toBe(0);
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  });

  it("spawns a session for the first undispatched bead when a slot is available", async () => {
    const spawnedSession = makeSession({ id: "s-2" });
    mockSessionManager.spawn = vi.fn().mockResolvedValue(spawnedSession);

    const project: ProjectConfig = {
      name: "test",
      repo: "org/repo",
      path: "/tmp/repo",
      defaultBranch: "main",
      sessionPrefix: "test",
      taskQueue: { enabled: true, maxConcurrent: 4, beads: ["wc-abc", "wc-def"] },
    };
    const activeSessions: Session[] = [
      makeSession({ id: "s-1", metadata: { queuedBeadId: "wc-abc" } }),
    ];
    const params: TaskQueueParams = {
      projectId: "proj",
      project,
      activeSessions,
      correlationId: "corr-1",
    };

    const result = await drainTaskQueue(deps, params);

    expect(result).toBe(1);
    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(1);
    const spawnCall = (mockSessionManager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(spawnCall.projectId).toBe("proj");
    expect(spawnCall.issueId).toBe("wc-def");
    expect(spawnCall.prompt).toContain("wc-def");
    expect(mockObserver.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "lifecycle.task_queue.spawned",
        outcome: "success",
      }),
    );
  });

  it("skips already-dispatched beads even if session is terminal", async () => {
    const spawnedSession = makeSession({ id: "s-2" });
    mockSessionManager.spawn = vi.fn().mockResolvedValue(spawnedSession);

    const project = makeProject({
      taskQueue: { enabled: true, maxConcurrent: 4, beads: ["wc-abc", "wc-def"] },
    });
    // wc-abc session is merged (terminal) but still in activeSessions
    const activeSessions = [
      makeSession({ id: "s-1", status: "merged", metadata: { queuedBeadId: "wc-abc" } }),
    ];
    const params: TaskQueueParams = {
      projectId: "proj",
      project,
      activeSessions,
      correlationId: "corr-1",
    };

    const result = await drainTaskQueue(deps, params);

    expect(result).toBe(1);
    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(1);
    const spawnCall = (mockSessionManager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(spawnCall.issueId).toBe("wc-def");
  });

  it("returns 0 and records failure when spawn throws", async () => {
    mockSessionManager.spawn = vi.fn().mockRejectedValue(new Error("spawn failed"));

    const project = makeProject({
      taskQueue: { enabled: true, maxConcurrent: 4, beads: ["wc-abc"] },
    });
    const params: TaskQueueParams = {
      projectId: "proj",
      project,
      activeSessions: [],
      correlationId: "corr-1",
    };

    const result = await drainTaskQueue(deps, params);

    expect(result).toBe(0);
    expect(mockObserver.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "lifecycle.task_queue.spawn_failed",
        outcome: "failure",
        data: expect.objectContaining({ beadId: "wc-abc", error: "spawn failed" }),
      }),
    );
  });

  it("returns 0 when all beads have been dispatched", async () => {
    const project = makeProject({
      taskQueue: { enabled: true, maxConcurrent: 4, beads: ["wc-abc", "wc-def"] },
    });
    const activeSessions = [
      makeSession({ id: "s-1", metadata: { queuedBeadId: "wc-abc" } }),
      makeSession({ id: "s-2", metadata: { queuedBeadId: "wc-def" } }),
    ];
    const params: TaskQueueParams = {
      projectId: "proj",
      project,
      activeSessions,
      correlationId: "corr-1",
    };

    const result = await drainTaskQueue(deps, params);

    expect(result).toBe(0);
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
    expect(mockObserver.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "lifecycle.task_queue.all_dispatched",
        outcome: "success",
      }),
    );
  });

  it("uses custom taskTemplate when provided", async () => {
    const spawnedSession = makeSession({ id: "s-2" });
    mockSessionManager.spawn = vi.fn().mockResolvedValue(spawnedSession);

    const project = makeProject({
      taskQueue: {
        enabled: true,
        maxConcurrent: 4,
        beads: ["wc-xyz"],
        taskTemplate: "Fix bead {beadId}: {beadTitle} — {beadDescription}",
      },
    });
    const params: TaskQueueParams = {
      projectId: "proj",
      project,
      activeSessions: [],
      correlationId: "corr-1",
    };

    await drainTaskQueue(deps, params);

    const spawnCall = (mockSessionManager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Default resolveBead returns beadId as title/description when `br` is unavailable
    expect(spawnCall.prompt).toContain("Fix bead wc-xyz:");
  });

  it("throttles: returns 0 on rapid successive calls", async () => {
    const spawnedSession = makeSession({ id: "s-2" });
    mockSessionManager.spawn = vi.fn().mockResolvedValue(spawnedSession);

    const project = makeProject({
      taskQueue: { enabled: true, maxConcurrent: 4, beads: ["wc-abc"] },
    });
    const params: TaskQueueParams = {
      projectId: "proj",
      project,
      activeSessions: [],
      correlationId: "corr-1",
    };

    const r1 = await drainTaskQueue(deps, params);
    const r2 = await drainTaskQueue(deps, params);

    expect(r1).toBe(1);
    expect(r2).toBe(0);
    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("resolveBead", () => {
  it("returns beadId as title and description when br is unavailable", () => {
    const result = resolveBead("wc-xyz");
    expect(result.title).toBe("wc-xyz");
    expect(result.description).toBe("Bead wc-xyz");
  });
});
