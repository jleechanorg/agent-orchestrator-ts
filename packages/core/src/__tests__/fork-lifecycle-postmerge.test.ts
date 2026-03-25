import { describe, it, expect, vi, beforeEach } from "vitest";
import { reapPostMergeCoWorkers, POST_MERGE_REAPER_CONFIG } from "../fork-lifecycle-postmerge.js";
import type {
  Session,
  SessionManager,
  OrchestratorConfig,
  PluginRegistry,
  OrchestratorEvent,
  EventPriority,
  EventType,
} from "../types.js";
import type { ProjectObserver } from "../observability.js";

const PROJECT_ID = "test-project";
const BASE_NOW = new Date("2025-01-01T12:00:00Z");
const FIVE_MIN_MS = 5 * 60_000;
const FOUR_HOURS_MS = 14_400_000;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "worker-1",
    projectId: PROJECT_ID,
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/worker-1",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
    lastActivityAt: new Date(BASE_NOW.getTime() - FIVE_MIN_MS - 1000),
    metadata: {},
    ...overrides,
  };
}

function makeObserver(): ProjectObserver {
  return {
    recordOperation: vi.fn(),
  };
}

function makeSessionManager(): SessionManager {
  return {
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    restore: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
    send: vi.fn(),
    claimPR: vi.fn(),
  };
}

describe("fork-lifecycle-postmerge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST_MERGE_REAPER_CONFIG", () => {
    it("idleThresholdMs is 5 minutes", () => {
      expect(POST_MERGE_REAPER_CONFIG.idleThresholdMs).toBe(FIVE_MIN_MS);
    });
  });

  describe("reapPostMergeCoWorkers", () => {
    it("calls sessionManager.list with the merged session's projectId", async () => {
      const sm = makeSessionManager();
      const observer = makeObserver();
      const mergedSession = makeSession();

      await reapPostMergeCoWorkers(mergedSession, sm, observer);

      // list() must be called with the merged session's projectId (string)
      expect(sm.list).toHaveBeenCalledWith(PROJECT_ID);
    });

    it("records success when co-workers are reaped", async () => {
      const sm = makeSessionManager();
      // Simulate one co-worker session present and killed
      (sm.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        makeSession({ id: "co-worker-1" }),
      ]);
      const observer = makeObserver();
      const mergedSession = makeSession();

      const result = await reapPostMergeCoWorkers(mergedSession, sm, observer);

      expect(result.killed).toHaveLength(1);
      expect(result.hadErrors).toBe(false);
      expect(observer.recordOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "lifecycle.post_merge_reap",
          outcome: "success",
          projectId: PROJECT_ID,
        }),
      );
    });

    it("records failure when some kills fail (partial failure)", async () => {
      const sm = makeSessionManager();
      (sm.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        makeSession({ id: "co-worker-1" }),
        makeSession({ id: "co-worker-2" }),
      ]);
      (sm.kill as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("kill rejected"));
      const observer = makeObserver();
      const mergedSession = makeSession();

      const result = await reapPostMergeCoWorkers(mergedSession, sm, observer);

      expect(result.killed).toHaveLength(1);
      expect(result.hadErrors).toBe(true);
      // Partial failure op should be recorded
      expect(observer.recordOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "lifecycle.post_merge_reap_partial_failure",
          outcome: "failure",
        }),
      );
    });

    it("records failure when reapStaleSessions throws", async () => {
      const sm = makeSessionManager();
      (sm.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("session store unavailable"),
      );
      const observer = makeObserver();
      const mergedSession = makeSession();

      const result = await reapPostMergeCoWorkers(mergedSession, sm, observer);

      expect(result.killed).toHaveLength(0);
      expect(result.hadErrors).toBe(true);
      expect(observer.recordOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "lifecycle.post_merge_reap",
          outcome: "failure",
          level: "warn",
        }),
      );
    });

    it("does not call observer when no sessions are eligible and no errors occur", async () => {
      const sm = makeSessionManager();
      // Empty session list → no one to reap
      (sm.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      const observer = makeObserver();
      const mergedSession = makeSession();

      const result = await reapPostMergeCoWorkers(mergedSession, sm, observer);

      expect(result.killed).toHaveLength(0);
      expect(result.hadErrors).toBe(false);
      expect(observer.recordOperation).not.toHaveBeenCalled();
    });

    // ─── Exit notification tests (orch-s66) ─────────────────────────────────
    // Reaped co-worker sessions must emit session.exited notifications
    // just like the primary merged session does via validateAndEmitExitProof in
    // lifecycle-manager. Without this, Slack thread terminal updates are skipped
    // for co-workers that are cleaned up as part of the post-merge sweep.

    it("emits exit proof via notifyHuman for each reaped co-worker", async () => {
      const sm = makeSessionManager();
      const coWorker = makeSession({ id: "co-worker-1", pr: null });
      (sm.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([coWorker]);
      (sm.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(coWorker);
      const observer = makeObserver();
      const mergedSession = makeSession();

      const notifyHuman = vi.fn().mockResolvedValue(undefined);
      const createEvent = vi.fn().mockReturnValue({
        type: "session.exited" as EventType,
        sessionId: "co-worker-1",
        projectId: PROJECT_ID,
        message: "",
        data: {},
        timestamp: new Date().toISOString(),
        correlationId: "test",
      });

      // orch-s66: exit proof deps are required to emit notifications for reaped sessions
      await reapPostMergeCoWorkers(mergedSession, sm, observer, {
        config: { projects: { [PROJECT_ID]: {} } } as unknown as OrchestratorConfig,
        registry: {} as PluginRegistry,
        observer,
        notifyHuman,
        createEvent,
      });

      // Without SCM in test config, event type is "session.exit_failed" and priority is "warning".
      // The key assertion is that createEvent WAS called with the correct session context.
      expect(createEvent).toHaveBeenCalledWith(
        "session.exit_failed",
        expect.objectContaining({ sessionId: "co-worker-1", projectId: PROJECT_ID }),
      );
      expect(notifyHuman).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "co-worker-1" }),
        "warning",
      );
    });

    it("emits exit proof for multiple reaped co-workers", async () => {
      const sm = makeSessionManager();
      const coWorker1 = makeSession({ id: "co-worker-1" });
      const coWorker2 = makeSession({ id: "co-worker-2" });
      (sm.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([coWorker1, coWorker2]);
      (sm.get as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(coWorker1)
        .mockResolvedValueOnce(coWorker2);
      const observer = makeObserver();
      const mergedSession = makeSession();

      const notifyHuman = vi.fn().mockResolvedValue(undefined);
      const createEvent = vi.fn().mockReturnValue({
        type: "session.exited" as EventType,
        sessionId: "test",
        projectId: PROJECT_ID,
        message: "",
        data: {},
        timestamp: new Date().toISOString(),
        correlationId: "test",
      });

      await reapPostMergeCoWorkers(mergedSession, sm, observer, {
        config: { projects: { [PROJECT_ID]: {} } } as unknown as OrchestratorConfig,
        registry: {} as PluginRegistry,
        observer,
        notifyHuman,
        createEvent,
      });

      // One exit proof event per reaped co-worker
      expect(createEvent).toHaveBeenCalledTimes(2);
      expect(notifyHuman).toHaveBeenCalledTimes(2);
    });

    it("does not emit exit proof when exitProofDeps are not provided", async () => {
      const sm = makeSessionManager();
      (sm.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        makeSession({ id: "co-worker-1" }),
      ]);
      const observer = makeObserver();
      const mergedSession = makeSession();

      // No exitProofDeps passed — exit proof block must be skipped
      const result = await reapPostMergeCoWorkers(mergedSession, sm, observer);

      expect(result.killed).toHaveLength(1);
      expect(result.hadErrors).toBe(false);
      // Only the post_merge_reap summary call, no exit proof
      expect(observer.recordOperation).toHaveBeenCalledTimes(1);
      expect(observer.recordOperation).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "lifecycle.post_merge_reap" }),
      );
    });

    it("does not emit exit proof for the merged session itself", async () => {
      const sm = makeSessionManager();
      // Merged session is NOT in the list — reapStaleSessions skips it via
      // TERMINAL_STATUSES filter. Verify notifyHuman is NOT called for it.
      (sm.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      const observer = makeObserver();
      const mergedSession = makeSession();

      const notifyHuman = vi.fn().mockResolvedValue(undefined);
      const createEvent = vi.fn().mockReturnValue({
        type: "session.exited" as EventType,
        sessionId: "test",
        projectId: PROJECT_ID,
        message: "",
        data: {},
        timestamp: new Date().toISOString(),
        correlationId: "test",
      });

      await reapPostMergeCoWorkers(mergedSession, sm, observer, {
        config: { projects: { [PROJECT_ID]: {} } } as unknown as OrchestratorConfig,
        registry: {} as PluginRegistry,
        observer,
        notifyHuman,
        createEvent,
      });

      expect(createEvent).not.toHaveBeenCalled();
      expect(notifyHuman).not.toHaveBeenCalled();
    });

    it("records lifecycle.exit_proof operation for each reaped co-worker", async () => {
      const sm = makeSessionManager();
      const coWorker = makeSession({ id: "co-worker-1" });
      (sm.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([coWorker]);
      (sm.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(coWorker);
      const observer = makeObserver();
      const mergedSession = makeSession();

      const notifyHuman = vi.fn().mockResolvedValue(undefined);
      const createEvent = vi.fn().mockReturnValue({
        type: "session.exited" as EventType,
        sessionId: "co-worker-1",
        projectId: PROJECT_ID,
        message: "",
        data: {},
        timestamp: new Date().toISOString(),
        correlationId: "test",
      });

      await reapPostMergeCoWorkers(mergedSession, sm, observer, {
        config: { projects: { [PROJECT_ID]: {} } } as unknown as OrchestratorConfig,
        registry: {} as PluginRegistry,
        observer,
        notifyHuman,
        createEvent,
      });

      // observer.recordOperation must be called with lifecycle.exit_proof for the reaped session.
      // Outcome is "failure" here because the test config has no SCM plugin (validateCommits
      // unavailable), which is expected — the key assertion is that lifecycle.exit_proof IS recorded.
      // (called FIRST; post_merge_reap summary is called second)
      expect(observer.recordOperation).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          operation: "lifecycle.exit_proof",
          sessionId: "co-worker-1",
          projectId: PROJECT_ID,
        }),
      );
    });
  });
});
