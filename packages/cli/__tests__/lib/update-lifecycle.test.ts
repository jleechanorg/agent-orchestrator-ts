import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import chalk from "chalk";

const mockLoadConfig = vi.fn();
const mockFindManagedConfigFile = vi.fn();
const mockGetSessionManager = vi.fn();
const mockGetRunning = vi.fn();
const mockRecordActivityEvent = vi.fn();
const mockSessions = { value: [] as Array<{ id: string; status: string; activity: string | null; projectId: string }> };
const mockSpawn = vi.fn();

vi.mock("@jleechanorg/ao-core", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  findManagedConfigFile: () => mockFindManagedConfigFile(),
  isTerminalSession: (session: { status: string; activity: string | null }) => {
    return (
      ["done", "killed", "terminated", "errored", "merged", "cleanup"].includes(session.status) ||
      session.activity === "exited"
    );
  },
  recordActivityEvent: (...args: unknown[]) => mockRecordActivityEvent(...args),
}));

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: (...args: unknown[]) => mockGetSessionManager(...args),
}));

vi.mock("../../src/lib/running-state.js", () => ({
  getRunning: (...args: unknown[]) => mockGetRunning(...args),
}));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock("chalk", () => ({
  default: {
    yellow: (s: string) => s,
    red: (s: string) => s,
    dim: (s: string) => s,
    green: (s: string) => s,
  },
}));

function createMockChild(exitCode: number | null, signal?: NodeJS.Signals) {
  const child = new EventEmitter();
  setTimeout(() => child.emit("exit", exitCode, signal ?? null), 0);
  return child;
}

import {
  getUpdateLifecyclePlan,
  pauseSupervisorsBeforeUpdate,
  verifyUpdatePause,
  shouldRestartAfterUpdate,
  restartAoAfterUpdate,
} from "../../src/lib/update-lifecycle.js";

describe("update-lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessions.value = [];
    mockGetRunning.mockResolvedValue(null);
    mockFindManagedConfigFile.mockReturnValue(null);
    mockLoadConfig.mockReset();
    mockGetSessionManager.mockReset();
    mockRecordActivityEvent.mockReset();
    mockSpawn.mockReset();
  });

  describe("getUpdateLifecyclePlan", () => {
    it("returns no active sessions when no daemon is running and no global config", async () => {
      mockGetRunning.mockResolvedValue(null);
      mockFindManagedConfigFile.mockReturnValue(null);

      const plan = await getUpdateLifecyclePlan();

      expect(plan.runningBeforeUpdate).toBe(false);
      expect(plan.activeSessions).toEqual([]);
      expect(plan.primaryProjectId).toBeUndefined();
    });

    it("detects active sessions from running daemon", async () => {
      mockGetRunning.mockResolvedValue({
        pid: 12345,
        configPath: "/tmp/global-config.yaml",
        port: 3000,
        startedAt: new Date().toISOString(),
        projects: ["my-app"],
      });
      mockLoadConfig.mockReturnValue({
        projects: { "my-app": { path: "/tmp/foo" } },
        configPath: "/tmp/global-config.yaml",
      });
      mockSessions.value = [
        { id: "feat-1", status: "working", activity: null, projectId: "my-app" },
      ];
      mockGetSessionManager.mockResolvedValue({
        list: async () => mockSessions.value,
      });

      const plan = await getUpdateLifecyclePlan();

      expect(plan.runningBeforeUpdate).toBe(true);
      expect(plan.primaryProjectId).toBe("my-app");
      expect(plan.activeSessions).toHaveLength(1);
      expect(plan.activeSessions[0].id).toBe("feat-1");
    });

    it("detects active sessions from global config when no daemon", async () => {
      mockGetRunning.mockResolvedValue(null);
      mockFindManagedConfigFile.mockReturnValue("/tmp/global-config.yaml");
      mockLoadConfig.mockReturnValue({
        projects: { "my-app": { path: "/tmp/foo" } },
        configPath: "/tmp/global-config.yaml",
      });
      mockSessions.value = [
        { id: "feat-2", status: "idle", activity: null, projectId: "my-app" },
      ];
      mockGetSessionManager.mockResolvedValue({
        list: async () => mockSessions.value,
      });

      const plan = await getUpdateLifecyclePlan();

      expect(plan.runningBeforeUpdate).toBe(false);
      expect(plan.activeSessions).toHaveLength(1);
      expect(plan.primaryProjectId).toBe("my-app");
    });

    it("filters out terminal sessions", async () => {
      mockGetRunning.mockResolvedValue(null);
      mockFindManagedConfigFile.mockReturnValue("/tmp/global-config.yaml");
      mockLoadConfig.mockReturnValue({
        projects: { "my-app": { path: "/tmp/foo" } },
        configPath: "/tmp/global-config.yaml",
      });
      mockSessions.value = [
        { id: "old-1", status: "done", activity: "exited", projectId: "my-app" },
        { id: "old-2", status: "killed", activity: null, projectId: "my-app" },
      ];
      mockGetSessionManager.mockResolvedValue({
        list: async () => mockSessions.value,
      });

      const plan = await getUpdateLifecyclePlan();

      expect(plan.activeSessions).toEqual([]);
    });

    it("returns empty on error without blocking update", async () => {
      mockGetRunning.mockRejectedValue(new Error("broken"));

      const plan = await getUpdateLifecyclePlan();

      expect(plan.runningBeforeUpdate).toBe(false);
      expect(plan.activeSessions).toEqual([]);
    });
  });

  describe("pauseSupervisorsBeforeUpdate", () => {
    it("does not stop when no daemon and no active sessions", async () => {
      const plan: Awaited<ReturnType<typeof getUpdateLifecyclePlan>> = {
        runningBeforeUpdate: false,
        activeSessions: [],
      };

      const didStop = await pauseSupervisorsBeforeUpdate(plan);

      expect(didStop).toBe(false);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("stops daemon when running with active sessions", async () => {
      const plan: Awaited<ReturnType<typeof getUpdateLifecyclePlan>> = {
        runningBeforeUpdate: true,
        primaryProjectId: "my-app",
        activeSessions: [
          { id: "feat-1", status: "working", activity: null, projectId: "my-app" } as any,
        ],
      };
      mockSpawn.mockReturnValue(createMockChild(0));
      mockGetRunning.mockResolvedValue(null);
      mockFindManagedConfigFile.mockReturnValue(null);

      const didStop = await pauseSupervisorsBeforeUpdate(plan);

      expect(didStop).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith(
        "ao",
        ["stop", "--yes"],
        expect.objectContaining({ stdio: "inherit" }),
      );
    });

    it("exits when ao stop fails", async () => {
      const plan: Awaited<ReturnType<typeof getUpdateLifecyclePlan>> = {
        runningBeforeUpdate: true,
        primaryProjectId: "my-app",
        activeSessions: [
          { id: "feat-1", status: "working", activity: null, projectId: "my-app" } as any,
        ],
      };
      mockSpawn.mockReturnValue(createMockChild(1));
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit(1)");
      });

      await expect(pauseSupervisorsBeforeUpdate(plan)).rejects.toThrow("process.exit(1)");

      expect(mockRecordActivityEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "cli.update_failed" }),
      );
      exitSpy.mockRestore();
    });
  });

  describe("verifyUpdatePause", () => {
    it("returns true when AO is fully stopped", async () => {
      mockGetRunning.mockResolvedValue(null);
      mockFindManagedConfigFile.mockReturnValue(null);

      const plan: Awaited<ReturnType<typeof getUpdateLifecyclePlan>> = {
        runningBeforeUpdate: true,
        primaryProjectId: "my-app",
        activeSessions: [{ id: "feat-1", status: "working", activity: null, projectId: "my-app" } as any],
      };

      const ok = await verifyUpdatePause(plan);

      expect(ok).toBe(true);
    });

    it("returns false when AO still appears active after stop", async () => {
      mockGetRunning.mockResolvedValue({
        pid: 12345,
        configPath: "/tmp/global-config.yaml",
        port: 3000,
        startedAt: new Date().toISOString(),
        projects: ["my-app"],
      });
      mockLoadConfig.mockReturnValue({
        projects: { "my-app": { path: "/tmp/foo" } },
        configPath: "/tmp/global-config.yaml",
      });
      mockSessions.value = [
        { id: "feat-1", status: "working", activity: null, projectId: "my-app" },
      ];
      mockGetSessionManager.mockResolvedValue({
        list: async () => mockSessions.value,
      });

      const plan: Awaited<ReturnType<typeof getUpdateLifecyclePlan>> = {
        runningBeforeUpdate: true,
        primaryProjectId: "my-app",
        activeSessions: [{ id: "feat-1", status: "working", activity: null, projectId: "my-app" } as any],
      };

      const ok = await verifyUpdatePause(plan);

      expect(ok).toBe(false);
      expect(mockRecordActivityEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "cli.update_failed" }),
      );
    });
  });

  describe("shouldRestartAfterUpdate", () => {
    it("restarts when daemon was running before update", () => {
      const plan: Awaited<ReturnType<typeof getUpdateLifecyclePlan>> = {
        runningBeforeUpdate: true,
        primaryProjectId: "my-app",
        activeSessions: [],
      };

      expect(shouldRestartAfterUpdate(plan, true)).toBe(true);
    });

    it("does not restart when daemon was not running before update", () => {
      const plan: Awaited<ReturnType<typeof getUpdateLifecyclePlan>> = {
        runningBeforeUpdate: false,
        primaryProjectId: "my-app",
        activeSessions: [{ id: "orphan-1", status: "working", activity: null, projectId: "my-app" } as any],
      };

      expect(shouldRestartAfterUpdate(plan, true)).toBe(false);
    });

    it("does not restart when nothing was stopped", () => {
      const plan: Awaited<ReturnType<typeof getUpdateLifecyclePlan>> = {
        runningBeforeUpdate: true,
        primaryProjectId: "my-app",
        activeSessions: [],
      };

      expect(shouldRestartAfterUpdate(plan, false)).toBe(false);
    });
  });

  describe("restartAoAfterUpdate", () => {
    it("restarts with --restore by default", async () => {
      const plan: Awaited<ReturnType<typeof getUpdateLifecyclePlan>> = {
        runningBeforeUpdate: true,
        primaryProjectId: "my-app",
        activeSessions: [],
      };
      mockSpawn.mockReturnValue(createMockChild(0));

      await restartAoAfterUpdate(plan, { restore: true });

      expect(mockSpawn).toHaveBeenCalledWith(
        "ao",
        ["start", "my-app", "--restore"],
        expect.objectContaining({ stdio: "inherit" }),
      );
    });

    it("restarts with --no-restore when requested", async () => {
      const plan: Awaited<ReturnType<typeof getUpdateLifecyclePlan>> = {
        runningBeforeUpdate: true,
        primaryProjectId: "my-app",
        activeSessions: [],
      };
      mockSpawn.mockReturnValue(createMockChild(0));

      await restartAoAfterUpdate(plan, { restore: false });

      expect(mockSpawn).toHaveBeenCalledWith(
        "ao",
        ["start", "my-app", "--no-restore"],
        expect.objectContaining({ stdio: "inherit" }),
      );
    });

    it("exits on restart failure", async () => {
      const plan: Awaited<ReturnType<typeof getUpdateLifecyclePlan>> = {
        runningBeforeUpdate: true,
        primaryProjectId: "my-app",
        activeSessions: [],
      };
      mockSpawn.mockReturnValue(createMockChild(1));
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit(1)");
      });

      await expect(restartAoAfterUpdate(plan, { restore: true })).rejects.toThrow(
        "process.exit(1)",
      );

      expect(mockRecordActivityEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "cli.update_restart_failed" }),
      );
      exitSpy.mockRestore();
    });
  });

  describe("full lifecycle orchestration", () => {
    it("cleans up orphaned active sessions without starting a daemon that was not running", async () => {
      mockGetRunning.mockResolvedValue(null);
      mockFindManagedConfigFile.mockReturnValue("/tmp/global-config.yaml");
      mockLoadConfig.mockReturnValue({
        projects: { "my-app": { path: "/tmp/foo" } },
        configPath: "/tmp/global-config.yaml",
      });
      mockSessions.value = [
        { id: "orphan-1", status: "working", activity: null, projectId: "my-app" },
      ];
      mockGetSessionManager.mockResolvedValue({
        list: async () => mockSessions.value,
      });
      mockSpawn.mockImplementation(() => {
        mockSessions.value = [];
        return createMockChild(0);
      });

      const plan = await getUpdateLifecyclePlan();
      const didStop = await pauseSupervisorsBeforeUpdate(plan);

      expect(didStop).toBe(true);

      const needsRestart = shouldRestartAfterUpdate(plan, didStop);
      expect(needsRestart).toBe(false);
    });
  });
});
