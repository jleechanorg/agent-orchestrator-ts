/**
 * Unit tests for runLocalSkepticCron call-site guards in lifecycle-manager.
 *
 * Tests verify that the lifecycle-manager poll loop correctly guards the
 * runLocalSkepticCron call:
 * - NOT called when scopedProjectId is undefined
 * - skipped when backfillAllPRs is false
 * - called with correct deps/params when backfillAllPRs is true
 * - poll loop survives throw from runLocalSkepticCron
 *
 * @bd skp2
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLifecycleManager } from "../lifecycle-manager.js";
import type {
  PluginRegistry,
  SessionManager,
  Runtime,
  Agent,
  ActivityState,
} from "../types.js";
import type { SkepticCronDeps, SkepticCronParams } from "../skeptic-cron-local.js";
import { getSessionsDir, getProjectBaseDir } from "../paths.js";
import * as reviewBacklog from "../review-backlog.js";
import { logAoAction } from "../ao-action-log.js";

// Must precede lifecycle-manager import (which imports skeptic-cron-local)
const { mockRunLocalSkepticCron } = vi.hoisted<
  { mockRunLocalSkepticCron: (deps: SkepticCronDeps, params: SkepticCronParams) => Promise<number> }
>(() => ({
  mockRunLocalSkepticCron: vi.fn<
    [SkepticCronDeps, SkepticCronParams],
    Promise<number>
  >().mockResolvedValue(0),
}));

vi.mock("../fork-lifecycle-postmerge.js", () => ({
  reapPostMergeCoWorkers: vi.fn().mockResolvedValue({ killed: [], hadErrors: false, summary: "no co-worker sessions eligible for reaping" }),
}));

vi.mock("../fork-skeptic-extension.js", () => ({
  runSkepticReviewReaction: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("../ao-action-log.js", () => ({
  logAoAction: vi.fn(),
}));

vi.mock("../skeptic-cron-local.js", () => ({
  runLocalSkepticCron: mockRunLocalSkepticCron,
  _resetSkepticCronTimer: vi.fn(),
}));

let tmpDir: string;
let configPath: string;
let sessionsDir: string;
let mockSessionManager: SessionManager;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockRegistry: PluginRegistry;
let config: {
  configPath: string;
  port: number;
  defaults: Record<string, unknown>;
  projects: Record<string, { name: string; repo: string; path: string; defaultBranch: string; sessionPrefix: string; scm: { plugin: string }; backfillAllPRs?: boolean }>;
  notifiers: Record<string, unknown>;
  notificationRouting: Record<string, string[]>;
  reactions: Record<string, unknown>;
  readyThresholdMs: number;
  startupGracePeriodMs: number;
};

beforeEach(() => {
  reviewBacklog.resetAllReviewBacklogCounters();
  vi.mocked(logAoAction).mockReset();
  vi.mocked(mockRunLocalSkepticCron).mockReset().mockResolvedValue(0);

  tmpDir = join(tmpdir(), `ao-test-lifecycle-skeptic-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");

  mockRuntime = {
    name: "mock",
    create: vi.fn(),
    destroy: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getOutput: vi.fn().mockResolvedValue("$ some terminal output\n"),
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

  mockRegistry = {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string) => {
      if (slot === "runtime") return mockRuntime;
      if (slot === "agent") return mockAgent;
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
      notifiers: ["desktop"],
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
      urgent: ["desktop"],
      action: ["desktop"],
      warning: [],
      info: [],
    },
    reactions: {},
    readyThresholdMs: 300_000,
    startupGracePeriodMs: 0,
  };

  sessionsDir = getSessionsDir(configPath, join(tmpDir, "my-app"));
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  const projectBaseDir = getProjectBaseDir(configPath, join(tmpDir, "my-app"));
  if (existsSync(projectBaseDir)) {
    rmSync(projectBaseDir, { recursive: true, force: true });
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runLocalSkepticCron integration (bd-skp2)", () => {
  it("runLocalSkepticCron is NOT called when scopedProjectId is undefined", async () => {
    // No projectId → scopedProjectId is undefined → skeptic cron guard skips
    vi.mocked(mockSessionManager.list).mockResolvedValue([]);
    const lm = createLifecycleManager({
      config, // scopedProjectId is undefined here
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });
    try {
      lm.start(60_000);
      // Yield to the event loop so pollAll gets a chance to run at least once
      // before we assert the guard skipped the skeptic-cron call.
      await new Promise<void>(r => setTimeout(r, 10));
      // scopedProjectId is undefined so the if (scopedProjectId) block is never entered
      expect(mockRunLocalSkepticCron).not.toHaveBeenCalled();
    } finally {
      lm.stop();
    }
  });

  it("runLocalSkepticCron is skipped when backfillAllPRs is false", async () => {
    vi.mocked(mockSessionManager.list).mockResolvedValue([]);
    const configNoBackfill = {
      ...config,
      projects: {
        "my-app": {
          ...config.projects["my-app"],
          backfillAllPRs: false,
        },
      },
    };
    const lm = createLifecycleManager({
      config: configNoBackfill,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      projectId: "my-app",
    });
    try {
      lm.start(60_000);
      await new Promise<void>(r => setTimeout(r, 10));
      expect(mockRunLocalSkepticCron).not.toHaveBeenCalled();
    } finally {
      lm.stop();
    }
  });

  it("runLocalSkepticCron is called when scopedProjectId is set and backfillAllPRs is true", async () => {
    vi.mocked(mockSessionManager.list).mockResolvedValue([]);
    const configWithBackfill = {
      ...config,
      projects: {
        "my-app": {
          ...config.projects["my-app"],
          backfillAllPRs: true,
        },
      },
    };
    const lm = createLifecycleManager({
      config: configWithBackfill,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      projectId: "my-app",
    });
    try {
      lm.start(60_000);
      await vi.waitUntil(() => vi.mocked(mockRunLocalSkepticCron).mock.calls.length > 0, { timeout: 3000 });
      expect(mockRunLocalSkepticCron).toHaveBeenCalledTimes(1);
      const [deps, params] = vi.mocked(mockRunLocalSkepticCron).mock.calls[0]!;
      expect(params.projectId).toBe("my-app");
      expect(params.project).toBe(configWithBackfill.projects["my-app"]);
      expect(params.activeSessions).toEqual([]);
      expect(params.correlationId).toBeDefined();
      expect(deps.registry).toBe(mockRegistry);
      expect(deps.sessionManager).toBe(mockSessionManager);
    } finally {
      lm.stop();
    }
  });

  it("runLocalSkepticCron throw does NOT crash the poll loop", async () => {
    vi.mocked(mockSessionManager.list).mockResolvedValue([]);
    vi.mocked(mockRunLocalSkepticCron).mockRejectedValueOnce(new Error("skepticro_err"));
    const configWithBackfill = {
      ...config,
      projects: {
        "my-app": {
          ...config.projects["my-app"],
          backfillAllPRs: true,
        },
      },
    };
    const lm = createLifecycleManager({
      config: configWithBackfill,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      projectId: "my-app",
    });
    try {
      // pollAll is called with "void pollAll()" inside start(), so it runs asynchronously.
      // Wait until mockRunLocalSkepticCron is called — this means pollAll has reached
      // the skeptic cron call site (even if it throws). If the throw escaped the
      // try/catch, pollAll would reject and the error would propagate differently.
      lm.start(60_000);
      await vi.waitUntil(
        () => vi.mocked(mockRunLocalSkepticCron).mock.calls.length > 0,
        { timeout: 5000 },
      );
      // Verify it was called once — the throw was caught by the try/catch in pollAll,
      // so the poll loop continued without crashing.
      expect(mockRunLocalSkepticCron).toHaveBeenCalledTimes(1);
    } finally {
      lm.stop();
    }
  });
});
