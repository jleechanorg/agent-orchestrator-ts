import { describe, it, expect, vi, beforeEach } from "vitest";
import { reapPostMergeCoWorkers, POST_MERGE_REAPER_CONFIG } from "../fork-lifecycle-postmerge.js";
import type { Session, SessionManager } from "../types.js";
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

      // list() must be called with projectId filter
      expect(sm.list).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: PROJECT_ID }),
      );
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
  });
});
