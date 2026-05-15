import { describe, it, expect, vi } from "vitest";
import {
  handleAgentFallback,
  resolveNextFallbackAgent,
  type AgentFallbackDeps,
} from "../fork-reaction-agent-fallback.js";
import type { Session, OrchestratorConfig, ReactionConfig, SessionManager } from "../types.js";
import type { ProjectObserver } from "../observability.js";

// Mock fork-utils so we can verify metadata write ordering without disk I/O
vi.mock("../fork-utils.js", () => ({
  updateSessionMetadataHelper: vi.fn(),
}));

// resolveNextFallbackAgent is exported for testability
describe("resolveNextFallbackAgent", () => {
  it("returns next agent in chain when current agent has a fallback", () => {
    expect(resolveNextFallbackAgent("wafer", ["gemini", "minimax"], "wafer")).toBe("gemini");
  });

  it("returns second fallback when current is the first fallback", () => {
    expect(resolveNextFallbackAgent("gemini", ["gemini", "minimax"], "wafer")).toBe("minimax");
  });

  it("returns undefined when current agent is last in chain", () => {
    expect(resolveNextFallbackAgent("minimax", ["gemini", "minimax"], "wafer")).toBeUndefined();
  });

  it("returns undefined when fallbackAgents is empty", () => {
    expect(resolveNextFallbackAgent("wafer", [], "wafer")).toBeUndefined();
  });

  it("returns undefined when fallbackAgents is undefined", () => {
    expect(resolveNextFallbackAgent("wafer", undefined, "wafer")).toBeUndefined();
  });

  it("is case-insensitive for current agent matching", () => {
    expect(resolveNextFallbackAgent("Wafer", ["gemini", "minimax"], "wafer")).toBe("gemini");
  });

  it("prepends current agent to chain when it differs from default (project-level override)", () => {
    // When a project overrides the agent (e.g. project.agent=wafer but defaults.agent=codex),
    // currentAgent is prepended to the canonical chain, so fallback goes codex→gemini→minimax.
    expect(resolveNextFallbackAgent("wafer", ["gemini", "minimax"], "codex")).toBe("codex");
  });

  it("prepends unknown agent to chain as first position", () => {
    // An unknown agent gets prepended to the chain —
    // next fallback is the defaultAgent, then the configured fallbacks.
    expect(resolveNextFallbackAgent("unknown", ["gemini", "minimax"], "wafer")).toBe("wafer");
  });
});

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ao-5215",
    tmuxName: "test-ao-5215",
    projectId: "agent-orchestrator",
    status: "killed",
    activity: null,
    branch: "feat/test",
    issueId: null,
    pr: {
      number: 551,
      url: "https://github.com/test/pr/551",
      title: "Test PR",
      branch: "feat/test",
      baseBranch: "main",
      isDraft: false,
      owner: "test",
      repo: "test",
    },
    workspacePath: "/tmp/test",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: { agent: "wafer" },
    ...overrides,
  } satisfies Session;
}

function makeConfig(fallbackAgents?: string[]): OrchestratorConfig {
  return {
    configPath: "/tmp/test.yaml",
    port: 3000,
    readyThresholdMs: 300000,
    defaults: {
      runtime: "tmux",
      agent: "wafer",
      workspace: "worktree",
      notifiers: [],
      orchestrator: {},
      worker: {},
      fallbackAgents,
    },
    projects: {
      "agent-orchestrator": {
        name: "test",
        path: "/tmp/test",
        repo: "test/test",
        sessionPrefix: "ao",
        defaultBranch: "main",
        tracker: { plugin: "github" },
        scm: { plugin: "github" },
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
  } satisfies OrchestratorConfig;
}

function makeDeps(): AgentFallbackDeps {
  return {
    sessionManager: {
      spawn: vi.fn().mockResolvedValue({ id: "ao-5220" }),
      kill: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(),
      get: vi.fn(),
    } satisfies Partial<SessionManager> as SessionManager,
    config: makeConfig(["gemini", "minimax"]),
    notifyHuman: vi.fn().mockResolvedValue(undefined),
    createEvent: vi.fn((_type: string, opts: Record<string, unknown>) => opts),
    observer: {
      recordOperation: vi.fn(),
    } satisfies Partial<ProjectObserver> as ProjectObserver,
  };
}

describe("handleAgentFallback", () => {
  const reactionConfig: ReactionConfig = {
    auto: true,
    action: "agent-fallback",
  };

  it("spawns new session with next agent when agent is dead and fallback exists", async () => {
    const session = makeSession();
    const deps = makeDeps();

    const result = await handleAgentFallback(
      "ao-5215",
      "agent-orchestrator",
      "agent-exited",
      reactionConfig,
      session,
      true, // agentDead
      "corr-123",
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("agent-fallback");
    expect(deps.sessionManager.kill).toHaveBeenCalledWith("ao-5215");
    expect(deps.sessionManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "gemini", projectId: "agent-orchestrator" }),
    );
    expect(session.metadata["fallback_agent"]).toBe("gemini");
  });

  it("writes fallback metadata BEFORE kill (not after), preventing ghost session", async () => {
    const { updateSessionMetadataHelper } = await import("../fork-utils.js");
    (updateSessionMetadataHelper as ReturnType<typeof vi.fn>).mockClear();
    const session = makeSession();
    const deps = makeDeps();

    await handleAgentFallback(
      "ao-5215",
      "agent-orchestrator",
      "agent-exited",
      reactionConfig,
      session,
      true,
      "corr-123",
      deps,
    );

    // updateSessionMetadataHelper is called once: pending before kill
    // No metadata write after kill to prevent ghost session recreation
    expect(updateSessionMetadataHelper).toHaveBeenCalledTimes(1);
    const pendingCall = (updateSessionMetadataHelper as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(pendingCall[1]).toEqual(expect.objectContaining({ fallback_pending: "true" }));
    // Metadata write happens before kill
    const metaOrder = (updateSessionMetadataHelper as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const killOrder = deps.sessionManager.kill.mock.invocationCallOrder[0];
    expect(metaOrder).toBeLessThan(killOrder);
  });

  it("returns no-op when agent is alive", async () => {
    const session = makeSession();
    const deps = makeDeps();

    const result = await handleAgentFallback(
      "ao-5215",
      "agent-orchestrator",
      "agent-exited",
      reactionConfig,
      session,
      false, // agent alive
      "corr-123",
      deps,
    );

    expect(result.success).toBe(true);
    expect(deps.sessionManager.kill).not.toHaveBeenCalled();
    expect(deps.sessionManager.spawn).not.toHaveBeenCalled();
  });

  it("returns no-op when agent liveness is unknown (undefined)", async () => {
    const session = makeSession();
    const deps = makeDeps();

    const result = await handleAgentFallback(
      "ao-5215",
      "agent-orchestrator",
      "agent-exited",
      reactionConfig,
      session,
      undefined, // liveness unknown
      "corr-123",
      deps,
    );

    expect(result.success).toBe(true);
    expect(deps.sessionManager.kill).not.toHaveBeenCalled();
    expect(deps.sessionManager.spawn).not.toHaveBeenCalled();
  });

  it("escalates when fallback chain is exhausted", async () => {
    const session = makeSession({ metadata: { agent: "minimax" } });
    const deps = makeDeps();
    deps.config = makeConfig(["gemini", "minimax"]);

    const result = await handleAgentFallback(
      "ao-5215",
      "agent-orchestrator",
      "agent-exited",
      reactionConfig,
      session,
      true,
      "corr-123",
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.escalated).toBe(true);
    expect(deps.sessionManager.spawn).not.toHaveBeenCalled();
  });

  it("escalates when no fallback chain is configured", async () => {
    const session = makeSession();
    const deps = makeDeps();
    deps.config = makeConfig(undefined);

    const result = await handleAgentFallback(
      "ao-5215",
      "agent-orchestrator",
      "agent-exited",
      reactionConfig,
      session,
      true,
      "corr-123",
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.escalated).toBe(true);
  });

  it("skips spawn when session already fell back", async () => {
    const session = makeSession({
      metadata: { agent: "wafer", fallback_spawned: "true", fallback_agent: "gemini" },
    });
    const deps = makeDeps();

    const result = await handleAgentFallback(
      "ao-5215",
      "agent-orchestrator",
      "agent-exited",
      reactionConfig,
      session,
      true,
      "corr-123",
      deps,
    );

    expect(result.success).toBe(true);
    expect(deps.sessionManager.spawn).not.toHaveBeenCalled();
  });

  it("skips spawn when fallback is pending (in-progress kill, spawn not yet complete)", async () => {
    const session = makeSession({
      metadata: { agent: "wafer", fallback_pending: "true", fallback_agent: "gemini" },
    });
    const deps = makeDeps();

    const result = await handleAgentFallback(
      "ao-5215",
      "agent-orchestrator",
      "agent-exited",
      reactionConfig,
      session,
      true,
      "corr-123",
      deps,
    );

    expect(result.success).toBe(true);
    expect(deps.sessionManager.spawn).not.toHaveBeenCalled();
  });

  it("passes branch when session has no PR or issue", async () => {
    const session = makeSession({ pr: null, issueId: null, branch: "feat/standalone" });
    const deps = makeDeps();

    const result = await handleAgentFallback(
      "ao-5215",
      "agent-orchestrator",
      "agent-exited",
      reactionConfig,
      session,
      true,
      "corr-123",
      deps,
    );

    expect(result.success).toBe(true);
    expect(deps.sessionManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "gemini", branch: "feat/standalone" }),
    );
  });

  it("uses project-level fallbackAgents when configured", async () => {
    const session = makeSession({ metadata: { agent: "wafer" } });
    const deps = makeDeps();
    deps.config = makeConfig(["gemini", "minimax"]);
    deps.config.projects["agent-orchestrator"]!.fallbackAgents = ["codex", "aider"];

    const result = await handleAgentFallback(
      "ao-5215",
      "agent-orchestrator",
      "agent-exited",
      reactionConfig,
      session,
      true,
      "corr-123",
      deps,
    );

    expect(result.success).toBe(true);
    expect(deps.sessionManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "codex" }),
    );
  });

  it("returns failure when sessionManager.spawn rejects (metadata already written)", async () => {
    const { updateSessionMetadataHelper } = await import("../fork-utils.js");
    (updateSessionMetadataHelper as ReturnType<typeof vi.fn>).mockClear();
    const session = makeSession();
    const deps = makeDeps();
    (deps.sessionManager.spawn as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("spawn failed"),
    );

    const result = await handleAgentFallback(
      "ao-5215",
      "agent-orchestrator",
      "agent-exited",
      reactionConfig,
      session,
      true,
      "corr-123",
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.escalated).toBe(false);
    // On spawn failure: fallback_pending is cleared so future retries are not blocked
    expect(session.metadata["fallback_pending"]).toBeUndefined();
    expect(session.metadata["fallback_agent"]).toBeUndefined();
    // Two metadata writes: pending before kill, clear after spawn failure
    expect(updateSessionMetadataHelper).toHaveBeenCalledTimes(2);
    const clearCall = (updateSessionMetadataHelper as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(clearCall[1]).toEqual(expect.objectContaining({ fallback_pending: "false" }));
  });

  it("uses project.agent as currentAgent fallback when session metadata has no agent", async () => {
    const session = makeSession({ metadata: {} });
    const deps = makeDeps();
    deps.config = makeConfig(["gemini", "minimax"]);
    deps.config.projects["agent-orchestrator"]!.agent = "wafer";

    const result = await handleAgentFallback(
      "ao-5215",
      "agent-orchestrator",
      "agent-exited",
      reactionConfig,
      session,
      true,
      "corr-123",
      deps,
    );

    // currentAgent resolves to project.agent ("wafer"), so next in chain is "gemini"
    expect(result.success).toBe(true);
    expect(deps.sessionManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "gemini" }),
    );
  });

  it("kills superseded session before spawning fallback", async () => {
    const session = makeSession();
    const deps = makeDeps();

    const result = await handleAgentFallback(
      "ao-5215",
      "agent-orchestrator",
      "agent-exited",
      reactionConfig,
      session,
      true,
      "corr-123",
      deps,
    );

    expect(result.success).toBe(true);
    expect(deps.sessionManager.kill).toHaveBeenCalledWith("ao-5215");
    // kill is called before spawn
    const killOrder = deps.sessionManager.kill.mock.invocationCallOrder[0];
    const spawnOrder = deps.sessionManager.spawn.mock.invocationCallOrder[0];
    expect(killOrder).toBeLessThan(spawnOrder);
  });

  it("proceeds with spawn even when kill of superseded session fails", async () => {
    const session = makeSession();
    const deps = makeDeps();
    (deps.sessionManager.kill as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("kill failed"),
    );

    const result = await handleAgentFallback(
      "ao-5215",
      "agent-orchestrator",
      "agent-exited",
      reactionConfig,
      session,
      true,
      "corr-123",
      deps,
    );

    expect(result.success).toBe(true);
    expect(deps.sessionManager.kill).toHaveBeenCalledWith("ao-5215");
    expect(deps.sessionManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "gemini" }),
    );
  });

  it("metadata write only before kill to prevent ghost session recreation", async () => {
    const { updateSessionMetadataHelper } = await import("../fork-utils.js");
    (updateSessionMetadataHelper as ReturnType<typeof vi.fn>).mockClear();
    const session = makeSession();
    const deps = makeDeps();

    await handleAgentFallback(
      "ao-5215",
      "agent-orchestrator",
      "agent-exited",
      reactionConfig,
      session,
      true,
      "corr-123",
      deps,
    );

    // Single metadata write: pending before kill
    // No write after kill to prevent ghost session recreation
    expect(updateSessionMetadataHelper).toHaveBeenCalledTimes(1);

    // Phase 1 (pending) happens before kill
    const pendingCall = (updateSessionMetadataHelper as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(pendingCall[1]).toEqual(expect.objectContaining({ fallback_pending: "true" }));
    const pendingOrder = (updateSessionMetadataHelper as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const killOrder = deps.sessionManager.kill.mock.invocationCallOrder[0];
    const spawnOrder = deps.sessionManager.spawn.mock.invocationCallOrder[0];
    expect(pendingOrder).toBeLessThan(killOrder);
    expect(killOrder).toBeLessThan(spawnOrder);

    // Full ordering: pending → kill → spawn (no metadata write after spawn)
  });

  it("retries fallback after spawn failure clears pending flag", async () => {
    const session = makeSession();
    const deps = makeDeps();
    (deps.sessionManager.spawn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("spawn failed"),
    );

    const result1 = await handleAgentFallback(
      "ao-5215",
      "agent-orchestrator",
      "agent-exited",
      reactionConfig,
      session,
      true,
      "corr-123",
      deps,
    );

    expect(result1.success).toBe(false);
    expect(session.metadata["fallback_pending"]).toBeUndefined();

    // Second call should attempt spawn again (not blocked by stale pending)
    const result2 = await handleAgentFallback(
      "ao-5215",
      "agent-orchestrator",
      "agent-exited",
      reactionConfig,
      session,
      true,
      "corr-456",
      deps,
    );

    expect(result2.success).toBe(true);
    expect(deps.sessionManager.spawn).toHaveBeenCalledTimes(2);
  });
});
