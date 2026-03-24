import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { handleSpawnSkeptic } from "../skeptic-reaction.js";
import type {
  SessionId,
  SessionManager,
  OrchestratorConfig,
  PluginRegistry,
  ReactionConfig,
  Session,
  OrchestratorEvent,
  EventPriority,
  EventType,
} from "../types.js";

function makeMockDeps(overrides: {
  sessionGet?: (id: SessionId) => Promise<Session | null>;
  sessionSpawn?: (cfg: unknown) => Promise<Session>;
  sessionSend?: (id: SessionId, msg: string) => Promise<void>;
} = {}) {
  const mockSessionManager: SessionManager = {
    spawn: overrides.sessionSpawn ?? vi.fn().mockResolvedValue({
      id: "app-skeptic-1",
      projectId: "my-app",
      status: "spawning",
      activity: "active",
      branch: "feat/test",
      issueId: null,
      pr: null,
      workspacePath: "/tmp/workspace",
      runtimeHandle: { id: "rt-skeptic", runtimeName: "mock", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    }),
    get: overrides.sessionGet ?? vi.fn().mockResolvedValue({
      id: "app-1",
      projectId: "my-app",
      status: "working",
      activity: "active",
      branch: "feat/test",
      issueId: null,
      pr: null,
      workspacePath: "/tmp/workspace",
      runtimeHandle: { id: "rt-1", runtimeName: "mock", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: { agent: "claude-code" },
    }),
    list: vi.fn().mockResolvedValue([]),
    kill: vi.fn().mockResolvedValue(undefined),
    send: overrides.sessionSend ?? vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
    spawnOrchestrator: vi.fn(),
    restore: vi.fn(),
    claimPR: vi.fn(),
  } as SessionManager;

  const mockConfig: OrchestratorConfig = {
    configPath: "/tmp/config.yaml",
    defaults: {
      runtime: "mock",
      agent: "claude-code",
      workspace: "mock-ws",
      notifiers: ["desktop"],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: "/tmp/workspace",
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
    skeptic: {
      enabled: true,
      maxIterations: 3,
      model: "auto",
      triggerOn: ["READY_FOR_CHECK", "task complete"],
    },
  };

  const mockRegistry: PluginRegistry = {
    register: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn(),
    loadFromConfig: vi.fn(),
  };

  const notifyHuman = vi.fn().mockResolvedValue(undefined);
  const createEvent = vi.fn().mockImplementation(
    (type: EventType, opts: { sessionId: SessionId; projectId: string; message: string; data?: Record<string, unknown> }): OrchestratorEvent => ({
      id: "test-event-id",
      type,
      priority: "info" as EventPriority,
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      timestamp: new Date(),
      message: opts.message,
      data: opts.data ?? {},
    }),
  );

  return {
    sessionManager: mockSessionManager,
    config: mockConfig,
    registry: mockRegistry,
    notifyHuman,
    createEvent,
  };
}

describe("handleSpawnSkeptic", () => {
  const reactionConfig: ReactionConfig = {
    auto: true,
    action: "spawn-skeptic" as ReactionConfig["action"],
  };

  let tmpWorkspace: string;

  beforeEach(() => {
    tmpWorkspace = join(tmpdir(), `ao-test-skeptic-${randomUUID()}`);
    mkdirSync(join(tmpWorkspace, "specs"), { recursive: true });
    writeFileSync(
      join(tmpWorkspace, "specs", "exit-criteria.md"),
      "## A: Build passes\n- pnpm build exits 0\n",
    );
  });

  afterEach(() => {
    rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  function makeDepsWithWorkspace(overrides: Parameters<typeof makeMockDeps>[0] = {}) {
    const deps = makeMockDeps(overrides);
    // Point workspace to real temp dir so exit-criteria.md is found
    deps.config.projects["my-app"].path = tmpWorkspace;
    // Mock session.get to use the real workspace path
    if (!overrides.sessionGet) {
      (deps.sessionManager.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "app-1",
        projectId: "my-app",
        status: "working",
        activity: "active",
        branch: "feat/test",
        issueId: null,
        pr: null,
        workspacePath: tmpWorkspace,
        runtimeHandle: { id: "rt-1", runtimeName: "mock", data: {} },
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: { agent: "claude-code" },
      });
    }
    return deps;
  }

  it("returns failure when session not found", async () => {
    const deps = makeDepsWithWorkspace({
      sessionGet: vi.fn().mockResolvedValue(null),
    });

    const result = await handleSpawnSkeptic(
      "app-1",
      "my-app",
      "worker-signals-completion",
      reactionConfig,
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.action).toBe("spawn-skeptic");
  });

  it("returns failure when project not found", async () => {
    const deps = makeDepsWithWorkspace();
    deps.config.projects = {};

    const result = await handleSpawnSkeptic(
      "app-1",
      "my-app",
      "worker-signals-completion",
      reactionConfig,
      deps,
    );

    expect(result.success).toBe(false);
  });

  it("returns failure when skeptic is disabled", async () => {
    const deps = makeDepsWithWorkspace();
    deps.config.skeptic = { enabled: false, maxIterations: 3, model: "auto", triggerOn: [] };

    const result = await handleSpawnSkeptic(
      "app-1",
      "my-app",
      "worker-signals-completion",
      reactionConfig,
      deps,
    );

    expect(result.success).toBe(false);
  });

  it("spawns a skeptic session on valid request", async () => {
    const deps = makeDepsWithWorkspace();

    const result = await handleSpawnSkeptic(
      "app-1",
      "my-app",
      "worker-signals-completion",
      reactionConfig,
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("spawn-skeptic");
    expect(deps.sessionManager.spawn).toHaveBeenCalled();
  });

  it("returns proper ReactionResult shape", async () => {
    const deps = makeDepsWithWorkspace();

    const result = await handleSpawnSkeptic(
      "app-1",
      "my-app",
      "worker-signals-completion",
      reactionConfig,
      deps,
    );

    expect(result).toHaveProperty("reactionType", "worker-signals-completion");
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("action", "spawn-skeptic");
    expect(result).toHaveProperty("escalated", false);
  });

  it("notifies human about skeptic session spawn", async () => {
    const deps = makeDepsWithWorkspace();

    await handleSpawnSkeptic(
      "app-1",
      "my-app",
      "worker-signals-completion",
      reactionConfig,
      deps,
    );

    expect(deps.notifyHuman).toHaveBeenCalled();
  });

  it("returns failure when exit-criteria.md is missing", async () => {
    const deps = makeDepsWithWorkspace();
    // Remove the exit-criteria.md file
    rmSync(join(tmpWorkspace, "specs", "exit-criteria.md"));

    const result = await handleSpawnSkeptic(
      "app-1",
      "my-app",
      "worker-signals-completion",
      reactionConfig,
      deps,
    );

    expect(result.success).toBe(false);
    expect(deps.notifyHuman).toHaveBeenCalled();
  });
});

