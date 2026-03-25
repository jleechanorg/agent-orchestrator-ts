/**
 * bd-85r: Startup grace period tests.
 *
 * Verifies that freshly-spawned sessions are not killed by the lifecycle-worker
 * or session-reaper before the agent CLI has fully initialized.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLifecycleManager } from "../lifecycle-manager.js";
import { writeMetadata } from "../metadata.js";
import { getSessionsDir, getProjectBaseDir } from "../paths.js";
import { reapStaleSessions, DEFAULT_REAPER_CONFIG } from "../session-reaper.js";

// Must precede all imports that use the mocked module
vi.mock("../fork-lifecycle-postmerge.js", () => ({
  reapPostMergeCoWorkers: vi.fn().mockResolvedValue({
    killed: [],
    hadErrors: false,
    summary: "no co-worker sessions eligible for reaping",
  }),
}));

import type {
  OrchestratorConfig,
  PluginRegistry,
  SessionManager,
  Session,
  Runtime,
  Agent,
  ActivityState,
} from "../types.js";

let tmpDir: string;
let configPath: string;
let sessionsDir: string;
let mockSessionManager: SessionManager;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "spawning",
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
  tmpDir = join(tmpdir(), `ao-test-grace-${randomUUID()}`);
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
    startupGracePeriodMs: 120_000,
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

// =============================================================================
// determineStatus grace period tests
// =============================================================================

describe("startup grace period in determineStatus (bd-85r)", () => {
  it("does NOT kill a session within the grace period even if agent reports exited", async () => {
    const session = makeSession({
      createdAt: new Date(Date.now() - 10_000), // 10s ago — within 120s grace
      status: "spawning",
      activity: "active",
    });

    // Agent probe says exited — normally this would kill the session
    (mockAgent.getActivityState as ReturnType<typeof vi.fn>).mockResolvedValue({ state: "exited" });
    (mockRuntime.isAlive as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    writeMetadata(sessionsDir, session.id, { worktree: tmpDir, branch: "feat/test", status: "spawning" });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check(session.id);

    // Session should NOT be killed — grace period protects it
    expect(mockSessionManager.kill).not.toHaveBeenCalled();
    // Grace period should skip all probes
    expect(mockRuntime.isAlive).not.toHaveBeenCalled();
    expect(mockAgent.getActivityState).not.toHaveBeenCalled();
  });

  it("DOES kill a session past the grace period when agent reports exited", async () => {
    const session = makeSession({
      createdAt: new Date(Date.now() - 200_000), // 200s ago — past 120s grace
      status: "working",
      activity: "active",
    });

    (mockAgent.getActivityState as ReturnType<typeof vi.fn>).mockResolvedValue({ state: "exited" });
    (mockRuntime.isAlive as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    writeMetadata(sessionsDir, session.id, { worktree: tmpDir, branch: "feat/test", status: "working" });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check(session.id);

    // Session SHOULD transition to killed — past grace period and agent is dead with no SCM
    expect(lm.getStates().get(session.id)).toBe("killed");
  });

  it("preserves spawning status during grace period and skips probes", async () => {
    const session = makeSession({
      createdAt: new Date(Date.now() - 5_000), // 5s ago
      status: "spawning",
    });

    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    writeMetadata(sessionsDir, session.id, { worktree: tmpDir, branch: "feat/test", status: "spawning" });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check(session.id);

    // Should preserve spawning status and not call any probes
    expect(lm.getStates().get(session.id)).toBe("spawning");
    expect(mockSessionManager.kill).not.toHaveBeenCalled();
    expect(mockRuntime.isAlive).not.toHaveBeenCalled();
    expect(mockAgent.getActivityState).not.toHaveBeenCalled();
  });
});

// =============================================================================
// session-reaper grace period tests
// =============================================================================

describe("session-reaper startup grace period (bd-85r)", () => {
  it("skips sessions within startup grace period even if they meet kill conditions", async () => {
    const youngSession = makeSession({
      createdAt: new Date(Date.now() - 10_000), // 10s old
      lastActivityAt: new Date(Date.now() - 10_000),
      activity: "idle",
      pr: null,
    });

    const mockKill = vi.fn();
    const result = await reapStaleSessions(
      {
        ...DEFAULT_REAPER_CONFIG,
        noPrThresholdMs: 0, // Would normally trigger kill immediately
        startupGracePeriodMs: 120_000,
      },
      {
        sessionManager: {
          list: vi.fn().mockResolvedValue([youngSession]),
          kill: mockKill,
        } as unknown as SessionManager,
      },
    );

    expect(result.killed).toHaveLength(0);
    expect(result.skipped.some((s) => s.reason.includes("startup grace"))).toBe(true);
    expect(mockKill).not.toHaveBeenCalled();
  });

  it("reaps sessions past the grace period normally", async () => {
    const oldSession = makeSession({
      createdAt: new Date(Date.now() - 200_000), // 200s old — past grace
      lastActivityAt: new Date(Date.now() - 200_000),
      activity: "idle",
      pr: null,
      status: "working",
    });

    const mockKill = vi.fn();
    const result = await reapStaleSessions(
      {
        ...DEFAULT_REAPER_CONFIG,
        noPrThresholdMs: 0,
        startupGracePeriodMs: 120_000,
      },
      {
        sessionManager: {
          list: vi.fn().mockResolvedValue([oldSession]),
          kill: mockKill,
        } as unknown as SessionManager,
      },
    );

    expect(result.killed).toHaveLength(1);
    expect(mockKill).toHaveBeenCalledWith(oldSession.id);
  });

  it("works without startupGracePeriodMs (backward compatible)", async () => {
    const youngSession = makeSession({
      createdAt: new Date(Date.now() - 10_000),
      lastActivityAt: new Date(Date.now() - 10_000),
      activity: "exited",
      pr: null,
      status: "working",
    });

    const mockKill = vi.fn();
    const result = await reapStaleSessions(
      {
        ...DEFAULT_REAPER_CONFIG,
        orphanedThresholdMs: 0, // Would trigger kill immediately
        // No startupGracePeriodMs — backward compatible
      },
      {
        sessionManager: {
          list: vi.fn().mockResolvedValue([youngSession]),
          kill: mockKill,
        } as unknown as SessionManager,
      },
    );

    // Without grace period, should kill
    expect(result.killed).toHaveLength(1);
  });
});
