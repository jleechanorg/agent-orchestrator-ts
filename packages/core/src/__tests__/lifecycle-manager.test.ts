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
import { clearLastSentHeadSha } from "../dedup-head-sha-store.js";

// Must precede all imports that use the mocked module
vi.mock("../fork-lifecycle-postmerge.js", () => ({
  reapPostMergeCoWorkers: vi.fn().mockResolvedValue({
    killed: [],
    hadErrors: false,
    summary: "no co-worker sessions eligible for reaping",
  }),
}));

// bd-skp2: Use vi.hoisted so the mock ref is available at top level before vi.mock runs
const { mockRunSkepticReviewReaction } = vi.hoisted<{
  mockRunSkepticReviewReaction: () => Promise<{ success: boolean; message?: string; blockers?: string[] }>;
}>(() => ({
  mockRunSkepticReviewReaction: vi.fn<[], Promise<{ success: boolean; message?: string; blockers?: string[] }>>(),
}));

vi.mock("../fork-skeptic-extension.js", () => ({
  runSkepticReviewReaction: mockRunSkepticReviewReaction,
}));

// Import after vi.mock so we get the mocked version
import { reapPostMergeCoWorkers } from "../fork-lifecycle-postmerge.js";
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
  ReactionConfig,
} from "../types.js";

// Valid reaction action strings used in tests
type ReactionAction = "send-to-agent" | "notify" | "auto-merge" | "request-merge" | "parallel-retry" | "skeptic-review" | "respawn-for-review";

// LifecycleManager with _testing exposed (internal API used in tests)
type LifecycleManagerTesting = {
  _testing: {
    executeReaction: (session: Session, eventKey: string) => Promise<void>;
    getReactionConfigForSession: (session: Session, eventKey: string) => ReactionConfig | null;
  };
};

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
    startupGracePeriodMs: 0, // Disable grace period for legacy tests; tested in startup-grace-period.test.ts
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

  it("bd-kki: overrides killed status to merged when SCM confirms PR is merged (kills via bd-s4t.1)", async () => {
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    const mockScm: SCM = {
      name: "github",
      getIssueState: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("merged"),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getMergeability: vi.fn().mockResolvedValue({ mergeable: true, noConflicts: true }),
      createPR: vi.fn(),
      mergePR: vi.fn(),
      detectPR: vi.fn(),
      listOpenPRs: vi.fn(),
      claimPR: vi.fn(),
      listPRComments: vi.fn(),
      listPRReviewThreads: vi.fn(),
      listPRReviewComments: vi.fn(),
      listIssues: vi.fn(),
      assignIssue: vi.fn(),
      addIssueComment: vi.fn(),
      updateIssue: vi.fn(),
      addPRComment: vi.fn(),
      updatePRBody: vi.fn(),
      getPRDetails: vi.fn(),
      listPRFiles: vi.fn(),
      getPRDiff: vi.fn(),
      listReviews: vi.fn(),
      listChecks: vi.fn(),
      getMergeQueueState: vi.fn(),
    } as unknown as SCM;

    const registryWithScm: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockScm;
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
      pr: "https://github.com/org/repo/pull/42",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithScm,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // bd-kki: status overridden to "merged" so bd-s4t.1 handles kill after validation
    expect(lm.getStates().get("app-1")).toBe("merged");
    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1");
  });

  it("bd-kki: SCM transient failure does not lock in killed state (allows retry)", async () => {
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    const mockScm: SCM = {
      name: "github",
      getIssueState: vi.fn(),
      getPRState: vi.fn().mockRejectedValue(new Error("SCM temporarily unreachable")),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getMergeability: vi.fn().mockResolvedValue({ mergeable: true, noConflicts: true }),
      getCIChecks: vi.fn(),
      getReviews: vi.fn(),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      closePR: vi.fn(),
      createPR: vi.fn(),
      mergePR: vi.fn(),
      detectPR: vi.fn(),
      listOpenPRs: vi.fn(),
      claimPR: vi.fn(),
      listPRComments: vi.fn(),
      listPRReviewThreads: vi.fn(),
      listPRReviewComments: vi.fn(),
      listIssues: vi.fn(),
      assignIssue: vi.fn(),
      addIssueComment: vi.fn(),
      updateIssue: vi.fn(),
      addPRComment: vi.fn(),
      updatePRBody: vi.fn(),
      getPRDetails: vi.fn(),
      listPRFiles: vi.fn(),
      getPRDiff: vi.fn(),
      listReviews: vi.fn(),
      listChecks: vi.fn(),
      getMergeQueueState: vi.fn(),
    } as unknown as SCM;

    const registryWithScm: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockScm;
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
      pr: "https://github.com/org/repo/pull/42",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithScm,
      sessionManager: mockSessionManager,
    });

    // SCM call fails during early bd-kki merge check — absorb like the killed absorb
    // path: stay on prior status so the next poll can retry (fork-lifecycle-kki-override).
    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("working");
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

  it("bd-6jc: agent dead + SCM succeeded + non-mergeable PR → pr_open (no kill yet)", async () => {
    // bd-kki: agent exited + PR still open → absorb killed, retry next poll
    // so auto-merge can fire if the PR becomes mergeable.
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

    // bd-6jc: agent dead + SCM succeeded + PR non-mergeable → return "pr_open"
    // (SCM confirmed the PR won't auto-merge, no bd-kki absorption needed — the
    // kill is deferred to the consecutive-failure counter when SCM throws).
    expect(lm.getStates().get("app-1")).toBe("pr_open");
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

  // bd-ara.2: GitHub reports mergeable=UNKNOWN as "not confirmed conflict-free".
  // getMergeability now sets noConflicts=false for UNKNOWN so the merge-conflicts
  // reaction fires and the worker rebases instead of going idle.
  it("detects merge_conflicts when mergeable is UNKNOWN (bd-ara.2)", async () => {
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
        noConflicts: false, // bd-ara.2: getMergeability now sets this for UNKNOWN
        blockers: ["Merge status unknown (GitHub is computing)"],
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

  // bd-1178
  it("skips send-to-agent when PR head SHA is unchanged across poll cycles", async () => {
    config.reactions = {
      "changes-requested": {
        auto: true,
        action: "send-to-agent",
        message: "Review changes requested.",
        retries: 2,
        escalateAfter: 2,
      },
    };

    const sha1 = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
    const sha2 = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";

    // Use mutable refs for both SHA and reviewDecision.
    // Reactions fire on STATUS TRANSITIONS, not every poll cycle. To exercise
    // dedup across multiple poll cycles we must create a transition each time:
    // - getReviewDecision alternates: "changes_requested" → "pending" → "changes_requested"
    //   This creates status transitions: pr_open→cr, cr→pending, pending→cr, cr→pending
    //   The reaction fires on every "→cr" transition, allowing dedup to be exercised.
    // - currentSha is mutated between reaction fires (not between every poll).
    let currentSha = sha1;
    let reviewDecisionCallCount = 0;
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockImplementation(() => {
        reviewDecisionCallCount++;
        // Alternate between changes_requested and pending so every other poll
        // creates a review_pending→changes_requested transition (reaction fires)
        return Promise.resolve(reviewDecisionCallCount % 2 === 1 ? "changes_requested" : "pending");
      }),
      getPendingComments: vi.fn().mockResolvedValue([]),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
      // bd-1178: getPRHeadSha returns currentSha which we mutate between reaction fires
      getPRHeadSha: vi.fn().mockImplementation(() => Promise.resolve(currentSha)),
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

    // First poll: SHA is sha1, send fires, SHA recorded
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    // Second poll: SHA still sha1, dedup kicks in — no send
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    // Third poll: SHA changed to sha2, send fires again
    currentSha = sha2;
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(2);

    // Fourth poll: sha2 unchanged, dedup kicks in
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(2);

    // CR 3002442125: clear dedup store so this test's state doesn't affect other tests
    clearLastSentHeadSha("app-1");
  });
  // transitions. CR noted that the "no send" assertions at polls 2 & 4 are on pending
  // transitions (no reaction path entered), so they don't prove dedup works. Add a CR→CR
  // transition (unchanged SHA) before mutating to sha2 to properly exercise the dedup guard.
  it("skips send-to-agent on consecutive changes_requested transitions with unchanged SHA", async () => {
    config.reactions = {
      "changes-requested": {
        auto: true,
        action: "send-to-agent",
        message: "Review changes requested.",
        retries: 3,
      },
    };

    const sha1 = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
    const sha2 = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
    let currentSha = sha1;
    let reviewDecisionCallCount = 0;

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      // Alternate so every other poll fires the reaction
      getReviewDecision: vi.fn().mockImplementation(() => {
        reviewDecisionCallCount++;
        return Promise.resolve(reviewDecisionCallCount % 2 === 1 ? "changes_requested" : "pending");
      }),
      getPendingComments: vi.fn().mockResolvedValue([]),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
      getPRHeadSha: vi.fn().mockImplementation(() => Promise.resolve(currentSha)),
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

    // Poll 1: cr transition, send fires, sha1 recorded
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    // Poll 2: pending — no reaction path entered
    await lm.check("app-1");

    // Poll 3: cr transition, SHA=sha1 unchanged → dedup kicks in (consecutive CR, unchanged SHA)
    // CR 3002173129: verify getPRHeadSha was called to exercise the dedup path explicitly.
    const getPRHeadShaCallsAfterPoll2 = vi.mocked(mockSCM.getPRHeadSha!).mock.calls.length;
    await lm.check("app-1");
    // getPRHeadSha must have been called during poll 3's dedup check
    expect(vi.mocked(mockSCM.getPRHeadSha!).mock.calls.length).toBe(getPRHeadShaCallsAfterPoll2 + 1);
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1); // still 1 — dedup worked

    // Poll 4: pending
    await lm.check("app-1");

    // Poll 5: cr transition, SHA now sha2 → send fires
    currentSha = sha2;
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(2);

    // CR 3002442125: clear dedup store so this test's state doesn't affect other tests
    clearLastSentHeadSha("app-1");
  });

  // bd-1178: FIX 3002210800 — regression test: getPRHeadSha rejection must not block send-to-agent.
  // Dedup is best-effort; if SHA fetch fails, proceed with the send anyway.
  it("proceeds with send-to-agent when getPRHeadSha fails", async () => {
    config.reactions = {
      "changes-requested": {
        auto: true,
        action: "send-to-agent",
        message: "Review changes requested.",
        retries: 1,
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
      getPendingComments: vi.fn().mockResolvedValue([]),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
      // getPRHeadSha rejects — dedup should be skipped and send should still fire
      getPRHeadSha: vi.fn().mockRejectedValue(new Error("network failure")),
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

    // SHA fetch fails — send should still fire (dedup is best-effort)
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    // CR 3002442125: clear dedup store so this test's state doesn't affect other tests
    clearLastSentHeadSha("app-1");
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
    expect(mockSCM.mergePR).toHaveBeenCalledWith(session.pr, "squash", 0);
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
    expect(mockSCM.mergePR).toHaveBeenCalledWith(session.pr, "squash", 0);
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

    expect(mockSCM.mergePR).toHaveBeenCalledWith(session.pr, "squash", 0);
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
    expect(mockSCM.mergePR).toHaveBeenCalledWith(session.pr, "squash", 0);
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

  it("upgrades to merged when killed transition and SCM reports merged (then kill cleans up)", async () => {
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

    expect(lm.getStates().get("app-1")).toBe("merged");
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

  it("skips killed persistence when PR is still open (retry next poll)", async () => {
    vi.mocked(mockSCM.getPRState).mockResolvedValue("open");
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

    // PR still open — transition absorbed; tracked state stays oldStatus so next poll retries
    expect(mockSCM.getPRState).toHaveBeenCalled();
    expect(mockSessionManager.kill).not.toHaveBeenCalled();
    expect(lm.getStates().get("app-1")).toBe("pr_open");
  });

  it("early isPRMerged upgrades terminal errored→merged and kill() still runs for cleanup", async () => {
    // When oldStatus is already terminal, the killed absorb block is skipped. Early
    // isPRMerged upgrades killed→merged; terminal→merged cleanup must still call kill().
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

    expect(mockSCM.getPRState).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1");
    expect(lm.getStates().get("app-1")).toBe("merged");
  });
});

describe("send-to-agent retry policy (bd-5nxx)", () => {
  // bd-5nt5: verifies the bd-5nxx default cap of 3 for send-to-agent is applied correctly.
  //
  // Key behaviour for the send-to-agent reaction on the changes_requested transition:
  // - Fires once on the changes_requested transition (cycle 1).
  // - On stable status (cycles 2-5) the reaction does NOT re-fire for this transition.
  //   The attempt counter in executeReaction only increments when the reaction IS called,
  //   not on every poll cycle.
  // - The default cap of 3 is a safety guard against edge-case retry storms.
  //   It is never reached for changes_requested because the transition only fires once.
  //
  // Note: other mechanisms (maybeDispatchReviewBacklog(), mergeable retry loop,
  // stuck retry loop) can trigger reactions without a status transition — those paths
  // are covered by their own tests and are bounded by their own retry policies
  // (BacklogFingerprint, STUCK_RETRY_COOLDOWN_MS respectively).
  it("send-to-agent fires exactly once on changes_requested transition and never on stable status (bd-5nxx default cap)", async () => {
    config.reactions = {
      "changes-requested": {
        auto: true,
        action: "send-to-agent",
        message: "CR feedback: address review comments.",
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
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn().mockResolvedValue({ mergeable: true, noConflicts: true }),
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

    // Reassign mockSessionManager so vi.mocked() picks up the new reference
    // (matching existing passing test pattern)
    mockSessionManager = {
      ...mockSessionManager,
      get: vi.fn().mockResolvedValue(session),
      send: vi.fn().mockResolvedValue(undefined),
    };

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

    // Cycle 1: pr_open→changes_requested transition — send fires
    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("changes_requested");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    // Cycles 2-5: stable changes_requested — reaction does NOT re-fire.
    // NOTE: This test proves transition-only firing (bd-5nxx) — it intentionally does NOT
    // exercise the 3-retry cap because send() succeeds on cycle 1 (line 4122) and the
    // stable-poll fingerprint guard prevents re-invocation. The 3-retry cap is covered by
    // the pure-function unit test below (line 4139: "resolveReactionMaxRetries:
    // send-to-agent defaults to 3") which directly imports the policy function and uses
    // .not.toBe(Infinity) as an explicit regression guard. The cap cannot be reached
    // from this integration test without a sequence of send() failures, which requires
    // restructuring the mock — the unit test is the correct place for this check.
    for (let cycle = 2; cycle <= 5; cycle++) {
      vi.mocked(mockSessionManager.send).mockClear();
      await lm.check("app-1");
      expect(mockSessionManager.send).not.toHaveBeenCalled();
    }
  });

  // bd-5nt5 integration test 1: send-to-agent fires 3 times then escalates when send()
  // persistently fails. This is the integration test that CR correctly identified was missing —
  // the "changes_requested" transition test never reaches the cap because send() succeeds, and
  // the pure-function test only covers resolveReactionMaxRetries() in isolation.
  //
  // How the test exercises the cap despite fingerprint dedup:
  // - Cycle 1: pr_open→changes_requested transition fires executeReaction (attempts=1), send() fails.
  //   The fingerprint (HEAD SHA) is set and prevents re-entry on the same SHA.
  // - The transition's executeReaction call is independent from maybeDispatchReviewBacklog's
  //   separate human-review path (different fingerprint namespace).
  // - maybeDispatchReviewBacklog calls executeReaction on cycles where count%3===1 (REVIEW_BACKLOG_INTERVAL=3):
  //   Cycle 1 (transition): attempts=1, send() fails
  //   Cycle 4 (backlog, count=4): attempts=2, send() fails (fingerprint different namespace)
  //   Cycle 5 (backlog, count=5): attempts=3, send() fails
  //   Cycle 6 (backlog, count=6): attempts=4 > maxRetries(3) → shouldEscalate=true → send() skipped
  // - REVIEW_BACKLOG_INTERVAL=3 means shouldThrottle=false (allow) on cycles 1, 4, 7, ...
  //   The transition call on cycle 1 does NOT reset the backlog's count — they're independent.
  // bd-5nt5 integration test: send-to-agent fires 3 times then escalates when send()
  // persistently fails. Uses lm._testing.executeReaction() to directly drive the
  // reaction 4 times without depending on REVIEW_BACKLOG_INTERVAL throttle timing —
  // the throttle fires unpredictably from outside the lifecycle manager (REVIEW_BACKLOG_INTERVAL
  // is not exported from review-backlog.ts), so we bypass it entirely by calling
  // executeReaction directly through the _testing API.
  //
  // This addresses the CR concern: the transition-only test doesn't reach the cap because
  // send() succeeds, and the pure-function test only covers resolveReactionMaxRetries()
  // in isolation. This integration test exercises the full executeReaction path with a
  // failing send() and verifies the cap is enforced.
  it("send-to-agent attempts 3 times then skips+escalates when send() persistently fails (bd-5nxx integration)", async () => {
    const sha = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";

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
        { id: "c1", body: "fix this", path: "a.ts", line: 1, author: "coderabbit", isResolved: false },
      ]),
      getAutomatedComments: vi.fn().mockResolvedValue([]),
      getMergeability: vi.fn().mockResolvedValue({ mergeable: true, noConflicts: true }),
      getPRHeadSha: vi.fn().mockResolvedValue(sha),
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

    const session = makeSession({ status: "pr_open", pr: makePR({ headSha: sha }) });

    // Use a stable local spy — assigning it to mockSessionManager.send ensures
    // vi.mocked(mockSessionManager.send) resolves to sendSpy for ALL assertions.
    // (vi.mocked() captures the reference at call-time; reassigning
    // mockSessionManager.send to the spy AFTER creation still means the spy IS
    // the current mockSessionManager.send, so vi.mocked() tracks it correctly.)
    const sendSpy = vi.fn<[string, string], any>();
    sendSpy.mockRejectedValue(new Error("agent session unreachable"));

    mockSessionManager = {
      ...mockSessionManager,
      get: vi.fn().mockResolvedValue(session),
      send: sendSpy,
    };

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

    // Use lm._testing to directly call executeReaction — bypasses REVIEW_BACKLOG_INTERVAL
    // throttle timing entirely. The reactionTracker is shared across calls so attempts
    // accumulate correctly (attempts=1, 2, 3, then skipped at attempts=4 > cap=3).
    const { executeReaction, getReactionConfigForSession } = (lm as unknown as LifecycleManagerTesting)._testing;
    const reactionConfig = getReactionConfigForSession(session, "changes-requested")!;

    // Verify _testing API is accessible
    expect(executeReaction).toBeDefined();
    expect(typeof executeReaction).toBe("function");
    expect(reactionConfig).not.toBeNull();
    expect(reactionConfig.action).toBe("send-to-agent");

    // Attempt 1: send() fails (agent unreachable) — attempts=1
    await executeReaction(session.id, session.projectId, "changes-requested", reactionConfig, session);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Attempts 2-3: send() still fails (persistently failing agent) — attempts=2, 3
    // Attempts 2-3: two more executeReaction calls with a failing send().
    // sendSpy.mockClear() between calls so each iteration verifies exactly 1 send() call.
    let sendCallCount = 1; // attempt 1 fired send() once
    for (const _ of [2, 3] as const) {
      sendSpy.mockClear();
      await executeReaction(session.id, session.projectId, "changes-requested", reactionConfig, session);
      expect(sendSpy).toHaveBeenCalledTimes(1); // each executeReaction call fires send() once
      sendCallCount++; // = 2, then = 3
    }
    // 3 total executeReaction calls → send() was invoked exactly 3 times
    expect(sendCallCount).toBe(3);

    // Attempt 4: attempts=4 > maxRetries(3) → send() is skipped, escalation fires
    sendSpy.mockClear();
    const result = await executeReaction(
      session.id,
      session.projectId,
      "changes-requested",
      reactionConfig,
      session,
    );
    expect(sendSpy).not.toHaveBeenCalled(); // capped, no send()
    expect(result.action).toBe("escalated");
    expect(result.escalated).toBe(true);
  });

  // bd-5nt5 pure-function test: verifies resolveReactionMaxRetries() caps send-to-agent at 3
  // while other actions remain uncapped. This pure-function test is deterministic and does not
  // require complex mock orchestration for the stuck-retry loop.
  //
  // This test directly imports and calls the policy function — a regression to
  // defaultRetries = Infinity for send-to-agent would fail immediately because
  // Infinity !== 3. The .not.toBe(Infinity) assertion is the explicit regression guard.
  it("resolveReactionMaxRetries: send-to-agent defaults to 3, notify stays Infinity (bd-5nxx)", async () => {
    const { resolveReactionMaxRetries } = await import("../fork-reaction-retry-policy.js");

    // Default cap: send-to-agent → 3, all others → Infinity
    expect(resolveReactionMaxRetries("send-to-agent", {})).toBe(3);
    expect(resolveReactionMaxRetries("notify", {})).toBe(Infinity);
    // respawn-for-review is a real supported action — must stay uncapped (bd-5nxx)
    expect(resolveReactionMaxRetries("respawn-for-review", {})).toBe(Infinity);
    expect(resolveReactionMaxRetries("auto-merge", {})).toBe(Infinity);

    // Per-reaction override takes precedence
    expect(resolveReactionMaxRetries("send-to-agent", { retries: 5 })).toBe(5);
    expect(resolveReactionMaxRetries("notify", { retries: 0 })).toBe(0);

    // A regression to defaultRetries = Infinity for send-to-agent would cause this test to fail
    // because Infinity !== 3. This is verified by changing the implementation temporarily.
    expect(resolveReactionMaxRetries("send-to-agent", {})).not.toBe(Infinity);

    // bd-sbr.periodic-cap: periodic invocations (agent-stuck nudge retry) are bounded by
    // their own cooldown timer (STUCK_RETRY_COOLDOWN_MS) and should NOT consume the transition
    // cap. isPeriodic=true returns Infinity regardless of action type.
    expect(resolveReactionMaxRetries("send-to-agent", {}, true)).toBe(Infinity);
    expect(resolveReactionMaxRetries("notify", {}, true)).toBe(Infinity);
    expect(resolveReactionMaxRetries("auto-merge", {}, true)).toBe(Infinity);
    // Even with an explicit retries override, periodic should stay uncapped
    expect(resolveReactionMaxRetries("send-to-agent", { retries: 1 }, true)).toBe(Infinity);
  });
});

describe("post-merge reap: reapPostMergeCoWorkers is called on merged transition", () => {
  // reapPostMergeCoWorkers is already imported at the top of the file (mocked by vi.mock)

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeMergedRegistry(): PluginRegistry {
    const mockScm: SCM = {
      name: "github",
      getIssueState: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("merged"),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getMergeability: vi.fn().mockResolvedValue({ mergeable: true, noConflicts: true }),
      createPR: vi.fn(),
      mergePR: vi.fn(),
      detectPR: vi.fn(),
      listOpenPRs: vi.fn(),
      claimPR: vi.fn(),
      listPRComments: vi.fn(),
      listPRReviewThreads: vi.fn(),
      listPRReviewComments: vi.fn(),
      listIssues: vi.fn(),
      assignIssue: vi.fn(),
      addIssueComment: vi.fn(),
      updateIssue: vi.fn(),
      addPRComment: vi.fn(),
      updatePRBody: vi.fn(),
      getPRDetails: vi.fn(),
      getPRDiff: vi.fn(),
      listPRFiles: vi.fn(),
      listReviews: vi.fn(),
      listChecks: vi.fn(),
      getMergeQueueState: vi.fn(),
    } as unknown as SCM;

    return {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockScm;
        return null;
      }),
    };
  }

  async function checkAndTransitionToMerged(metadataStatus = "working") {
    const session = makeSession({ status: metadataStatus, pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/test-worktree",
      branch: "feat/test",
      status: metadataStatus,
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: makeMergedRegistry(),
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");
    return { lm, session };
  }

  it("calls reapPostMergeCoWorkers when session transitions to merged", async () => {
    const { lm } = await checkAndTransitionToMerged();

    expect(lm.getStates().get("app-1")).toBe("merged");
    expect(reapPostMergeCoWorkers).toHaveBeenCalledTimes(1);
    const [calledSession, calledSM, calledObserver] = vi.mocked(reapPostMergeCoWorkers).mock.calls[0];
    expect(calledSession.id).toBe("app-1");
    expect(calledSM).toBe(mockSessionManager);
    expect(calledObserver).toBeDefined();
  });

  it("does NOT call reapPostMergeCoWorkers when session transitions to killed (no merge)", async () => {
    const session = makeSession({ status: "working", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/test-worktree",
      branch: "feat/test",
      status: "working",
      project: "my-app",
    });

    // Registry WITHOUT SCM — isPRMerged returns false → status stays "killed"
    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("killed");
    expect(reapPostMergeCoWorkers).not.toHaveBeenCalled();
  });

  it("reapPostMergeCoWorkers errors do not crash check() — failure is warning-only", async () => {
    vi.mocked(reapPostMergeCoWorkers).mockRejectedValueOnce(
      new Error("reaper unreachable"),
    );

    const { lm } = await checkAndTransitionToMerged();

    // check() completes without throwing even though reapPostMergeCoWorkers failed
    expect(lm.getStates().get("app-1")).toBe("merged");
    expect(reapPostMergeCoWorkers).toHaveBeenCalledTimes(1);
  });
});

// bd-skp2: Regression coverage for skeptic trigger lifecycle integration
describe("bd-skp2 skeptic trigger on pr_open", () => {
  beforeEach(() => {
    mockRunSkepticReviewReaction.mockReset();
    mockRunSkepticReviewReaction.mockResolvedValue({ success: true });
  });

  function makeSkepticProjectConfig(reactionAuto: boolean) {
    return {
      ...config,
      reactions: {
        "worker-signals-completion": {
          auto: reactionAuto,
          action: "skeptic-review" as const,
        },
      },
    };
  }

  it("calls skeptic-review reaction when session transitions to pr_open (auto=true)", async () => {
    const skepticConfig = makeSkepticProjectConfig(true);

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
      // Return a non-mergeable result so status becomes "pr_open" not "mergeable"
      getMergeability: vi.fn().mockResolvedValue({ mergeable: false, noConflicts: true }),
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

    // Session starts in "working" with an open PR — check() will transition to "pr_open"
    const session = makeSession({
      status: "working",
      pr: makePR(),
    });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config: skepticConfig,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // The skeptic-review reaction should have been called via executeReaction
    expect(mockRunSkepticReviewReaction).toHaveBeenCalled();
  });

  it("skips skeptic-review reaction when auto=false on worker-signals-completion", async () => {
    const skepticConfig = makeSkepticProjectConfig(false);

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
      // Return a non-mergeable result so status becomes "pr_open" not "mergeable"
      getMergeability: vi.fn().mockResolvedValue({ mergeable: false, noConflicts: true }),
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

    const session = makeSession({
      status: "working",
      pr: makePR(),
    });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config: skepticConfig,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Reaction must NOT fire when auto=false (the condition is auto !== false)
    expect(mockRunSkepticReviewReaction).not.toHaveBeenCalled();
  });

  it("skips skeptic trigger when no worker-signals-completion reaction is configured", async () => {
    // config.reactions = {} by default (set in beforeEach)
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
      // Return a non-mergeable result so status becomes "pr_open" not "mergeable"
      getMergeability: vi.fn().mockResolvedValue({ mergeable: false, noConflicts: true }),
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

    const session = makeSession({
      status: "working",
      pr: makePR(),
    });
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

    // No skeptic reaction configured — nothing to call
    expect(mockRunSkepticReviewReaction).not.toHaveBeenCalled();
  });
});

describe("centralized auto-merge config (getReactionConfigForSession)", () => {
  // These tests verify the autoMerge flag in OrchestratorConfig/ProjectConfig
  // overrides the approved-and-green reaction's default action (notify → auto-merge).
  // The _testing API exposes getReactionConfigForSession for isolated unit testing.

  async function makeLMWithAutoMerge(
    globalAutoMerge?: boolean,
    projectAutoMerge?: boolean,
    projectReactionAction?: ReactionAction,
  ) {
    const cfg: OrchestratorConfig = {
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
          // Per-project override — only set if provided
          ...(projectAutoMerge !== undefined && { autoMerge: projectAutoMerge }),
          // Per-project reaction override — only set if provided
          ...(projectReactionAction !== undefined && {
            reactions: { "approved-and-green": { auto: true, action: projectReactionAction } },
          }),
        },
      },
      notifiers: {},
      notificationRouting: {
        urgent: [],
        action: [],
        warning: [],
        info: [],
      },
      reactions: {
        "approved-and-green": { auto: false, action: "notify", priority: "action" },
      },
      readyThresholdMs: 300_000,
      startupGracePeriodMs: 0,
      // Global override — only set if provided
      ...(globalAutoMerge !== undefined && { autoMerge: globalAutoMerge }),
    };

    const lm = createLifecycleManager({
      config: cfg,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    return { lm, cfg };
  }

  it("default: approved-and-green stays as notify (autoMerge=false)", async () => {
    const { lm } = await makeLMWithAutoMerge(undefined, undefined);
    const { getReactionConfigForSession } = (lm as unknown as LifecycleManagerTesting)._testing;
    const session = makeSession({ projectId: "my-app" });
    const config = getReactionConfigForSession(session, "approved-and-green");
    expect(config?.action).toBe("notify");
  });

  it("global autoMerge=true: overrides approved-and-green to auto-merge", async () => {
    const { lm } = await makeLMWithAutoMerge(true, undefined);
    const { getReactionConfigForSession } = (lm as unknown as LifecycleManagerTesting)._testing;
    const session = makeSession({ projectId: "my-app" });
    const config = getReactionConfigForSession(session, "approved-and-green");
    expect(config?.action).toBe("auto-merge");
    expect(config?.auto).toBe(true);
  });

  it("per-project autoMerge=true: overrides approved-and-green to auto-merge", async () => {
    const { lm } = await makeLMWithAutoMerge(undefined, true);
    const { getReactionConfigForSession } = (lm as unknown as LifecycleManagerTesting)._testing;
    const session = makeSession({ projectId: "my-app" });
    const config = getReactionConfigForSession(session, "approved-and-green");
    expect(config?.action).toBe("auto-merge");
    expect(config?.auto).toBe(true);
  });

  it("per-project autoMerge takes precedence over global autoMerge=false", async () => {
    // Global says no auto-merge, but project says yes → project wins
    const { lm } = await makeLMWithAutoMerge(false, true);
    const { getReactionConfigForSession } = (lm as unknown as LifecycleManagerTesting)._testing;
    const session = makeSession({ projectId: "my-app" });
    const config = getReactionConfigForSession(session, "approved-and-green");
    expect(config?.action).toBe("auto-merge");
    expect(config?.auto).toBe(true);
  });

  it("global autoMerge=true but project autoMerge=false: project wins", async () => {
    // Global says auto-merge, but project disables it → project wins
    const { lm } = await makeLMWithAutoMerge(true, false);
    const { getReactionConfigForSession } = (lm as unknown as LifecycleManagerTesting)._testing;
    const session = makeSession({ projectId: "my-app" });
    const config = getReactionConfigForSession(session, "approved-and-green");
    expect(config?.action).toBe("notify");
  });

  it("explicit reaction action is not overridden by autoMerge", async () => {
    // User explicitly configured action: "notify" on the approved-and-green reaction
    // → autoMerge flag should NOT override it
    const { lm } = await makeLMWithAutoMerge(true, undefined, "notify");
    const { getReactionConfigForSession } = (lm as unknown as LifecycleManagerTesting)._testing;
    const session = makeSession({ projectId: "my-app" });
    const config = getReactionConfigForSession(session, "approved-and-green");
    expect(config?.action).toBe("notify");
  });

  it("autoMerge does not affect non-approved-and-green reactions", async () => {
    const { lm } = await makeLMWithAutoMerge(true, true);
    const { getReactionConfigForSession } = (lm as unknown as LifecycleManagerTesting)._testing;
    const session = makeSession({ projectId: "my-app" });
    // ci-failed is not affected by autoMerge — the test config only has
    // approved-and-green; ci-failed returns null (no defaults applied in unit test)
    const config = getReactionConfigForSession(session, "ci-failed");
    expect(config).toBeNull();
  });
});
