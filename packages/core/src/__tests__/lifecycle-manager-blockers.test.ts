import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLifecycleManager } from "../lifecycle-manager.js";
import { readObservabilitySummary } from "../observability.js";
import { writeMetadata } from "../metadata.js";
import { getSessionsDir } from "../paths.js";
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
    number: 1,
    url: "https://github.com/org/repo/pull/1",
    title: "Test PR",
    owner: "org",
    repo: "repo",
    branch: "feat/test",
    baseBranch: "main",
    isDraft: false,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-test-blockers-${randomUUID()}`);
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
    readyThresholdMs: 300000,
    startupGracePeriodMs: 0,
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
      urgent: [],
      action: [],
      warning: [],
      info: [],
    },
    reactions: {},
  };

  sessionsDir = getSessionsDir(configPath, join(tmpDir, "my-app"));
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("merge gate blockers observability", () => {
  it("ReactionResult.blockers and observability include blocker names when merge gate fails", async () => {
    // This test verifies that when merge gate fails, the ReactionResult includes
    // the blocker names and the observability log records them.
    // Real checkMergeGate is used: mock SCM returns only evidence-review-bot review
    // (no coderabbitai[bot]), so CodeRabbit check fails → blockers = ["CodeRabbit approved"].

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
      // evidence-review-bot approved: passes the Evidence review check.
      // coderabbitai[bot] NOT in list: CodeRabbit check fails → blockers = ["CodeRabbit approved"].
      getReviews: vi.fn().mockResolvedValue([{ author: "evidence-review-bot", state: "approved" }]),
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

    // approved-and-green fires when status transitions TO "mergeable" (→ merge.ready event).
    // Start with "pr_open" so determineStatus() returns "mergeable" from mocked SCM state,
    // producing a pr_open→mergeable transition that triggers the reaction.
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

    // Verify notification message includes blocker names
    expect(mockNotifier.notify).toHaveBeenCalledTimes(1);
    const call = vi.mocked(mockNotifier.notify).mock.calls[0][0];
    expect(call.message).toContain("merge gate failed");
    expect(call.message).toContain("CodeRabbit approved");

    // Verify observability includes blockers in reaction result data
    const summary = readObservabilitySummary(config);
    const project = summary.projects["my-app"];
    expect(project).toBeDefined();
    const reactionTrace = project.recentTraces.find(
      (t: any) => t.operation === "lifecycle.reaction.result",
    );
    expect(reactionTrace).toBeDefined();
    expect((reactionTrace as any).data.blockers).toEqual(["CodeRabbit approved"]);
    expect((reactionTrace as any).data.success).toBe(false);

    // Verify merge was NOT called
    expect(mockSCM.mergePR).not.toHaveBeenCalled();
  });

  it("observability excludes blockers field when merge succeeds", async () => {
    // This test verifies that when merge gate passes (no blockers), the
    // observability record does NOT include a blockers field.
    // Real checkMergeGate is used: mock SCM returns both coderabbitai[bot] and
    // evidence-review-bot approved reviews, so all 6 checks pass.

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
      // All 6 checks pass: CI, Mergeable, CodeRabbit, Bugbot, Inline comments, Evidence review.
      getReviews: vi
        .fn()
        .mockResolvedValue([
          { author: "coderabbitai[bot]", state: "approved" },
          { author: "evidence-review-bot", state: "approved" },
        ]),
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

    // Start with "pr_open" so the pr_open→mergeable transition fires approved-and-green.
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

    // Verify merge was called
    expect(mockSCM.mergePR).toHaveBeenCalledWith(session.pr, "squash", 0);

    // Verify observability does NOT include blockers field when merge succeeds
    const summary = readObservabilitySummary(config);
    const project = summary.projects["my-app"];
    expect(project).toBeDefined();
    const reactionTrace = project.recentTraces.find(
      (t: any) => t.operation === "lifecycle.reaction.result",
    );
    expect(reactionTrace).toBeDefined();
    expect((reactionTrace as any).data).not.toHaveProperty("blockers");
    expect((reactionTrace as any).data.success).toBe(true);
  });
});
