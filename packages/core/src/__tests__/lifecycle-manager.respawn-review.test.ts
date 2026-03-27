/**
 * Tests for respawn-for-review reaction action.
 *
 * When CR posts CHANGES_REQUESTED and the assigned worker is dead/exhausted,
 * the respawn-for-review action spawns a fresh worker targeting that PR.
 *
 * TDD: These tests define the expected behavior of the bd-rfr feature.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLifecycleManager } from "../lifecycle-manager.js";
import { writeMetadata } from "../metadata.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  SessionManager,
  Session,
  Runtime,
  Agent,
  ActivityState,
  SCM,
  ReviewComment,
} from "../types.js";

// Mock fork-lifecycle-postmerge.js BEFORE importing createLifecycleManager
vi.mock("../fork-lifecycle-postmerge.js", () => ({
  reapPostMergeCoWorkers: vi.fn().mockResolvedValue({
    killed: [],
    hadErrors: false,
    summary: "no co-worker sessions eligible for reaping",
  }),
}));

let tmpDir: string;
let configPath: string;
let sessionsDir: string;
let mockSessionManager: SessionManager;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockRegistry: PluginRegistry;
let mockSCM: SCM;
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

function makePR(overrides: Partial<import("../types.js").PRInfo> = {}): import("../types.js").PRInfo {
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

function makeReviewComments(): ReviewComment[] {
  return [
    {
      id: "RC_1",
      body: "Please fix this typo",
      path: "src/index.ts",
      line: 10,
      user: { login: "reviewer", type: "User" },
      state: "CHANGES_REQUESTED",
      createdAt: new Date().toISOString(),
    },
    {
      id: "RC_2",
      body: "Add a test for this function",
      path: "src/index.ts",
      line: 25,
      user: { login: "reviewer", type: "User" },
      state: "CHANGES_REQUESTED",
      createdAt: new Date().toISOString(),
    },
  ];
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-test-respawn-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");

  sessionsDir = join(tmpDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });

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

  mockSCM = {
    name: "github",
    getPRState: vi.fn(),
    getCISummary: vi.fn(),
    getReviewDecision: vi.fn(),
    getMergeability: vi.fn(),
    mergePR: vi.fn(),
    getReviewComments: vi.fn(),
    getReviews: vi.fn().mockResolvedValue([]),
    getPendingComments: vi.fn().mockResolvedValue([]),
    getAutomatedComments: vi.fn().mockResolvedValue([]),
    getCIChecks: vi.fn().mockResolvedValue([]),
  } as unknown as SCM;

  mockRegistry = {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string, _name?: string) => {
      if (slot === "runtime") return mockRuntime;
      if (slot === "agent") return mockAgent;
      if (slot === "scm") return mockSCM;
      return null;
    }),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn(),
    loadFromConfig: vi.fn(),
  } as unknown as PluginRegistry;

  mockSessionManager = {
    spawn: vi.fn().mockResolvedValue({
      id: "app-respawn-1",
      projectId: "my-app",
      status: "spawning",
      activity: "active",
      branch: "feat/test",
      issueId: null,
      pr: makePR(),
      workspacePath: tmpDir,
      runtimeHandle: { id: "rt-2", runtimeName: "mock", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    }),
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
        repo: "org/repo",
        path: join(tmpDir, "my-app"),
        defaultBranch: "main",
        sessionPrefix: "app",
        scm: { plugin: "github" },
      },
    },
    reactions: {},
  };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// respawn-for-review action
// ---------------------------------------------------------------------------

describe("respawn-for-review reaction action", () => {
  it("spawns a fresh worker when agent is dead + PR has CHANGES_REQUESTED", async () => {
    // Agent is dead
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);
    vi.mocked(mockSCM.getPRState).mockResolvedValue("open");
    vi.mocked(mockSCM.getReviewDecision).mockResolvedValue("changes_requested");
    vi.mocked(mockSCM.getMergeability).mockResolvedValue({ mergeable: false, noConflicts: true });
    vi.mocked(mockSCM.getReviewComments).mockResolvedValue(makeReviewComments());

    const reactionsConfig: OrchestratorConfig = {
      ...config,
      reactions: {
        "changes-requested": {
          auto: true,
          action: "respawn-for-review",
          message: "Fix review comments and push: {{context}}",
          escalateAfter: "30m",
        },
      },
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: tmpDir,
      branch: "feat/test",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config: reactionsConfig,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // respawn-for-review should have spawned a new session for the same PR
    expect(mockSessionManager.spawn).toHaveBeenCalled();
    const spawnCall = mockSessionManager.spawn.mock.calls[0][0];
    expect(spawnCall.projectId).toBe("my-app");
    expect(spawnCall.prompt).toContain("PR #42");
    expect(spawnCall.prompt).toContain("Fix review comments");
  });

  it("does NOT respawn when agent is alive (sends message instead)", async () => {
    // Agent is alive
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(true);
    vi.mocked(mockAgent.getActivityState).mockResolvedValue({ state: "active" });
    vi.mocked(mockSCM.getPRState).mockResolvedValue("open");
    vi.mocked(mockSCM.getReviewDecision).mockResolvedValue("changes_requested");
    vi.mocked(mockSCM.getMergeability).mockResolvedValue({ mergeable: false, noConflicts: true });
    vi.mocked(mockSCM.getReviewComments).mockResolvedValue(makeReviewComments());

    const reactionsConfig: OrchestratorConfig = {
      ...config,
      reactions: {
        "changes-requested": {
          auto: true,
          action: "respawn-for-review",
          message: "Fix review comments: {{context}}",
          escalateAfter: "30m",
        },
      },
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: tmpDir,
      branch: "feat/test",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config: reactionsConfig,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // When alive, respawn-for-review should send a message (not spawn)
    expect(mockSessionManager.send).toHaveBeenCalled();
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  });

  it("returns failure without immediate escalation when spawn fails", async () => {
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);
    vi.mocked(mockSCM.getPRState).mockResolvedValue("open");
    vi.mocked(mockSCM.getReviewDecision).mockResolvedValue("changes_requested");
    vi.mocked(mockSCM.getMergeability).mockResolvedValue({ mergeable: false, noConflicts: true });

    // Simulate spawn failure
    vi.mocked(mockSessionManager.spawn).mockRejectedValue(new Error("spawn failed: no agent available"));

    const reactionsConfig: OrchestratorConfig = {
      ...config,
      reactions: {
        "changes-requested": {
          auto: true,
          action: "respawn-for-review",
          message: "Fix review comments: {{context}}",
          escalateAfter: 1,
          retries: 1,
        },
      },
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: tmpDir,
      branch: "feat/test",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config: reactionsConfig,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // After retries exhausted, should escalate
    expect(lm.getStates().get("app-1")).toBeDefined();
  });

  it("calls getPendingComments to gather review context when spawning for dead agent", async () => {
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);
    vi.mocked(mockSCM.getPRState).mockResolvedValue("open");
    vi.mocked(mockSCM.getReviewDecision).mockResolvedValue("changes_requested");
    vi.mocked(mockSCM.getMergeability).mockResolvedValue({ mergeable: false, noConflicts: true });
    const comments = makeReviewComments();
    vi.mocked(mockSCM.getReviewComments).mockResolvedValue(comments);
    vi.mocked(mockSCM.getPendingComments).mockResolvedValue(comments);

    const reactionsConfig: OrchestratorConfig = {
      ...config,
      reactions: {
        "changes-requested": {
          auto: true,
          action: "respawn-for-review",
          message: "CodeRabbit requested changes. Fix all comments and push: {{context}}",
          escalateAfter: "30m",
        },
      },
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: tmpDir,
      branch: "feat/test",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config: reactionsConfig,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Verify getPendingComments was called (context-building prerequisite)
    expect(mockSCM.getPendingComments).toHaveBeenCalled();

    // Verify spawn was called with correct targeting params
    expect(mockSessionManager.spawn).toHaveBeenCalled();
    const spawnArgs = mockSessionManager.spawn.mock.calls[0]?.[0];
    expect(spawnArgs?.projectId).toBe("my-app");
    expect(spawnArgs?.branch).toBe("feat/test");

    // Verify the prompt includes PR reference
    expect(spawnArgs?.prompt).toContain("PR #42");
  });
});
