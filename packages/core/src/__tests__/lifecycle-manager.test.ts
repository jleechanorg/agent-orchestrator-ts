import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLifecycleManager } from "../lifecycle-manager.js";
import { createEventBus } from "../event-bus.js";
import { writeMetadata, readMetadataRaw } from "../metadata.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  SessionManager,
  Session,
  Runtime,
  Agent,
  SCM,
  EventBus,
  OrchestratorEvent,
  ActivityState,
  PRInfo,
} from "../types.js";

let dataDir: string;
let eventBus: EventBus;
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
    workspacePath: "/tmp/ws",
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
  dataDir = join(tmpdir(), `ao-test-lifecycle-${randomUUID()}`);
  mkdirSync(join(dataDir, "sessions"), { recursive: true });

  eventBus = createEventBus(null);

  mockRuntime = {
    name: "mock",
    create: vi.fn(),
    destroy: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getOutput: vi.fn(),
    isAlive: vi.fn().mockResolvedValue(true),
  };

  mockAgent = {
    name: "mock-agent",
    processName: "mock",
    getLaunchCommand: vi.fn(),
    getEnvironment: vi.fn(),
    detectActivity: vi.fn().mockResolvedValue("active" as ActivityState),
    isProcessRunning: vi.fn(),
    introspect: vi.fn(),
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
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    kill: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
  };

  config = {
    dataDir,
    worktreeDir: "/tmp/worktrees",
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
        path: "/tmp/my-app",
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
  };
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("start / stop", () => {
  it("starts and stops the polling loop", () => {
    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      eventBus,
    });

    lm.start(60_000);
    // Should not throw on double start
    lm.start(60_000);
    lm.stop();
    // Should not throw on double stop
    lm.stop();
  });
});

describe("check (single session)", () => {
  it("detects transition from spawning to working", async () => {
    const session = makeSession({ status: "spawning" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    // Write metadata so updateMetadata works
    writeMetadata(dataDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
    });

    const received: OrchestratorEvent[] = [];
    eventBus.on("session.working", (e) => received.push(e));

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      eventBus,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("working");
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("session.working");

    // Metadata should be updated
    const meta = readMetadataRaw(dataDir, "app-1");
    expect(meta!["status"]).toBe("working");
  });

  it("detects killed state when runtime is dead", async () => {
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(dataDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      eventBus,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("killed");
  });

  it("detects stuck state from agent", async () => {
    vi.mocked(mockAgent.detectActivity).mockResolvedValue("blocked");

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(dataDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      eventBus,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("detects needs_input from agent", async () => {
    vi.mocked(mockAgent.detectActivity).mockResolvedValue("waiting_input");

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(dataDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      eventBus,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("needs_input");
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

    writeMetadata(dataDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
      eventBus,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("ci_failed");
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

    writeMetadata(dataDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "approved",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
      eventBus,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("merged");
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

    writeMetadata(dataDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
      eventBus,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("mergeable");
  });

  it("throws for nonexistent session", async () => {
    vi.mocked(mockSessionManager.get).mockResolvedValue(null);

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      eventBus,
    });

    await expect(lm.check("nonexistent")).rejects.toThrow("not found");
  });

  it("does not emit event when status unchanged", async () => {
    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(dataDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const received: OrchestratorEvent[] = [];
    eventBus.on("*", (e) => received.push(e));

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      eventBus,
    });

    // First check: spawning (from states map, empty) → working = transition
    // But the session's status is "working" and determineStatus returns "working"
    // Since states map is empty, oldStatus = session.status = "working", newStatus = "working"
    // So no transition
    // We need to seed the states map first
    // Actually, let's check twice: first time sets it, second time same = no event
    await lm.check("app-1");
    const eventsAfterFirst = [...received];

    await lm.check("app-1");
    // No new events emitted since status didn't change
    expect(received.length).toBe(eventsAfterFirst.length);
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

    writeMetadata(dataDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
      eventBus,
    });

    await lm.check("app-1");

    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "CI is failing. Fix it.");
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

    writeMetadata(dataDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
      eventBus,
    });

    await lm.check("app-1");

    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });
});

describe("on / off event handlers", () => {
  it("subscribes and receives lifecycle events", async () => {
    const session = makeSession({ status: "spawning" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(dataDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
    });

    const received: OrchestratorEvent[] = [];

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      eventBus,
    });

    lm.on("session.working", (e) => received.push(e));

    await lm.check("app-1");

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("session.working");
  });

  it("unsubscribes handlers", async () => {
    const session = makeSession({ status: "spawning" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(dataDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
    });

    const received: OrchestratorEvent[] = [];
    const handler = (e: OrchestratorEvent) => received.push(e);

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      eventBus,
    });

    lm.on("session.working", handler);
    lm.off("session.working", handler);

    await lm.check("app-1");

    expect(received).toHaveLength(0);
  });

  it("wildcard handler receives all events", async () => {
    const session = makeSession({ status: "spawning" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(dataDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
    });

    const received: OrchestratorEvent[] = [];

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      eventBus,
    });

    lm.on("*", (e) => received.push(e));

    await lm.check("app-1");

    expect(received.length).toBeGreaterThan(0);
  });
});

describe("getStates", () => {
  it("returns copy of states map", async () => {
    const session = makeSession({ status: "spawning" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(dataDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      eventBus,
    });

    await lm.check("app-1");

    const states = lm.getStates();
    expect(states.get("app-1")).toBe("working");

    // Modifying returned map shouldn't affect internal state
    states.set("app-1", "killed");
    expect(lm.getStates().get("app-1")).toBe("working");
  });
});
