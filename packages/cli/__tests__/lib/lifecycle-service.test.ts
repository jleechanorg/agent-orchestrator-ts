/**
 * Tests for the in-process lifecycle-service.
 *
 * Replaces the old subprocess-based test suite (deleted with the
 * `lifecycle-worker` CLI in PR #712). The new API is a thin in-memory
 * Map<projectId, LifecycleManager>: no PID file, no lock file, no subprocess
 * spawn, no `ps` scan. Mirrors upstream `AgentWrapper/agent-orchestrator`
 * PR #1186.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrchestratorConfig } from "@jleechanorg/ao-core";

const mockStart = vi.fn();
const mockStop = vi.fn();
const mockGetLifecycleManager = vi.fn();
const mockSetHealth = vi.fn();
const mockCreateProjectObserver = vi.fn(() => ({ setHealth: mockSetHealth }));

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getLifecycleManager: (...args: unknown[]) => mockGetLifecycleManager(...args),
}));

vi.mock("@jleechanorg/ao-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jleechanorg/ao-core")>();
  return {
    ...actual,
    createProjectObserver: (...args: unknown[]) => mockCreateProjectObserver(...args),
  };
});

function makeFakeLifecycle() {
  return { start: mockStart, stop: mockStop };
}

function makeConfig(projectIds: string[]): OrchestratorConfig {
  return {
    configPath: "/tmp/ao-lifecycle-test/agent-orchestrator.yaml",
    projects: Object.fromEntries(
      projectIds.map((id) => [id, { name: id, path: `/tmp/${id}` }]),
    ),
  } as unknown as OrchestratorConfig;
}

describe("lifecycle-service (in-process)", () => {
  beforeEach(async () => {
    mockStart.mockReset();
    mockStop.mockReset();
    mockGetLifecycleManager.mockReset();
    mockSetHealth.mockReset();
    mockCreateProjectObserver.mockClear();
    mockGetLifecycleManager.mockResolvedValue(makeFakeLifecycle());
    const { __resetLifecycleServiceForTesting } = await import(
      "../../src/lib/lifecycle-service.js"
    );
    __resetLifecycleServiceForTesting();
  });

  it("starts a polling loop for a registered project", async () => {
    const { ensureLifecycleWorker, listLifecycleWorkers, isLifecycleWorkerRunning } =
      await import("../../src/lib/lifecycle-service.js");
    const cfg = makeConfig(["app"]);

    const status = await ensureLifecycleWorker(cfg, "app", 30_000);

    expect(status).toEqual({ running: true, started: true });
    expect(mockStart).toHaveBeenCalledWith(30_000);
    expect(isLifecycleWorkerRunning("app")).toBe(true);
    expect(listLifecycleWorkers()).toEqual(["app"]);
  });

  it("uses the 30s default interval when none is provided", async () => {
    const { ensureLifecycleWorker } = await import("../../src/lib/lifecycle-service.js");
    const cfg = makeConfig(["app"]);

    await ensureLifecycleWorker(cfg, "app");

    expect(mockStart).toHaveBeenCalledWith(30_000);
  });

  it("returns started=false when the project already has a polling loop", async () => {
    const { ensureLifecycleWorker } = await import("../../src/lib/lifecycle-service.js");
    const cfg = makeConfig(["app"]);

    await ensureLifecycleWorker(cfg, "app");
    const second = await ensureLifecycleWorker(cfg, "app");

    expect(second).toEqual({ running: true, started: false });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("throws when the projectId is not registered in config", async () => {
    const { ensureLifecycleWorker } = await import("../../src/lib/lifecycle-service.js");
    const cfg = makeConfig(["app"]);

    await expect(ensureLifecycleWorker(cfg, "missing")).rejects.toThrow(
      "Unknown project: missing",
    );
    expect(mockGetLifecycleManager).not.toHaveBeenCalled();
  });

  it("stopLifecycleWorker halts the polling loop and removes it from the active map", async () => {
    const { ensureLifecycleWorker, stopLifecycleWorker, isLifecycleWorkerRunning } =
      await import("../../src/lib/lifecycle-service.js");
    const cfg = makeConfig(["app"]);

    await ensureLifecycleWorker(cfg, "app");
    expect(isLifecycleWorkerRunning("app")).toBe(true);

    stopLifecycleWorker("app");

    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(isLifecycleWorkerRunning("app")).toBe(false);
  });

  it("stopLifecycleWorker is a no-op for an unknown projectId", async () => {
    const { stopLifecycleWorker } = await import("../../src/lib/lifecycle-service.js");

    expect(() => stopLifecycleWorker("never-started")).not.toThrow();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it("stopAllLifecycleWorkers halts every active project", async () => {
    const { ensureLifecycleWorker, stopAllLifecycleWorkers, listLifecycleWorkers } =
      await import("../../src/lib/lifecycle-service.js");
    const cfg = makeConfig(["a", "b", "c"]);

    await ensureLifecycleWorker(cfg, "a");
    await ensureLifecycleWorker(cfg, "b");
    await ensureLifecycleWorker(cfg, "c");
    expect(listLifecycleWorkers().sort()).toEqual(["a", "b", "c"]);

    stopAllLifecycleWorkers();

    expect(mockStop).toHaveBeenCalledTimes(3);
    expect(listLifecycleWorkers()).toEqual([]);
  });

  it("listLifecycleWorkers reflects the current active set", async () => {
    const { ensureLifecycleWorker, stopLifecycleWorker, listLifecycleWorkers } =
      await import("../../src/lib/lifecycle-service.js");
    const cfg = makeConfig(["a", "b"]);

    expect(listLifecycleWorkers()).toEqual([]);
    await ensureLifecycleWorker(cfg, "a");
    await ensureLifecycleWorker(cfg, "b");
    expect(listLifecycleWorkers().sort()).toEqual(["a", "b"]);

    stopLifecycleWorker("a");
    expect(listLifecycleWorkers()).toEqual(["b"]);
  });

  it("survives lifecycle.stop() throwing — still removes the project from active map", async () => {
    const { ensureLifecycleWorker, stopLifecycleWorker, isLifecycleWorkerRunning } =
      await import("../../src/lib/lifecycle-service.js");
    mockGetLifecycleManager.mockResolvedValueOnce({
      start: mockStart,
      stop: vi.fn(() => {
        throw new Error("LifecycleManager exploded");
      }),
    });
    const cfg = makeConfig(["flaky"]);

    await ensureLifecycleWorker(cfg, "flaky");
    expect(() => stopLifecycleWorker("flaky")).not.toThrow();
    expect(isLifecycleWorkerRunning("flaky")).toBe(false);
  });
});
