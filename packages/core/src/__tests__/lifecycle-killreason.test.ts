/**
 * Tests for explicit killConfirmed reason strings on SCM threshold kills.
 *
 * Before this fix, two kill paths in lifecycle-manager.ts (detectPR threshold
 * and post-detectPR SCM threshold) set `killConfirmed` to the boolean string
 * "true", which is not diagnostically useful when a worker is killed.
 *
 * Expected reason strings:
 *   - detectPR-threshold kill  -> "scm-failure-detectPR-threshold"
 *   - post-detectPR SCM kill   -> "scm-failure-threshold"
 *
 * Reference: the third kill path (stuck-probe at lifecycle-manager.ts:2558)
 * already uses the canonical reason string "stuck-probe".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createLifecycleManager } from "../lifecycle-manager.js";
import { getSessionsDir, getProjectBaseDir } from "../paths.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  SessionManager,
  Session,
  Runtime,
  Agent,
  ActivityState,
  SCM,
} from "../types.js";

vi.mock("../fork-lifecycle-postmerge.js", () => ({
  reapPostMergeCoWorkers: vi.fn().mockResolvedValue({
    killed: [],
    hadErrors: false,
    summary: "no co-worker sessions eligible for reaping",
  }),
}));

let tmpDir: string;
let configPath: string;
let mockSessionManager: SessionManager;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockScm: SCM;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;

type SessionOptions = {
  activity?: Session["activity"];
  agentInfo?: Session["agentInfo"];
  branch?: Session["branch"];
  createdAt?: Session["createdAt"];
  id?: Session["id"];
  issueId?: Session["issueId"];
  lastActivityAt?: Session["lastActivityAt"];
  metadata?: Session["metadata"];
  pr?: Session["pr"];
  projectId?: Session["projectId"];
  runtimeHandle?: Session["runtimeHandle"];
  status?: Session["status"];
  workspacePath?: Session["workspacePath"];
};

function makeSession({
  activity = "active",
  agentInfo = null,
  branch = "feat/test",
  createdAt = new Date(),
  id = "app-1",
  issueId = null,
  lastActivityAt = new Date(),
  metadata = {},
  pr = null,
  projectId = "my-app",
  runtimeHandle = { id: "rt-1", runtimeName: "mock", data: {} },
  status = "working",
  workspacePath = join(tmpDir, "my-app"),
}: SessionOptions = {}): Session {
  return {
    id,
    projectId,
    status,
    activity,
    branch,
    issueId,
    pr,
    workspacePath,
    runtimeHandle,
    agentInfo,
    createdAt,
    lastActivityAt,
    metadata: { role: "worker", ...metadata },
  };
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-test-killreason-${randomUUID()}`);
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

  mockScm = {
    name: "mock-scm",
    detectPR: vi.fn().mockResolvedValue(null),
    getPRState: vi.fn().mockResolvedValue("open"),
    getReviewDecision: vi.fn().mockResolvedValue("none"),
    getCISummary: vi.fn().mockResolvedValue("passing"),
    getMergeability: vi.fn().mockResolvedValue({ mergeable: true, noConflicts: true }),
    getPendingComments: vi.fn().mockResolvedValue([]),
    getAutomatedComments: vi.fn().mockResolvedValue([]),
    getReviews: vi.fn().mockResolvedValue([]),
    getCIChecks: vi.fn().mockResolvedValue([]),
    mergePR: vi.fn().mockResolvedValue(undefined),
    closePR: vi.fn().mockResolvedValue(undefined),
    getBatchPRStatus: undefined,
  };

  mockRegistry = {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string) => {
      if (slot === "runtime") return mockRuntime;
      if (slot === "agent") return mockAgent;
      if (slot === "scm") return mockScm;
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
    readyThresholdMs: 300_000,
    startupGracePeriodMs: 0,
    scmFailureThreshold: 4,
    defaults: {
      runtime: "mock",
      agent: "mock-agent",
      workspace: "mock-ws",
      notifiers: [],
      orchestrator: {},
      worker: {},
      scmFailureThreshold: 3,
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: join(tmpDir, "my-app"),
        defaultBranch: "main",
        sessionPrefix: "app",
        scm: { plugin: "mock-scm" },
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

  const sessionsDir = getSessionsDir(configPath, join(tmpDir, "my-app"));
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  const projectBaseDir = getProjectBaseDir(configPath, join(tmpDir, "my-app"));
  if (existsSync(projectBaseDir)) {
    rmSync(projectBaseDir, { recursive: true, force: true });
  }
  rmSync(tmpDir, { recursive: true, force: true });
  vi.resetAllMocks();
});

describe("killConfirmed reason strings on SCM threshold kills", () => {
  it("uses 'scm-failure-detectPR-threshold' when detectPR threshold fires (dead agent)", async () => {
    // Dead agent + no PR + detectPR throws repeatedly.
    // Count starts at 2 (one short of threshold 3) — a single throw pushes it
    // to 3 and the threshold-kill branch fires.
    // Create the workspace path so the existsSync check at line 602 doesn't
    // pre-empt the SCM-failure kill path.
    const workspacePath = join(tmpDir, "my-app");
    mkdirSync(workspacePath, { recursive: true });
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);
    vi.mocked(mockScm.detectPR!).mockImplementation(async () => {
      throw new Error("scm network blip");
    });

    const session = makeSession({
      metadata: { scmFailureCount: "2" },
      workspacePath,
    });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    const lifecycleManager = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lifecycleManager.check("app-1");

    expect(lifecycleManager.getStates().get("app-1")).toBe("killed");
    expect(session.metadata["killConfirmed"]).toBe("scm-failure-detectPR-threshold");
    // Previous bug shape: just the boolean string. Assert it is NOT the
    // legacy shape so a regression is loud.
    expect(session.metadata["killConfirmed"]).not.toBe("true");
  });

  it("uses 'scm-failure-threshold' when post-detectPR SCM threshold fires (dead agent)", async () => {
    // Dead agent + detectPR returns a PR + downstream getPRState throws.
    // We override the project's scmFailureThreshold to 1 so the FIRST step-4
    // catch (after step 3 resets the counter) is enough to trip the kill branch.
    // This isolates the post-detectPR threshold-kill behavior from the
    // consecutive-failure accumulator that the detectPR path also exercises.
    const workspacePath = join(tmpDir, "my-app");
    mkdirSync(workspacePath, { recursive: true });
    const fakePR = {
      number: 42,
      url: "https://github.com/org/repo/pull/42",
      title: "Fix things",
      owner: "org",
      repo: "repo",
      branch: "feat/test",
      baseBranch: "main",
      isDraft: false,
    };
    const testConfig: OrchestratorConfig = {
      ...config,
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          scmFailureThreshold: 1,
        },
      },
    };
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);
    vi.mocked(mockScm.detectPR!).mockResolvedValue(fakePR);
    // Make getPRState throw so the outer try at line 831 catches and increments
    // the consecutive-failure counter, reaching the threshold-kill branch at
    // line 1033.
    vi.mocked(mockScm.getPRState!).mockImplementation(async () => {
      throw new Error("scm network blip");
    });

    const session = makeSession({
      metadata: { scmFailureCount: "0" },
      workspacePath,
    });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    const lifecycleManager = createLifecycleManager({
      config: testConfig,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lifecycleManager.check("app-1");

    expect(lifecycleManager.getStates().get("app-1")).toBe("killed");
    expect(session.metadata["killConfirmed"]).toBe("scm-failure-threshold");
    expect(session.metadata["killConfirmed"]).not.toBe("true");
  });
});
