import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  Session,
  ProjectConfig,
} from "../types.js";
import type { ProjectObserver } from "../observability.js";

// ---- Mock the entire task-queue module so we can spy/mocks its dependencies ----
vi.mock("../paths.js", () => ({
  getSessionsDir: vi.fn(() => "/tmp/test-sessions"),
}));

vi.mock("../metadata.js", () => ({
  updateMetadata: vi.fn(),
}));

// Re-import AFTER vi.mock declarations so the mocks are active
const { drainTaskQueue, resolveBead, _resetDrainTimer } = await import("../task-queue.js");
import type { TaskQueueDeps, TaskQueueParams } from "../task-queue.js";
import type { SessionManager } from "../types.js";

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

function makeParams(overrides: Partial<TaskQueueParams> = {}): TaskQueueParams {
  return {
    projectId: "proj",
    project: makeProject(),
    configPath: "/tmp/config.yaml",
    activeSessions: [],
    correlationId: "corr-1",
    ...overrides,
  };
}

describe("drainTaskQueue", () => {
  // Module-level mocks reset per-test
  const spawnMock = vi.fn<(config: {projectId: string; issueId?: string; prompt?: string}) => Promise<Session>>();
  const recordOperationMock = vi.fn();

  let mockObserver: ProjectObserver;
  let mockRegistry: Record<string, unknown>;
  let deps: TaskQueueDeps;

  beforeEach(() => {
    _resetDrainTimer();
    spawnMock.mockReset().mockResolvedValue(makeSession({ id: "s-new" }));
    recordOperationMock.mockReset();

    mockObserver = { recordOperation: recordOperationMock } as unknown as ProjectObserver;
    mockRegistry = {};

    const mockSessionManager = {
      spawn: spawnMock,
    } as unknown as SessionManager;

    deps = { registry: mockRegistry, sessionManager: mockSessionManager, observer: mockObserver };
  });

  it("returns 0 when taskQueue is not defined", async () => {
    const params = makeParams({ project: makeProject() });
    const result = await drainTaskQueue(deps, params);
    expect(result).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns 0 when taskQueue.enabled is false", async () => {
    const params = makeParams({
      project: makeProject({ taskQueue: { enabled: false, maxConcurrent: 4, beads: ["wc-abc"] } }),
    });
    const result = await drainTaskQueue(deps, params);
    expect(result).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns 0 when taskQueue.beads is empty", async () => {
    const params = makeParams({
      project: makeProject({ taskQueue: { enabled: true, maxConcurrent: 4, beads: [] } }),
    });
    const result = await drainTaskQueue(deps, params);
    expect(result).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns 0 when all slots are in use", async () => {
    const params = makeParams({
      project: makeProject({ taskQueue: { enabled: true, maxConcurrent: 2, beads: ["wc-abc", "wc-def"] } }),
      activeSessions: [
        makeSession({ id: "s-1", metadata: { queuedBeadId: "wc-abc" } }),
        makeSession({ id: "s-2", metadata: { queuedBeadId: "wc-def" } }),
      ],
    });
    const result = await drainTaskQueue(deps, params);
    expect(result).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns a session for the first undispatched bead when a slot is available", async () => {
    spawnMock.mockResolvedValueOnce(makeSession({ id: "s-new" }));

    const params = makeParams({
      project: makeProject({ taskQueue: { enabled: true, maxConcurrent: 4, beads: ["wc-abc", "wc-def"] } }),
      activeSessions: [makeSession({ id: "s-1", metadata: { queuedBeadId: "wc-abc" } })],
    });

    const result = await drainTaskQueue(deps, params);

    expect(result).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const spawnCall = spawnMock.mock.calls[0][0];
    expect(spawnCall.projectId).toBe("proj");
    expect(spawnCall.issueId).toBe("wc-def");
    expect(spawnCall.prompt).toContain("wc-def");
    expect(recordOperationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "lifecycle.task_queue.spawned",
        outcome: "success",
      }),
    );
  });

  it("skips already-dispatched beads even if session is terminal", async () => {
    spawnMock.mockResolvedValueOnce(makeSession({ id: "s-new" }));

    const params = makeParams({
      project: makeProject({ taskQueue: { enabled: true, maxConcurrent: 4, beads: ["wc-abc", "wc-def"] } }),
      // wc-abc session is merged (terminal) but still in activeSessions
      activeSessions: [makeSession({ id: "s-1", status: "merged", metadata: { queuedBeadId: "wc-abc" } })],
    });

    const result = await drainTaskQueue(deps, params);

    expect(result).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const spawnCall = spawnMock.mock.calls[0][0];
    expect(spawnCall.issueId).toBe("wc-def");
  });

  it("returns 0 and records failure when spawn throws", async () => {
    spawnMock.mockRejectedValueOnce(new Error("spawn failed"));

    const params = makeParams({
      project: makeProject({ taskQueue: { enabled: true, maxConcurrent: 4, beads: ["wc-abc"] } }),
    });

    const result = await drainTaskQueue(deps, params);

    expect(result).toBe(0);
    expect(recordOperationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "lifecycle.task_queue.spawn_failed",
        outcome: "failure",
        data: expect.objectContaining({ beadId: "wc-abc", error: "spawn failed" }),
      }),
    );
  });

  it("returns 0 when all beads have been dispatched", async () => {
    const params = makeParams({
      project: makeProject({ taskQueue: { enabled: true, maxConcurrent: 4, beads: ["wc-abc", "wc-def"] } }),
      activeSessions: [
        makeSession({ id: "s-1", metadata: { queuedBeadId: "wc-abc" } }),
        makeSession({ id: "s-2", metadata: { queuedBeadId: "wc-def" } }),
      ],
    });

    const result = await drainTaskQueue(deps, params);

    expect(result).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(recordOperationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "lifecycle.task_queue.all_dispatched",
        outcome: "success",
      }),
    );
  });

  it("uses custom taskTemplate when provided", async () => {
    spawnMock.mockResolvedValueOnce(makeSession({ id: "s-new" }));

    const params = makeParams({
      project: makeProject({
        taskQueue: {
          enabled: true,
          maxConcurrent: 4,
          beads: ["wc-xyz"],
          taskTemplate: "Fix bead {beadId}: {beadTitle} — {beadDescription}",
        },
      }),
    });

    await drainTaskQueue(deps, params);

    const spawnCall = spawnMock.mock.calls[0][0];
    // Default resolveBead returns beadId as title/description when `br` is unavailable
    expect(spawnCall.prompt).toContain("Fix bead wc-xyz:");
  });

  it("throttles: returns 0 on rapid successive calls", async () => {
    spawnMock.mockResolvedValueOnce(makeSession({ id: "s-new" }));

    const params = makeParams({
      project: makeProject({ taskQueue: { enabled: true, maxConcurrent: 4, beads: ["wc-abc"] } }),
    });

    const r1 = await drainTaskQueue(deps, params);
    const r2 = await drainTaskQueue(deps, params);

    expect(r1).toBe(1);
    expect(r2).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveBead", () => {
  it("returns beadId as title and description when br is unavailable", () => {
    const result = resolveBead("wc-xyz");
    expect(result.title).toBe("wc-xyz");
    expect(result.description).toBe("Bead wc-xyz");
  });
});
