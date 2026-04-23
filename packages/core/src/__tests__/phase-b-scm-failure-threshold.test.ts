/**
 * Phase B: scmFailureThreshold precedence tests.
 *
 * Runtime order under test:
 * project.scmFailureThreshold ??
 * config.defaults.scmFailureThreshold ??
 * config.scmFailureThreshold ??
 * 3
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { validateConfig } from "../config.js";
import { createLifecycleManager } from "../lifecycle-manager.js";
import { getSessionsDir, getProjectBaseDir } from "../paths.js";
import { resolveScmFailureThreshold } from "../scm-failure-threshold.js";
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
let sessionsDir: string;
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
  tmpDir = join(tmpdir(), `ao-test-scm-failure-${randomUUID()}`);
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

  const scmMock: Partial<SCM> = {
    name: "mock-scm",
    detectPR: vi.fn().mockResolvedValue(null),
    getPRState: vi.fn().mockResolvedValue("open"),
    getReviewDecision: vi.fn().mockResolvedValue("none"),
    getCISummary: vi.fn().mockResolvedValue("passing"),
    getMergeability: vi.fn().mockResolvedValue({ mergeable: true, noConflicts: true }),
  };
  mockScm = scmMock as SCM;

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

  sessionsDir = getSessionsDir(configPath, join(tmpDir, "my-app"));
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

describe("scmFailureThreshold precedence (Phase B)", () => {
  it("prefers defaults.scmFailureThreshold over the top-level global threshold", () => {
    const configWithDefaults = {
      ...config,
      scmFailureThreshold: 4,
      defaults: { ...config.defaults, scmFailureThreshold: 2 },
    };

    expect(resolveScmFailureThreshold(configWithDefaults.projects["my-app"], configWithDefaults)).toBe(
      2,
    );
  });

  it("falls back to the top-level global threshold when defaults override is absent", () => {
    const { scmFailureThreshold: _ignoredThreshold, ...defaultsWithoutThreshold } = config.defaults;
    const configWithTopLevelFallback = {
      ...config,
      scmFailureThreshold: 2,
      defaults: defaultsWithoutThreshold,
    };

    expect(
      resolveScmFailureThreshold(
        configWithTopLevelFallback.projects["my-app"],
        configWithTopLevelFallback,
      ),
    ).toBe(2);
  });

  it("honors the legacy top-level threshold after schema parsing when defaults omit an override", () => {
    const validatedConfig = validateConfig({
      projects: {
        "my-app": {
          repo: "org/my-app",
          path: join(tmpDir, "my-app"),
        },
      },
      scmFailureThreshold: 5,
      defaults: {
        runtime: "mock",
        agent: "mock-agent",
        workspace: "mock-ws",
        notifiers: [],
      },
    });

    expect(
      resolveScmFailureThreshold(validatedConfig.projects["my-app"], validatedConfig),
    ).toBe(5);
  });

  it("prefers the project override over defaults and top-level thresholds", () => {
    const configWithProjectOverride = {
      ...config,
      scmFailureThreshold: 5,
      defaults: { ...config.defaults, scmFailureThreshold: 4 },
      projects: {
        "my-app": {
          ...config.projects["my-app"],
          scmFailureThreshold: 2,
        },
      },
    };

    expect(
      resolveScmFailureThreshold(
        configWithProjectOverride.projects["my-app"],
        configWithProjectOverride,
      ),
    ).toBe(2);
  });

  it("still kills dead no-PR sessions when the threshold does not fire", async () => {
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);
    vi.mocked(mockScm.detectPR!).mockResolvedValue(null);

    const session = makeSession({ metadata: { scmFailureCount: "1" } });
    vi.mocked(mockSessionManager.list).mockResolvedValue([session]);
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    const lifecycleManager = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lifecycleManager.check("app-1");

    expect(lifecycleManager.getStates().get("app-1")).toBe("killed");
  });
});
