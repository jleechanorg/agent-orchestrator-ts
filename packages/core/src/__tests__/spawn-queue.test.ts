import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetSpawnQueueTimer,
  countActiveSessions,
  drainSpawnQueue,
  enqueueSpawnRequest,
  hasSpawnCapacity,
  resolveSpawnQueueConfig,
  type DrainSpawnQueueDeps,
  type DrainSpawnQueueParams,
} from "../spawn-queue.js";
import type { Session } from "../types.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-session",
    projectId: "proj",
    status: "working",
    activity: "active",
    branch: null,
    issueId: null,
    pr: null,
    lastActivityAt: new Date(),
    metadata: {},
    runtimeHandle: null,
    ...overrides,
  } as Session;
}

function makeObserver(): DrainSpawnQueueDeps["observer"] {
  return { recordOperation: vi.fn() } as unknown as DrainSpawnQueueDeps["observer"];
}

function makeSessionManager(overrides: Partial<DrainSpawnQueueDeps["sessionManager"]> = {}): DrainSpawnQueueDeps["sessionManager"] {
  return {
    spawn: vi.fn().mockResolvedValue(makeSession()),
    claimPR: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as DrainSpawnQueueDeps["sessionManager"];
}

describe("spawn-queue", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "spawn-queue-test-"));
    configPath = join(tmpDir, "config.yaml");
    // The paths.ts module calls realpathSync(configPath) — the file must exist
    writeFileSync(configPath, "# test config\n");
    _resetSpawnQueueTimer();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("resolveSpawnQueueConfig", () => {
    it("returns defaults when no project config", () => {
      const cfg = resolveSpawnQueueConfig(undefined);
      expect(cfg.enabled).toBe(true);
      expect(cfg.maxActiveSessions).toBe(20);
    });

    it("respects project-level overrides", () => {
      const cfg = resolveSpawnQueueConfig({
        spawnQueue: { enabled: false, maxActiveSessions: 5 },
      } as Parameters<typeof resolveSpawnQueueConfig>[0]);
      expect(cfg.enabled).toBe(false);
      expect(cfg.maxActiveSessions).toBe(5);
    });
  });

  describe("countActiveSessions", () => {
    it("counts non-terminal sessions", () => {
      const sessions = [
        makeSession({ status: "working" }),
        makeSession({ status: "done" }),    // terminal
        makeSession({ status: "errored" }), // terminal
        makeSession({ status: "working" }),
      ];
      expect(countActiveSessions(sessions)).toBe(2);
    });

    it("returns 0 for empty list", () => {
      expect(countActiveSessions([])).toBe(0);
    });

    it("counts all terminal statuses as inactive", () => {
      const sessions = [
        makeSession({ status: "killed" }),
        makeSession({ status: "terminated" }),
        makeSession({ status: "merged" }),
        makeSession({ status: "cleanup" }),
      ];
      expect(countActiveSessions(sessions)).toBe(0);
    });
  });

  describe("hasSpawnCapacity", () => {
    it("returns true when under max", () => {
      const sessions = [makeSession(), makeSession()];
      expect(hasSpawnCapacity(sessions, {
        spawnQueue: { enabled: true, maxActiveSessions: 5 },
      } as Parameters<typeof resolveSpawnQueueConfig>[0])).toBe(true);
    });

    it("returns false when at max", () => {
      const sessions = [makeSession(), makeSession()];
      expect(hasSpawnCapacity(sessions, {
        spawnQueue: { enabled: true, maxActiveSessions: 2 },
      } as Parameters<typeof resolveSpawnQueueConfig>[0])).toBe(false);
    });

    it("returns true when disabled regardless of count", () => {
      const sessions = [makeSession(), makeSession(), makeSession()];
      expect(hasSpawnCapacity(sessions, {
        spawnQueue: { enabled: false, maxActiveSessions: 1 },
      } as Parameters<typeof resolveSpawnQueueConfig>[0])).toBe(true);
    });
  });

  describe("enqueueSpawnRequest", () => {
    it("enqueues a request and returns position", () => {
      const result = enqueueSpawnRequest(configPath, "proj-1", { issueId: "issue-1" });
      expect(result.requestId).toMatch(/^sq-/);
      expect(result.position).toBe(1);
    });

    it("throws when queue is full", () => {
      for (let i = 0; i < 100; i++) {
        enqueueSpawnRequest(configPath, "proj-full", { issueId: `issue-${i}` });
      }
      expect(() => enqueueSpawnRequest(configPath, "proj-full", {})).toThrow("Spawn queue is full");
    });

    it("persists multiple requests in order", () => {
      enqueueSpawnRequest(configPath, "proj-2", { issueId: "a" });
      const result = enqueueSpawnRequest(configPath, "proj-2", { issueId: "b" });
      expect(result.position).toBe(2);
    });
  });

  describe("drainSpawnQueue", () => {
    function makeDeps(smOverrides: Partial<DrainSpawnQueueDeps["sessionManager"]> = {}): DrainSpawnQueueDeps {
      return {
        sessionManager: makeSessionManager(smOverrides),
        observer: makeObserver(),
      };
    }

    function makeParams(overrides: Partial<DrainSpawnQueueParams> = {}): DrainSpawnQueueParams {
      return {
        projectId: "proj",
        project: { path: tmpDir } as DrainSpawnQueueParams["project"],
        configPath,
        activeSessions: [],
        correlationId: "corr-1",
        ...overrides,
      };
    }

    it("returns 0 when queue is disabled", async () => {
      const deps = makeDeps();
      const params = makeParams({
        project: { path: tmpDir, spawnQueue: { enabled: false } } as DrainSpawnQueueParams["project"],
      });
      const result = await drainSpawnQueue(deps, params);
      expect(result).toBe(0);
    });

    it("returns 0 when drain interval not elapsed", async () => {
      enqueueSpawnRequest(configPath, "proj", {});
      const deps = makeDeps();
      const params = makeParams();
      await drainSpawnQueue(deps, params);
      // Immediately re-drain without resetting timer — should be throttled
      const result = await drainSpawnQueue(deps, params);
      expect(result).toBe(0);
    });

    it("returns 0 when no pending requests", async () => {
      const deps = makeDeps();
      const result = await drainSpawnQueue(deps, makeParams());
      expect(result).toBe(0);
    });

    it("returns 0 when at capacity", async () => {
      enqueueSpawnRequest(configPath, "proj", {});
      const deps = makeDeps();
      const activeSessions = Array.from({ length: 20 }, (_, i) =>
        makeSession({ id: `s-${i}` }),
      );
      const result = await drainSpawnQueue(deps, makeParams({ activeSessions }));
      expect(result).toBe(0);
      const observer = deps.observer as { recordOperation: ReturnType<typeof vi.fn> };
      expect(observer.recordOperation).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "lifecycle.spawn_queue.at_capacity" }),
      );
    });

    it("spawns and removes head of queue on success", async () => {
      enqueueSpawnRequest(configPath, "proj", { issueId: "issue-1" });
      const deps = makeDeps();
      const result = await drainSpawnQueue(deps, makeParams());
      expect(result).toBe(1);
      const sm = deps.sessionManager as { spawn: ReturnType<typeof vi.fn> };
      expect(sm.spawn).toHaveBeenCalled();
      const observer = deps.observer as { recordOperation: ReturnType<typeof vi.fn> };
      expect(observer.recordOperation).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "lifecycle.spawn_queue.spawned" }),
      );
    });

    it("also calls claimPR when claimPr is set", async () => {
      enqueueSpawnRequest(configPath, "proj", { claimPr: "123", issueId: "issue-2" });
      const deps = makeDeps();
      await drainSpawnQueue(deps, makeParams());
      const sm = deps.sessionManager as { claimPR: ReturnType<typeof vi.fn> };
      expect(sm.claimPR).toHaveBeenCalled();
    });

    it("retries on spawn failure and drops after max retries", async () => {
      enqueueSpawnRequest(configPath, "proj-retry", {});
      const deps = makeDeps({
        spawn: vi.fn().mockRejectedValue(new Error("spawn failed")),
      });
      const params = makeParams({ projectId: "proj-retry" });

      // Three drain cycles with reset timer each time — 3 retries = exhausted
      _resetSpawnQueueTimer();
      await drainSpawnQueue(deps, params);
      _resetSpawnQueueTimer();
      await drainSpawnQueue(deps, params);
      _resetSpawnQueueTimer();
      await drainSpawnQueue(deps, params);

      const observer = deps.observer as { recordOperation: ReturnType<typeof vi.fn> };
      const ops = (observer.recordOperation as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => (c[0] as { operation: string }).operation,
      );
      expect(ops).toContain("lifecycle.spawn_queue.dropped");
    });

    it("records spawn_failed (not dropped) on first retry", async () => {
      enqueueSpawnRequest(configPath, "proj-retry2", {});
      const deps = makeDeps({
        spawn: vi.fn().mockRejectedValue(new Error("spawn failed")),
      });
      const params = makeParams({ projectId: "proj-retry2" });
      await drainSpawnQueue(deps, params);
      const observer = deps.observer as { recordOperation: ReturnType<typeof vi.fn> };
      const ops = (observer.recordOperation as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => (c[0] as { operation: string }).operation,
      );
      expect(ops).toContain("lifecycle.spawn_queue.spawn_failed");
      expect(ops).not.toContain("lifecycle.spawn_queue.dropped");
    });

    it("preserves issueId, lineage, and siblings through enqueue→drain (decompose context regression)", async () => {
      // Regression: capped --decompose leaves must spawn with the same context as the direct path.
      enqueueSpawnRequest(configPath, "proj-decompose", {
        issueId: "parent-issue-42",
        lineage: ["root-task", "subtask-A"],
        siblings: ["subtask-B description", "subtask-C description"],
        agent: "codex",
        prompt: "implement subtask-A",
      });

      const spawnMock = vi.fn().mockResolvedValue(makeSession({ id: "decompose-session" }));
      const deps = makeDeps({ spawn: spawnMock });
      const result = await drainSpawnQueue(deps, makeParams({ projectId: "proj-decompose" }));

      expect(result).toBe(1);
      expect(spawnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-decompose",
          issueId: "parent-issue-42",
          lineage: ["root-task", "subtask-A"],
          siblings: ["subtask-B description", "subtask-C description"],
          agent: "codex",
          prompt: "implement subtask-A",
        }),
      );
    });
  });
});
