/**
 * Regression test: terminal-state promotions (killed→merged) must emit
 * lifecycle.transition events so the activity event log reflects the promotion.
 *
 * Before the fix, checkSession()'s early-return path for already-terminal sessions
 * updated metadata and called reconcileTerminalSessionExit but never called
 * emitLifecycleTransition, leaving a silent gap in the activity log.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// Mocks must precede lifecycle-manager import
vi.mock("../fork-lifecycle-kki-override.js", () => ({
  isPRMerged: vi.fn().mockResolvedValue(false),
}));
vi.mock("../fork-lifecycle-postmerge.js", () => ({
  reapPostMergeCoWorkers: vi.fn().mockResolvedValue({
    killed: [],
    hadErrors: false,
    summary: "no co-worker sessions eligible for reaping",
  }),
}));
vi.mock("../ao-action-log.js", () => ({
  logAoAction: vi.fn(),
}));
vi.mock("../fork-lifecycle-manager.js", async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    detectAndApplyRateLimitPause: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("../lifecycle-activity-events.js", () => ({
  emitLifecycleTransition: vi.fn(),
  emitActivityTransition: vi.fn(),
}));

import { createLifecycleManager } from "../lifecycle-manager.js";
import { writeMetadata } from "../metadata.js";
import { getSessionsDir } from "../paths.js";
import { isPRMerged } from "../fork-lifecycle-kki-override.js";
import { emitLifecycleTransition, emitActivityTransition } from "../lifecycle-activity-events.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  SessionManager,
  Session,
  Runtime,
  Agent,
  PRInfo,
} from "../types.js";

let tmpDir: string;
let configPath: string;
let sessionsDir: string;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockRegistry: PluginRegistry;
let mockSessionManager: SessionManager;
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

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    url: "https://github.com/org/repo/pull/42",
    title: "Fix things",
    owner: "org",
    repo: "repo",
    branch: "feat/test",
    baseBranch: "main",
    isDraft: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(isPRMerged).mockResolvedValue(false);
  vi.mocked(emitLifecycleTransition).mockReset();
  vi.mocked(emitActivityTransition).mockReset();

  tmpDir = join(tmpdir(), `ao-test-terminal-emit-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");

  mockRuntime = {
    name: "mock",
    create: vi.fn(),
    destroy: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getOutput: vi.fn().mockResolvedValue(""),
    isAlive: vi.fn().mockResolvedValue(false),
  };

  mockAgent = {
    name: "mock-agent",
    processName: "mock",
    getLaunchCommand: vi.fn(),
    getEnvironment: vi.fn(),
    detectActivity: vi.fn().mockReturnValue("idle"),
    getActivityState: vi.fn().mockResolvedValue({ state: "idle" }),
    isProcessRunning: vi.fn().mockResolvedValue(false),
    getSessionInfo: vi.fn().mockResolvedValue(null),
  };

  mockRegistry = {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string, _name?: string) => {
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
      notifiers: [],
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
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
    readyThresholdMs: 300_000,
    startupGracePeriodMs: 0,
  };

  sessionsDir = getSessionsDir(configPath, join(tmpDir, "my-app"));
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("terminal-state promotion emits lifecycle.transition (activity log)", () => {
  it("emits killed→merged transition when isPRMerged returns true during terminal poll", async () => {
    // Session is already in terminal "killed" state with an associated PR.
    vi.mocked(isPRMerged).mockResolvedValue(true);

    const session = makeSession({
      status: "killed",
      pr: makePR(),
      workspacePath: join(tmpDir, "non-existent-" + randomUUID()),
    });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "feat/test",
      status: "killed",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // The PR merged — state must be promoted to "merged"
    expect(lm.getStates().get("app-1")).toBe("merged");

    // The promotion must be recorded in the activity event log
    expect(emitLifecycleTransition).toHaveBeenCalledWith(
      "my-app",
      "app-1",
      "killed",
      "merged",
    );
  });
});

describe("activity first-poll seeds from session.activity (cache miss)", () => {
  it("emits activity.transition on first poll when session.activity differs from detected state", async () => {
    // Regression: activityStateCache starts empty on startup; first poll must seed
    // prevActivity from session.activity so transitions occurring while the
    // lifecycle-manager was down are not silently dropped.
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(true);
    vi.mocked(mockAgent.getActivityState).mockResolvedValue({ state: "idle", timestamp: new Date() });

    const session = makeSession({
      status: "working",
      activity: "active", // persisted state from before restart
      metadata: { agent: "mock-agent" },
    });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: tmpDir,
      branch: "feat/test",
      status: "working",
      project: "my-app",
      agent: "mock-agent",
    });

    // Fresh lifecycle manager — activityStateCache is empty
    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Transition from persisted "active" to detected "idle" must be emitted
    expect(emitActivityTransition).toHaveBeenCalledWith(
      "my-app",
      "app-1",
      "active",
      "idle",
    );
  });
});
