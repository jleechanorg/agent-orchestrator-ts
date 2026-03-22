import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLifecycleManager } from "../lifecycle-manager.js";
import { createSessionManager } from "../session-manager.js";
import * as reviewBacklog from "../review-backlog.js";
import { writeMetadata, readMetadataRaw } from "../metadata.js";
import { getSessionsDir, getProjectBaseDir } from "../paths.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  SessionManager,
  Session,
  Runtime,
  Agent,
  SCM,
  Notifier,
  ActivityState,
  PRInfo,
  SessionExitProof,
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
  // bd-yjo: Reset review backlog throttle counters between tests
  reviewBacklog.resetAllReviewBacklogCounters();

  tmpDir = join(tmpdir(), `ao-test-lifecycle-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  // Create a temporary config file
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
  };

  // Calculate sessions directory
  sessionsDir = getSessionsDir(configPath, join(tmpDir, "my-app"));
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  // Clean up hash-based directories in ~/.agent-orchestrator
  const projectBaseDir = getProjectBaseDir(configPath, join(tmpDir, "my-app"));
  if (existsSync(projectBaseDir)) {
    rmSync(projectBaseDir, { recursive: true, force: true });
  }

  // Clean up tmpDir
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("start / stop", () => {
  it("starts and stops the polling loop", () => {
    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    lm.start(60_000);
    // Should not throw on double start
    lm.start(60_000);
    lm.stop();
    // Should not throw on double stop
    lm.stop();
  });
});

describe("sequential session polling (bd-wse)", () => {
  it("pollAll processes later sessions after one checkSession rejects", async () => {
    const sessions = [
      makeSession({ id: "app-1", status: "spawning" }),
      makeSession({ id: "app-2", status: "spawning" }),
      makeSession({ id: "app-3", status: "spawning" }),
    ];

    for (const s of sessions) {
      writeMetadata(sessionsDir, s.id, {
        worktree: "/tmp",
        branch: "main",
        status: "spawning",
        project: "my-app",
      });
    }

    vi.mocked(mockSessionManager.list).mockResolvedValue(sessions);
    vi.mocked(mockSessionManager.get).mockImplementation(async (id) =>
      sessions.find((s) => s.id === id) ?? null,
    );

    // `determineStatus` treats rejected `isAlive` as alive (`.catch(() => true)`), so
    // force a real rejection from a post-status hook to exercise the pollAll loop.
    const origDispatch = reviewBacklog.maybeDispatchReviewBacklog;
    const dispatchSpy = vi.spyOn(reviewBacklog, "maybeDispatchReviewBacklog").mockImplementation(
      async (session, oldStatus, newStatus, deps, transitionReaction) => {
        if (session.id === "app-2") {
          throw new Error("forced session check failure");
        }
        return origDispatch(session, oldStatus, newStatus, deps, transitionReaction);
      },
    );

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    try {
      lm.start(60_000);
      await vi.waitUntil(() => lm.getStates().get("app-3") === "working", { timeout: 5000 });
      expect(lm.getStates().get("app-1")).toBe("working");
    } finally {
      dispatchSpy.mockRestore();
      lm.stop();
    }
  });
});

describe("check (single session)", () => {
  it("detects transition from spawning to working", async () => {
    const session = makeSession({ status: "spawning" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    // Write metadata so updateMetadata works
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("working");

    // Metadata should be updated
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["status"]).toBe("working");
  });

  it("uses worker-specific agent fallback when metadata does not persist an agent", async () => {
    const codexAgent: Agent = {
      ...mockAgent,
      name: "codex",
      processName: "codex",
      getActivityState: vi.fn().mockResolvedValue({ state: "active" as ActivityState }),
    };
    const registryWithMultipleAgents: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") {
          if (name === "codex") return codexAgent;
          if (name === "mock-agent") return mockAgent;
        }
        return null;
      }),
    };
    const configWithWorkerAgent: OrchestratorConfig = {
      ...config,
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          agent: "mock-agent",
          worker: {
            agent: "codex",
          },
        },
      },
    };
    const session = makeSession({ status: "working", metadata: {} });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config: configWithWorkerAgent,
      registry: registryWithMultipleAgents,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(codexAgent.getActivityState).toHaveBeenCalled();
    expect(mockAgent.getActivityState).not.toHaveBeenCalled();
  });

  it("detects killed state when runtime is dead", async () => {
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("killed");
    // auto-kill runtime to prevent session accumulation (jleechan-v7oa)
    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1");
  });

  it("does NOT kill runtime when orchestrator session transitions to killed (preserve pause metadata — jleechan-v7oa)", async () => {
    // Orchestrator sessions must not be auto-killed: killing the orchestrator clears
    // its rate-limit pause metadata, which would unblock workers before the pause expires.
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    const orchestratorSession = makeSession({
      id: "my-app-orchestrator",
      status: "working",
      metadata: { role: "orchestrator" },
    });
    vi.mocked(mockSessionManager.get).mockResolvedValue(orchestratorSession);

    writeMetadata(sessionsDir, "my-app-orchestrator", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      role: "orchestrator",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("my-app-orchestrator");

    expect(lm.getStates().get("my-app-orchestrator")).toBe("killed");
    // Orchestrator kill must be skipped to preserve pause metadata
    expect(mockSessionManager.kill).not.toHaveBeenCalled();
  });

  it("detects killed state when getActivityState returns exited", async () => {
    vi.mocked(mockAgent.getActivityState).mockResolvedValue({ state: "exited" });

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("killed");
    // auto-kill runtime to prevent session accumulation (jleechan-v7oa)
    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1");
  });

  it("returns mergeable (not killed) when agent exited but PR is green (bd-ara)", async () => {
    // Fix 2 test: agent exit must not mask a mergeable PR. When the agent has
    // exited but the session has a PR that is approved + CI green + no conflicts,
    // determineStatus should return "mergeable" so auto-merge can fire.
    vi.mocked(mockAgent.getActivityState).mockResolvedValue({ state: "exited" });

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("approved"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      }),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "working", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("mergeable");
  });

  it("returns killed when agent exited and PR is not green (bd-ara)", async () => {
    // Companion: agent exited + PR not approved → should still kill
    vi.mocked(mockAgent.getActivityState).mockResolvedValue({ state: "exited" });

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: false,
        ciPassing: true,
        approved: false,
        noConflicts: true,
        blockers: [],
      }),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "working", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("killed");
  });

  it("returns killed when agent exited and session has no PR (bd-ara)", async () => {
    // No PR → no reason to defer the kill
    vi.mocked(mockAgent.getActivityState).mockResolvedValue({ state: "exited" });

    const session = makeSession({ status: "working", pr: null });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("killed");
  });

  it("detects killed via terminal fallback when getActivityState returns null", async () => {
    vi.mocked(mockAgent.getActivityState).mockResolvedValue(null);
    vi.mocked(mockAgent.detectActivity).mockReturnValue("idle");
    vi.mocked(mockAgent.isProcessRunning).mockResolvedValue(false);

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("killed");
  });

  it("stays working when agent is idle but process is still running (fallback path)", async () => {
    vi.mocked(mockAgent.getActivityState).mockResolvedValue(null);
    vi.mocked(mockAgent.detectActivity).mockReturnValue("idle");
    vi.mocked(mockAgent.isProcessRunning).mockResolvedValue(true);

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("working");
  });

  it("detects needs_input from agent", async () => {
    vi.mocked(mockAgent.getActivityState).mockResolvedValue({ state: "waiting_input" });

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("needs_input");
  });

  it("transitions to stuck when idle exceeds agent-stuck threshold (OpenCode-style activity)", async () => {
    config.reactions = {
      "agent-stuck": {
        auto: true,
        action: "notify",
        threshold: "1m",
      },
    };

    vi.mocked(mockAgent.getActivityState).mockResolvedValue({
      state: "idle",
      timestamp: new Date(Date.now() - 120_000),
    });

    const session = makeSession({ status: "working", metadata: { agent: "opencode" } });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("uses global agent-stuck threshold when project override omits threshold", async () => {
    config.reactions = {
      "agent-stuck": {
        auto: true,
        action: "notify",
        threshold: "1m",
      },
    };
    config.projects["my-app"] = {
      ...config.projects["my-app"],
      reactions: {
        "agent-stuck": {
          auto: true,
          action: "notify",
        },
      },
    };

    vi.mocked(mockAgent.getActivityState).mockResolvedValue({
      state: "idle",
      timestamp: new Date(Date.now() - 120_000),
    });

    const session = makeSession({ status: "working", metadata: { agent: "opencode" } });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("still auto-detects PR before marking idle sessions as stuck", async () => {
    config.reactions = {
      "agent-stuck": {
        auto: true,
        action: "notify",
        threshold: "1m",
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn().mockResolvedValue(makePR()),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: false,
        ciPassing: true,
        approved: false,
        noConflicts: true,
        blockers: [],
      }),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    vi.mocked(mockAgent.getActivityState).mockResolvedValue({
      state: "idle",
      timestamp: new Date(Date.now() - 120_000),
    });

    const session = makeSession({
      status: "working",
      branch: "feat/test",
      pr: null,
      metadata: { agent: "opencode" },
    });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "feat/test",
      status: "working",
      project: "my-app",
      agent: "opencode",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSCM.detectPR).toHaveBeenCalledOnce();
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta?.["pr"]).toBe(makePR().url);
    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("preserves stuck state when getActivityState throws", async () => {
    vi.mocked(mockAgent.getActivityState).mockRejectedValue(new Error("probe failed"));

    const session = makeSession({ status: "stuck" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "stuck",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Should preserve "stuck" — NOT coerce to "working"
    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("preserves needs_input state when getActivityState throws", async () => {
    vi.mocked(mockAgent.getActivityState).mockRejectedValue(new Error("probe failed"));

    const session = makeSession({ status: "needs_input" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "needs_input",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Should preserve "needs_input" — NOT coerce to "working"
    expect(lm.getStates().get("app-1")).toBe("needs_input");
  });

  it("preserves stuck state when getActivityState returns null and getOutput throws", async () => {
    vi.mocked(mockAgent.getActivityState).mockResolvedValue(null);
    vi.mocked(mockRuntime.getOutput).mockRejectedValue(new Error("tmux error"));

    const session = makeSession({ status: "stuck" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "stuck",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // getOutput failure should hit the catch block and preserve "stuck"
    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("detects PR states from SCM", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("ci_failed");
  });

  it("skips PR auto-detection when metadata disables it", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn().mockResolvedValue(makePR()),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "feat/test",
      status: "working",
      project: "my-app",
      prAutoDetect: "off",
    });

    const realSessionManager = createSessionManager({
      config,
      registry: registryWithSCM,
    });
    const session = await realSessionManager.get("app-1");

    expect(session).not.toBeNull();
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSCM.detectPR).not.toHaveBeenCalled();
    expect(lm.getStates().get("app-1")).toBe("working");
  });

  it("skips PR auto-detection for orchestrator sessions", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn().mockResolvedValue(makePR()),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "master",
      status: "working",
      project: "my-app",
      role: "orchestrator",
    });

    const realSessionManager = createSessionManager({
      config,
      registry: registryWithSCM,
    });
    const session = await realSessionManager.get("app-1");

    expect(session).not.toBeNull();
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSCM.detectPR).not.toHaveBeenCalled();
    expect(lm.getStates().get("app-1")).toBe("working");
  });

  it("skips PR auto-detection for orchestrator sessions identified by ID suffix (fallback)", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn().mockResolvedValue(makePR()),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    // Session has no role metadata but ID ends with "-orchestrator"
    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: "/tmp",
      branch: "master",
      status: "working",
      project: "my-app",
    });

    const realSessionManager = createSessionManager({
      config,
      registry: registryWithSCM,
    });
    const session = await realSessionManager.get("app-orchestrator");

    expect(session).not.toBeNull();
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-orchestrator");

    expect(mockSCM.detectPR).not.toHaveBeenCalled();
    expect(lm.getStates().get("app-orchestrator")).toBe("working");
  });

  it("detects merged PR", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("merged"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn(),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "approved", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "approved",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("merged");
    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1");
  });

  it("detects closed PR → killed and calls sessionManager.kill (jleechan-v7oa)", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("closed"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn(),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "approved", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "approved",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("killed");
    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1");
  });

  it("detects mergeable when approved + CI green", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("approved"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      }),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("mergeable");
  });

  it("detects merge_conflicts when approved + CI green but has conflicts", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("approved"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: false,
        ciPassing: true,
        approved: true,
        noConflicts: false,
        blockers: ["Merge conflict"],
      }),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("merge_conflicts");
  });

  it("skips getMergeability when CI is pending and review approved (bd-wg5)", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("pending"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("approved"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: false,
        ciPassing: false,
        approved: true,
        noConflicts: true,
        blockers: ["CI pending"],
      }),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Should return "approved" (not "mergeable") and NOT call getMergeability
    expect(lm.getStates().get("app-1")).toBe("approved");
    expect(mockSCM.getMergeability).not.toHaveBeenCalled();
  });

  it("allows getMergeability when CI is 'none' so repos without CI can merge (bd-wg5)", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("none"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: true,
        ciPassing: true,
        approved: false,
        noConflicts: true,
        blockers: [],
      }),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // With CI "none" and review "none", getMergeability should still be called
    // so repos without CI can reach "mergeable" status
    expect(mockSCM.getMergeability).toHaveBeenCalled();
    expect(lm.getStates().get("app-1")).toBe("mergeable");
  });

  it("skips getMergeability when CI is 'pending' (bd-wg5)", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("pending"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // With CI "pending", should return "pr_open" and skip getMergeability
    expect(lm.getStates().get("app-1")).toBe("pr_open");
    expect(mockSCM.getMergeability).not.toHaveBeenCalled();
  });

  it("skips fallback SCM calls when getBatchPRStatus throws a rate limit error (bd-att retry storm fix)", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn(),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn(),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
      getBatchPRStatus: vi.fn().mockRejectedValue(new Error("API rate limit exceeded")),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // With rate limit thrown by getBatchPRStatus, fallback individual calls MUST NOT happen.
    // determineStatus will catch the rethrown error and return current status.
    expect(lm.getStates().get("app-1")).toBe("pr_open");
    expect(mockSCM.getPRState).not.toHaveBeenCalled();
    expect(mockSCM.getCISummary).not.toHaveBeenCalled();
    expect(mockSCM.getReviewDecision).not.toHaveBeenCalled();
    expect(mockSCM.getMergeability).not.toHaveBeenCalled();
  });

  it("throws for nonexistent session", async () => {
    vi.mocked(mockSessionManager.get).mockResolvedValue(null);

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await expect(lm.check("nonexistent")).rejects.toThrow("not found");
  });

  it("does not change state when status is unchanged", async () => {
    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("working");

    // Second check — status remains working, no transition
    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("working");
  });
});

describe("reactions", () => {
  it("triggers send-to-agent reaction on CI failure", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is failing. Fix it.",
        retries: 2,
        escalateAfter: 2,
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "CI is failing. Fix it.");
  });

  it("injects CI failure context into send-to-agent message", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI failed. Fix it. Details: {{context}}",
        retries: 2,
        escalateAfter: 2,
      },
    };

    const failingChecks = [
      {
        name: "build",
        status: "failed" as const,
        url: "https://github.com/org/repo/runs/123",
        conclusion: "FAILURE",
      },
      {
        name: "test",
        status: "failed" as const,
        url: "https://github.com/org/repo/runs/124",
        conclusion: "FAILURE",
      },
    ];

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn().mockResolvedValue(failingChecks),
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Verify that context was injected with failing check names and URLs
    expect(mockSessionManager.send).toHaveBeenCalled();
    const sentMessage = vi.mocked(mockSessionManager.send).mock.calls[0][1];
    expect(sentMessage).toContain("CI failed. Fix it. Details:");
    expect(sentMessage).toContain("build");
    expect(sentMessage).toContain("test");
    expect(sentMessage).toContain("https://github.com/org/repo/runs/123");
  });

  it("injects changes-requested context into send-to-agent message", async () => {
    config.reactions = {
      "changes-requested": {
        auto: true,
        action: "send-to-agent",
        message: "Review changes requested. Address feedback: {{context}}",
        retries: 2,
        escalateAfter: 2,
      },
    };

    const pendingComments = [
      {
        id: "1",
        author: "reviewer",
        body: "Please fix this function",
        path: "src/utils.ts",
        line: 42,
        isResolved: false,
        createdAt: new Date(),
        url: "https://github.com/org/repo/pulls/42/files#42",
      },
      {
        id: "2",
        author: "reviewer",
        body: "Consider using a different approach",
        path: "src/main.ts",
        line: 100,
        isResolved: false,
        createdAt: new Date(),
        url: "https://github.com/org/repo/pulls/42/files#100",
      },
    ];

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("changes_requested"),
      getPendingComments: vi.fn().mockResolvedValue(pendingComments),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "changes_requested", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "changes_requested",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Verify that context was injected with pending comment details
    expect(mockSessionManager.send).toHaveBeenCalled();
    const sentMessage = vi.mocked(mockSessionManager.send).mock.calls[0][1];
    expect(sentMessage).toContain("Review changes requested. Address feedback:");
    expect(sentMessage).toContain("src/utils.ts");
    expect(sentMessage).toContain("Please fix this function");
  });

  it("does not trigger reaction when auto=false", async () => {
    config.reactions = {
      "ci-failed": {
        auto: false,
        action: "send-to-agent",
        message: "CI is failing.",
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });
  it("suppresses immediate notification when send-to-agent reaction handles the event", async () => {
    const mockNotifier: Notifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithNotifier: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    // Session transitions from pr_open → ci_failed, which maps to ci-failed reaction
    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    // Configure send-to-agent reaction for ci-failed with retries
    const configWithReaction = {
      ...config,
      reactions: {
        "ci-failed": {
          auto: true,
          action: "send-to-agent" as const,
          message: "Fix CI",
          retries: 3,
          escalateAfter: 3,
        },
      },
    };

    const lm = createLifecycleManager({
      config: configWithReaction,
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("ci_failed");
    // send-to-agent reaction should have been executed
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "Fix CI");
    // Notifier should NOT have been called — the reaction is handling it
    expect(mockNotifier.notify).not.toHaveBeenCalled();
  });

  it("dispatches unresolved review comments even when reviewDecision stays unchanged", async () => {
    config.reactions = {
      "changes-requested": {
        auto: true,
        action: "send-to-agent",
        message: "Handle review comments.",
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn().mockResolvedValue([
        {
          id: "c1",
          author: "reviewer",
          body: "Please rename this helper",
          path: "src/app.ts",
          line: 12,
          isResolved: false,
          createdAt: new Date(),
          url: "https://example.com/comment/1",
        },
      ]),
      getAutomatedComments: vi.fn().mockResolvedValue([]),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "Handle review comments.");

    vi.mocked(mockSessionManager.send).mockClear();
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();

    const metadata = readMetadataRaw(sessionsDir, "app-1");
    expect(metadata?.["lastPendingReviewDispatchHash"]).toBe("c1");
  });

  it("does not double-send when changes_requested transition already triggered the reaction", async () => {
    config.reactions = {
      "changes-requested": {
        auto: true,
        action: "send-to-agent",
        message: "Handle requested changes.",
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("changes_requested"),
      getPendingComments: vi.fn().mockResolvedValue([
        {
          id: "c1",
          author: "reviewer",
          body: "Please add validation",
          path: "src/route.ts",
          line: 44,
          isResolved: false,
          createdAt: new Date(),
          url: "https://example.com/comment/2",
        },
      ]),
      getAutomatedComments: vi.fn().mockResolvedValue([]),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");
    await lm.check("app-1");

    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "Handle requested changes.");
  });

  it("dispatches automated review comments only once for an unchanged backlog", async () => {
    config.reactions = {
      "bugbot-comments": {
        auto: true,
        action: "send-to-agent",
        message: "Handle automated review findings.",
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn().mockResolvedValue([]),
      getAutomatedComments: vi.fn().mockResolvedValue([
        {
          id: "bot-1",
          botName: "cursor[bot]",
          body: "Potential issue detected",
          path: "src/worker.ts",
          line: 9,
          severity: "warning",
          createdAt: new Date(),
          url: "https://example.com/comment/3",
        },
      ]),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "app-1",
      "Handle automated review findings.",
    );

    vi.mocked(mockSessionManager.send).mockClear();
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();

    const metadata = readMetadataRaw(sessionsDir, "app-1");
    expect(metadata?.["lastAutomatedReviewDispatchHash"]).toBe("bot-1");
  });

  it("notifies humans on significant transitions without reaction config", async () => {
    const mockNotifier: Notifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("merged"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn(),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithNotifier: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    // merge.completed has "action" priority but NO reaction key mapping,
    // so it must reach notifyHuman directly
    const session = makeSession({ status: "approved", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "approved",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("merged");
    expect(mockNotifier.notify).toHaveBeenCalled();
    expect(mockNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "merge.completed" }),
    );
  });

  it("auto-merge is blocked when merge gate fails (CodeRabbit not approved)", async () => {
    // This test verifies that even when the session status transitions to "mergeable"
    // (meaning CI is passing and human review is approved), the auto-merge reaction
    // will still check the full merge gate and block if CodeRabbit hasn't approved.
    config.reactions = {
      "approved-and-green": {
        auto: true,
        action: "auto-merge",
        mergeMethod: "squash",
      },
    };

    const mockNotifier: Notifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    // Mock SCM returns values that allow status transition to "mergeable":
    // - CI is passing
    // - Review decision is "approved"
    // But the getReviews will return no CodeRabbit review, which will fail merge gate
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn().mockResolvedValue(undefined),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      // getReviewDecision returns "approved" to allow status transition to "mergeable"
      // but getReviews returns empty to cause merge gate failure
      getReviews: vi.fn().mockResolvedValue([]),
      getReviewDecision: vi.fn().mockResolvedValue("approved"),
      getPendingComments: vi.fn().mockResolvedValue([]),
      getAutomatedComments: vi.fn().mockResolvedValue([]),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      }),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name?: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    // Use pr_open status so transition to mergeable triggers the reaction
    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Verify that notifier was called to report merge gate failure
    expect(mockNotifier.notify).toHaveBeenCalledTimes(1);
    const call = vi.mocked(mockNotifier.notify).mock.calls[0][0];
    expect(call.message).toContain("merge gate failed");
    expect(call.message).toContain("CodeRabbit approved");

    // Verify merge was NOT called
    expect(mockSCM.mergePR).not.toHaveBeenCalled();
  });

  it("auto-merge uses project.mergeGate config when provided", async () => {
    // Configure project with mergeGate disabled
    // This test verifies that when mergeGate is disabled in project config,
    // the auto-merge proceeds even when merge gate conditions would fail.
    config.projects = {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: join(tmpDir, "my-app"),
        defaultBranch: "main",
        sessionPrefix: "app",
        scm: { plugin: "github" },
        mergeGate: { enabled: false },
      },
    };

    config.reactions = {
      "approved-and-green": {
        auto: true,
        action: "auto-merge",
        mergeMethod: "squash",
      },
    };

    const mockNotifier: Notifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    // Mock SCM returns passing CI and approved review so status transitions to "mergeable"
    // But mergeGate is disabled in project config, so merge proceeds
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn().mockResolvedValue(undefined),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn().mockResolvedValue([{ author: "coderabbitai[bot]", state: "approved" }, { author: "evidence-review-bot", state: "approved" }]),
      getReviewDecision: vi.fn().mockResolvedValue("approved"),
      getPendingComments: vi.fn().mockResolvedValue([]),
      getAutomatedComments: vi.fn().mockResolvedValue([]),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      }),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name?: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    // Use pr_open status so transition to mergeable triggers the reaction
    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // With mergeGate disabled, merge should proceed even though conditions would fail
    // (because checkMergeGate returns early with passed: true when enabled: false)
    expect(mockSCM.mergePR).toHaveBeenCalledWith(session.pr, "squash");
  });
});

describe("getStates", () => {
  it("returns copy of states map", async () => {
    const session = makeSession({ status: "spawning" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    const states = lm.getStates();
    expect(states.get("app-1")).toBe("working");

    // Modifying returned map shouldn't affect internal state
    states.set("app-1", "killed");
    expect(lm.getStates().get("app-1")).toBe("working");
  });

  it("calls scm.mergePR when auto-merge reaction is triggered and PR is mergeable", async () => {
    config.reactions = {
      "approved-and-green": {
        auto: true,
        action: "auto-merge",
        mergeMethod: "squash",
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn().mockResolvedValue(undefined),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn().mockResolvedValue([{ author: "coderabbitai[bot]", state: "approved" }, { author: "evidence-review-bot", state: "approved" }]),
      getReviewDecision: vi.fn().mockResolvedValue("approved"),
      getPendingComments: vi.fn().mockResolvedValue([]),
      getAutomatedComments: vi.fn().mockResolvedValue([]),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      }),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSCM.getMergeability).toHaveBeenCalledWith(session.pr);
    expect(mockSCM.mergePR).toHaveBeenCalledWith(session.pr, "squash");
  });

  it("does not merge when session has no PR", async () => {
    // Even with auto-merge configured, if there's no PR, merge should not be attempted
    config.reactions = {
      "approved-and-green": {
        auto: true,
        action: "auto-merge",
        mergeMethod: "merge",
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn().mockResolvedValue(undefined),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("approved"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      }),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    // Session with no PR
    const session = makeSession({ status: "working", pr: null });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // mergePR should not be called when there's no PR
    expect(mockSCM.mergePR).not.toHaveBeenCalled();
  });

  it("uses default squash merge method when not specified", async () => {
    config.reactions = {
      "approved-and-green": {
        auto: true,
        action: "auto-merge",
        // mergeMethod not specified - should default to squash
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn().mockResolvedValue(undefined),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn().mockResolvedValue([{ author: "coderabbitai[bot]", state: "approved" }, { author: "evidence-review-bot", state: "approved" }]),
      getReviewDecision: vi.fn().mockResolvedValue("approved"),
      getPendingComments: vi.fn().mockResolvedValue([]),
      getAutomatedComments: vi.fn().mockResolvedValue([]),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      }),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSCM.mergePR).toHaveBeenCalledWith(session.pr, "squash");
  });

  it("auto-merge merges immediately and notifies of completion", async () => {
    // auto-merge should merge automatically without waiting for approval
    config.reactions = {
      "approved-and-green": {
        auto: true,
        action: "auto-merge",
        mergeMethod: "squash",
      },
    };

    const mockNotifier: Notifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn().mockResolvedValue(undefined),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn().mockResolvedValue([{ author: "coderabbitai[bot]", state: "approved" }, { author: "evidence-review-bot", state: "approved" }]),
      getReviewDecision: vi.fn().mockResolvedValue("approved"),
      getPendingComments: vi.fn().mockResolvedValue([]),
      getAutomatedComments: vi.fn().mockResolvedValue([]),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      }),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name?: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Verify that notifier was called once for success notification
    expect(mockNotifier.notify).toHaveBeenCalledTimes(1);

    // Call should be the success notification
    const call = vi.mocked(mockNotifier.notify).mock.calls[0][0];
    expect(call.type).toBe("reaction.triggered");
    expect(call.message).toContain("completed auto-merge");

    // Verify merge was called immediately
    expect(mockSCM.mergePR).toHaveBeenCalledWith(session.pr, "squash");
  });

  it("works with request-merge action (notifies human without merging)", async () => {
    // request-merge should notify human for approval but NOT merge automatically
    config.reactions = {
      "approved-and-green": {
        auto: true,
        action: "request-merge",
        mergeMethod: "merge",
      },
    };

    const mockNotifier: Notifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn().mockResolvedValue(undefined),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("approved"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      }),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name?: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Verify that notifier was called once for approval request
    expect(mockNotifier.notify).toHaveBeenCalledTimes(1);

    // Call should be the approval request
    const call = vi.mocked(mockNotifier.notify).mock.calls[0][0];
    expect(call.type).toBe("merge.approval_requested");

    // Verify merge was NOT called (human must approve manually)
    expect(mockSCM.mergePR).not.toHaveBeenCalled();
  });
});

describe("session exit proof reconciliation (bd-uxs.6)", () => {
  let mockNotifier: Notifier;

  beforeEach(() => {
    mockNotifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    // Configure notifier by plugin name; registry mock supplies runtime instance
    config.notifiers = { desktop: { plugin: "desktop" } };
    config.notificationRouting = {
      urgent: ["desktop"],
      action: ["desktop"],
      warning: ["desktop"],
      info: ["desktop"],
    };
  });

  it("emits session.exit_failed when no SCM is configured", async () => {
    // Create a custom registry with notifier - this is critical
    const testRegistry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string, name?: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn(),
      loadFromConfig: vi.fn(),
    };

    // Mock runtime as dead to trigger killed (terminal) status
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    // Session starts as "working" so transition to "killed" triggers terminal event
    const session = makeSession({ status: "working", pr: null });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    // Write metadata with previous status (working) - check will transition to killed (terminal)
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: testRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Verify session transitioned to killed
    expect(lm.getStates().get("app-1")).toBe("killed");

    // Verify notifier was called with exit_failed event
    expect(mockNotifier.notify).toHaveBeenCalled();
    const call = vi.mocked(mockNotifier.notify).mock.calls.find(
      (c) => (c[0] as { type?: string } | undefined)?.type === "session.exit_failed",
    );
    expect(call).toBeDefined();
    expect((call![0] as { type: string }).type).toBe("session.exit_failed");
  });

  it("emits session.exit_failed when SCM does not support validateCommits", async () => {
    // SCM mock without validateCommits function
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn(),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn(),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
      // validateCommits is NOT defined - testing unsupported path
    };

    const testRegistry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string, name?: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn(),
      loadFromConfig: vi.fn(),
    };

    // Mock runtime as dead to trigger killed (terminal) status
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    // Session starts as "working" so transition to "killed" triggers terminal event
    const session = makeSession({ status: "working", pr: null });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: testRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Verify session transitioned to killed
    expect(lm.getStates().get("app-1")).toBe("killed");

    // Verify notifier was called with exit_failed event (not validated)
    expect(mockNotifier.notify).toHaveBeenCalled();
    const call = vi.mocked(mockNotifier.notify).mock.calls.find(
      (c) => (c[0] as { type?: string } | undefined)?.type === "session.exit_failed",
    );
    expect(call).toBeDefined();
    expect((call![0] as { type: string }).type).toBe("session.exit_failed");
  });

  it("emits session.exit_validated when validateCommits returns pushed=true", async () => {
    // SCM mock with validateCommits that returns pushed=true
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn(),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn(),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
      validateCommits: vi.fn().mockResolvedValue({
        pushed: true,
        localCommits: [],
        remoteCommits: ["abc123"],
      }),
    };

    const testRegistry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string, name?: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn(),
      loadFromConfig: vi.fn(),
    };

    // Mock runtime as dead to trigger killed (terminal) status
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    // Session starts as "working" so transition to "killed" triggers terminal event
    const session = makeSession({ status: "working", pr: null });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: testRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Verify session transitioned to killed
    expect(lm.getStates().get("app-1")).toBe("killed");

    // Verify notifier was called with exit_validated event
    expect(mockNotifier.notify).toHaveBeenCalled();
    const call = vi.mocked(mockNotifier.notify).mock.calls.find(
      (c) => (c[0] as { type?: string } | undefined)?.type === "session.exit_validated",
    );
    expect(call).toBeDefined();
    expect((call![0] as { type: string }).type).toBe("session.exit_validated");
  });

  it("emits session.exit_failed when validateCommits returns pushed=false", async () => {
    // SCM mock with validateCommits that returns pushed=false (local commits not pushed)
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn(),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn(),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
      validateCommits: vi.fn().mockResolvedValue({
        pushed: false,
        localCommits: ["abc123", "def456"],
        remoteCommits: [],
      }),
    };

    const testRegistry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string, name?: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn(),
      loadFromConfig: vi.fn(),
    };

    // Mock runtime as dead to trigger killed (terminal) status
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    // Session starts as "working" so transition to "killed" triggers terminal event
    const session = makeSession({ status: "working", pr: null });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: testRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Verify notifier was called with exit_failed event (not exit_validated)
    const call = vi.mocked(mockNotifier.notify).mock.calls.find(
      (c) => (c[0] as { type?: string } | undefined)?.type === "session.exit_failed",
    );
    expect(call).toBeDefined();
    expect((call![0] as { type: string }).type).toBe("session.exit_failed");

    // Verify the proof contains pushed=false
    const eventData = (call![0] as { data?: { proof?: SessionExitProof } }).data;
    expect(eventData?.proof?.commitsPushed).toBe(false);
    expect(eventData?.proof?.localCommits).toEqual(["abc123", "def456"]);
    expect(eventData?.proof?.remoteCommits).toEqual([]);
  });

  it("emits session.exit_failed when validateCommits throws an error", async () => {
    // SCM mock with validateCommits that throws
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn(),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn(),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
      validateCommits: vi.fn().mockRejectedValue(new Error("Validation failed")),
    };

    const testRegistry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string, name?: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn(),
      loadFromConfig: vi.fn(),
    };

    // Mock runtime as dead to trigger killed (terminal) status
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    // Session starts as "working" so transition to "killed" triggers terminal event
    const session = makeSession({ status: "working", pr: null });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: testRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Verify session transitioned to killed
    expect(lm.getStates().get("app-1")).toBe("killed");

    // Verify notifier was called with exit_failed event
    expect(mockNotifier.notify).toHaveBeenCalled();
    const call = vi.mocked(mockNotifier.notify).mock.calls.find(
      (c) => (c[0] as { type?: string } | undefined)?.type === "session.exit_failed",
    );
    expect(call).toBeDefined();
    expect((call![0] as { type: string }).type).toBe("session.exit_failed");
  });
});

describe("parallel-retry reaction (bd-uxs.4)", () => {
  let mockNotifier: Notifier;
  let mockSCM: SCM;

  beforeEach(() => {
    mockNotifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    mockSCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    config.notifiers = { desktop: { plugin: "desktop" } };
    config.notificationRouting = {
      urgent: ["desktop"],
      action: ["desktop"],
      warning: ["desktop"],
      info: ["desktop"],
    };
  });

  function makeRegistryWithScm(): PluginRegistry {
    return {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name?: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };
  }

  it("does not pass the original branch to spawned retries (unique branch per session)", async () => {
    // Regression test: passing branch: freshSession.branch causes git checkout to fail
    // in worktree workspaces because the branch is already checked out by the original session.
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "parallel-retry",
        parallelRetry: { maxParallel: 2, strategies: ["codex", "claude-code"] },
      },
    };

    const session = makeSession({ status: "pr_open", pr: makePR(), branch: "feat/orig", issueId: "42" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.spawn).mockResolvedValue(makeSession({ id: "app-retry-1" }));

    writeMetadata(sessionsDir, "app-1", { worktree: "/tmp", branch: "main", status: "pr_open", project: "my-app" });

    const lm = createLifecycleManager({ config, registry: makeRegistryWithScm(), sessionManager: mockSessionManager });
    await lm.check("app-1");

    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(2);
    // branch must NOT be the original branch — let session-manager generate unique names
    for (const call of vi.mocked(mockSessionManager.spawn).mock.calls) {
      expect(call[0]).not.toHaveProperty("branch", "feat/orig");
    }
  });

  it("spawns one session per strategy up to maxParallel", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "parallel-retry",
        parallelRetry: {
          maxParallel: 2,
          strategies: ["codex", "claude-code"],
        },
      },
    };

    const session = makeSession({ status: "pr_open", pr: makePR(), issueId: "42" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.spawn).mockResolvedValue(makeSession({ id: "app-retry-1" }));

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: makeRegistryWithScm(),
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(2);
    expect(mockSessionManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "my-app", agent: "codex" }),
    );
    expect(mockSessionManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "my-app", agent: "claude-code" }),
    );
  });

  it("respects maxParallel cap when more strategies are provided", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "parallel-retry",
        parallelRetry: {
          maxParallel: 1,
          strategies: ["codex", "claude-code", "aider"],
        },
      },
    };

    const session = makeSession({ status: "pr_open", pr: makePR(), issueId: "42" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.spawn).mockResolvedValue(makeSession({ id: "app-retry-1" }));

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: makeRegistryWithScm(),
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "codex" }),
    );
  });

  it("spawns one session with default agent when no parallelRetry config", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "parallel-retry",
      },
    };

    const session = makeSession({ status: "pr_open", pr: makePR(), issueId: "42" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.spawn).mockResolvedValue(makeSession({ id: "app-retry-1" }));

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: makeRegistryWithScm(),
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "my-app" }),
    );
  });

  it("notifies human with reaction.triggered event after spawning", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "parallel-retry",
        parallelRetry: {
          maxParallel: 1,
          strategies: ["codex"],
        },
      },
    };

    const session = makeSession({ status: "pr_open", pr: makePR(), issueId: "42" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.spawn).mockResolvedValue(makeSession({ id: "app-retry-1" }));

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: makeRegistryWithScm(),
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    const notifyCalls = vi.mocked(mockNotifier.notify).mock.calls;
    const reactionCall = notifyCalls.find(
      (c) => (c[0] as { type?: string } | undefined)?.type === "reaction.triggered",
    );
    expect(reactionCall).toBeDefined();
  });

  it("returns success=false when all spawns fail", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "parallel-retry",
        parallelRetry: {
          maxParallel: 2,
          strategies: ["codex", "claude-code"],
        },
      },
    };

    const session = makeSession({ status: "pr_open", pr: makePR(), issueId: "42" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.spawn).mockRejectedValue(new Error("spawn failed"));

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: makeRegistryWithScm(),
      sessionManager: mockSessionManager,
    });

    // Should not throw even when all spawns fail
    await expect(lm.check("app-1")).resolves.toBeUndefined();

    // Notifier should be called with a warning
    const notifyCalls = vi.mocked(mockNotifier.notify).mock.calls;
    const reactionCall = notifyCalls.find(
      (c) => (c[0] as { type?: string } | undefined)?.type === "reaction.triggered",
    );
    expect(reactionCall).toBeDefined();
  });
});

describe("workspace-deleted detection", () => {
  it("returns killed when session workspacePath does not exist", async () => {
    const nonExistentPath = join(tmpDir, "deleted-worktree-" + randomUUID());
    const session = makeSession({
      status: "working",
      workspacePath: nonExistentPath,
    });

    vi.mocked(mockSessionManager.list).mockResolvedValue([session]);
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("killed");
  });

  it("does not kill session when workspacePath exists", async () => {
    // Create the workspace directory so it exists
    const existingPath = join(tmpDir, "existing-worktree-" + randomUUID());
    mkdirSync(existingPath, { recursive: true });

    const session = makeSession({
      status: "working",
      workspacePath: existingPath,
    });

    vi.mocked(mockSessionManager.list).mockResolvedValue([session]);
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Should remain working, not killed
    expect(lm.getStates().get("app-1")).not.toBe("killed");
  });

  it("does not kill session when workspacePath is not set", async () => {
    const session = makeSession({
      status: "working",
      workspacePath: undefined,
    });

    vi.mocked(mockSessionManager.list).mockResolvedValue([session]);
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).not.toBe("killed");
  });
});

describe("worktree cleanup on terminal transitions", () => {
  it("calls sessionManager.kill() when session transitions to killed to clean up worktree", async () => {
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);
    vi.mocked(mockAgent.getActivityState).mockResolvedValue({ state: "exited" });

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/test-worktree",
      branch: "feat/test",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("killed");
    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1");
  });

  it("calls sessionManager.kill() when session transitions to merged", async () => {
    const session = makeSession({
      status: "merged",
      metadata: { status: "working" },
    });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(true);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/test-worktree",
      branch: "feat/test",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1");
  });

  it("does not call kill() when session stays in working state", async () => {
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(true);
    vi.mocked(mockAgent.getActivityState).mockResolvedValue({ state: "active" });

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/test-worktree",
      branch: "feat/test",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("working");
    expect(mockSessionManager.kill).not.toHaveBeenCalled();
  });
});

describe("bd-kki: killed transition + merged PR race", () => {
  let mockSCM: SCM;

  beforeEach(() => {
    mockSCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("merged"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn(),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };
  });

  function makeRegistryWithSCM(): PluginRegistry {
    return {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };
  }

  it("calls sessionManager.kill() when killed transition and SCM reports merged", async () => {
    const nonExistentPath = join(tmpDir, "non-existent-workspace-" + randomUUID());
    const session = makeSession({ status: "pr_open", pr: makePR(), workspacePath: nonExistentPath });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "feat/test",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: makeRegistryWithSCM(),
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("killed");
    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1");
  });

  it("skips persisting killed when SCM is unreachable (retry next poll)", async () => {
    vi.mocked(mockSCM.getPRState).mockRejectedValue(new Error("network error"));
    const nonExistentPath = join(tmpDir, "non-existent-workspace-" + randomUUID());
    const session = makeSession({ status: "pr_open", pr: makePR(), workspacePath: nonExistentPath });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "feat/test",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: makeRegistryWithSCM(),
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // SCM threw — transition absorbed; tracked state stays oldStatus so next poll retries
    expect(mockSessionManager.kill).not.toHaveBeenCalled();
    expect(lm.getStates().get("app-1")).toBe("pr_open");
  });

  it("skips killed persistence when PR is not merged (retry next poll)", async () => {
    vi.mocked(mockSCM.getPRState).mockResolvedValue("closed");
    const nonExistentPath = join(tmpDir, "non-existent-workspace-" + randomUUID());
    const session = makeSession({ status: "pr_open", pr: makePR(), workspacePath: nonExistentPath });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "feat/test",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: makeRegistryWithSCM(),
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // PR is not merged — transition absorbed; tracked state stays oldStatus so next poll retries
    expect(mockSCM.getPRState).toHaveBeenCalled();
    expect(mockSessionManager.kill).not.toHaveBeenCalled();
    expect(lm.getStates().get("app-1")).toBe("pr_open");
  });

  it("skips SCM check when oldStatus is already terminal (bd-kki guard)", async () => {
    vi.mocked(mockSCM.getPRState).mockResolvedValue("merged");
    const nonExistentPath = join(tmpDir, "non-existent-workspace-" + randomUUID());
    const session = makeSession({ status: "errored", pr: makePR(), workspacePath: nonExistentPath });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "feat/test",
      status: "errored",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: makeRegistryWithSCM(),
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSCM.getPRState).not.toHaveBeenCalled();
    expect(lm.getStates().get("app-1")).toBe("killed");
  });
});
