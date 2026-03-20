import { describe, it, expect, vi, beforeEach } from "vitest";
import { ParallelRetryMonitor } from "../parallel-retry.js";
import type {
  SessionManager,
  PluginRegistry,
  OrchestratorConfig,
  SCM,
  Session,
  CIStatus,
  SessionId,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(id: SessionId, overrides?: Partial<Session>): Session {
  return {
    id,
    projectId: "test-project",
    status: "working",
    activity: "active",
    branch: `branch-${id}`,
    issueId: null,
    pr: null,
    workspacePath: `/tmp/${id}`,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makePR(sessionId: string) {
  return {
    number: 1,
    url: `https://github.com/test/repo/pull/1`,
    title: `PR for ${sessionId}`,
    owner: "test",
    repo: "repo",
    branch: `branch-${sessionId}`,
    baseBranch: "main",
    isDraft: false,
  };
}

function createMocks() {
  const sessionManager: SessionManager = {
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    restore: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    kill: vi.fn(),
    cleanup: vi.fn(),
    send: vi.fn(),
    claimPR: vi.fn(),
  };

  const mockSCM: SCM = {
    name: "github",
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
  };

  const registry: PluginRegistry = {
    register: vi.fn(),
    get: vi.fn((_slot: string, _name: string) => mockSCM),
    list: vi.fn(),
    loadBuiltins: vi.fn(),
    loadFromConfig: vi.fn(),
  };

  const config = {
    configPath: "/tmp/config.yaml",
    projects: {
      "test-project": {
        name: "Test",
        repo: "test/repo",
        path: "/tmp/test",
        defaultBranch: "main",
        sessionPrefix: "test",
        scm: { plugin: "github" },
      },
    },
  } as unknown as OrchestratorConfig;

  return { sessionManager, mockSCM, registry, config };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ParallelRetryMonitor", () => {
  let monitor: ParallelRetryMonitor;
  let sessionManager: SessionManager;
  let mockSCM: SCM;
  let registry: PluginRegistry;
  let config: OrchestratorConfig;

  const strategies = ["fix-lint", "fix-types", "fix-tests"];
  const parallelRetryConfig = {
    maxParallel: 3,
    strategies,
    killOnSuccess: true,
  };

  beforeEach(() => {
    const mocks = createMocks();
    sessionManager = mocks.sessionManager;
    mockSCM = mocks.mockSCM;
    registry = mocks.registry;
    config = mocks.config;

    let spawnCount = 0;
    vi.mocked(sessionManager.spawn).mockImplementation(async () => {
      spawnCount++;
      return makeSession(`race-session-${spawnCount}`);
    });

    monitor = new ParallelRetryMonitor({ sessionManager, registry, config });
  });

  // 1. startRace creates race group with correct session entries
  it("startRace creates race group with correct session entries", async () => {
    const race = await monitor.startRace("parent-1", "test-project", undefined, parallelRetryConfig);

    expect(race.id).toBeDefined();
    expect(race.parentSessionId).toBe("parent-1");
    expect(race.projectId).toBe("test-project");
    expect(race.status).toBe("running");
    expect(race.sessions).toHaveLength(3);
    expect(race.sessions.map((s) => s.strategy)).toEqual(strategies);
    expect(sessionManager.spawn).toHaveBeenCalledTimes(3);
  });

  // 2. startRace respects maxParallel limit
  it("startRace respects maxParallel limit", async () => {
    const limitedConfig = { maxParallel: 2, strategies, killOnSuccess: true };
    const race = await monitor.startRace("parent-1", "test-project", undefined, limitedConfig);

    expect(race.sessions).toHaveLength(2);
    expect(sessionManager.spawn).toHaveBeenCalledTimes(2);
  });

  // 3. checkRace detects winner when one session has CI passing
  it("checkRace detects winner when CI is passing", async () => {
    const race = await monitor.startRace("parent-1", "test-project", undefined, parallelRetryConfig);

    // Session 2 has a PR with passing CI
    vi.mocked(sessionManager.get).mockImplementation(async (id: SessionId) => {
      if (id === "race-session-2") {
        return makeSession(id, { pr: makePR(id) });
      }
      return makeSession(id);
    });

    vi.mocked(mockSCM.getCISummary).mockResolvedValue("passing" as CIStatus);

    const updated = await monitor.checkRace(race.id);

    expect(updated.status).toBe("won");
    expect(updated.winner).toBe("race-session-2");
  });

  // 4. checkRace returns "running" when all CIs are still pending
  it("checkRace returns running when all CIs are pending", async () => {
    const race = await monitor.startRace("parent-1", "test-project", undefined, parallelRetryConfig);

    vi.mocked(sessionManager.get).mockImplementation(async (id: SessionId) =>
      makeSession(id, { pr: makePR(id) }),
    );
    vi.mocked(mockSCM.getCISummary).mockResolvedValue("pending" as CIStatus);

    const updated = await monitor.checkRace(race.id);

    expect(updated.status).toBe("running");
    expect(updated.winner).toBeUndefined();
  });

  // 5. checkRace returns "failed" when all CIs fail and all sessions are terminal
  it("checkRace returns failed when all sessions fail", async () => {
    const race = await monitor.startRace("parent-1", "test-project", undefined, parallelRetryConfig);

    vi.mocked(sessionManager.get).mockImplementation(async (id: SessionId) =>
      makeSession(id, { pr: makePR(id), status: "errored", activity: "exited" }),
    );
    vi.mocked(mockSCM.getCISummary).mockResolvedValue("failing" as CIStatus);

    const updated = await monitor.checkRace(race.id);

    expect(updated.status).toBe("failed");
  });

  // 6. resolveRace kills loser sessions when winner found
  it("resolveRace kills loser sessions", async () => {
    const race = await monitor.startRace("parent-1", "test-project", undefined, parallelRetryConfig);

    // Set up winner
    vi.mocked(sessionManager.get).mockImplementation(async (id: SessionId) => {
      if (id === "race-session-1") {
        return makeSession(id, { pr: makePR(id) });
      }
      return makeSession(id);
    });
    vi.mocked(mockSCM.getCISummary).mockResolvedValue("passing" as CIStatus);

    await monitor.checkRace(race.id);
    const result = await monitor.resolveRace(race.id);

    expect(result.winner.sessionId).toBe("race-session-1");
    expect(result.losers).toHaveLength(2);
    expect(sessionManager.kill).toHaveBeenCalledTimes(2);
  });

  // 7. resolveRace returns winner session info
  it("resolveRace returns winner and losers", async () => {
    const race = await monitor.startRace("parent-1", "test-project", undefined, parallelRetryConfig);

    vi.mocked(sessionManager.get).mockImplementation(async (id: SessionId) => {
      if (id === "race-session-3") {
        return makeSession(id, { pr: makePR(id) });
      }
      return makeSession(id);
    });
    vi.mocked(mockSCM.getCISummary).mockResolvedValue("passing" as CIStatus);

    await monitor.checkRace(race.id);
    const result = await monitor.resolveRace(race.id);

    expect(result.winner.strategy).toBe("fix-tests");
    expect(result.losers.map((l) => l.strategy)).toEqual(["fix-lint", "fix-types"]);
  });

  // 8. getRaceStatus returns current race state
  it("getRaceStatus returns race group or undefined", async () => {
    expect(monitor.getRaceStatus("nonexistent")).toBeUndefined();

    const race = await monitor.startRace("parent-1", "test-project", undefined, parallelRetryConfig);
    const status = monitor.getRaceStatus(race.id);

    expect(status).toBeDefined();
    expect(status?.id).toBe(race.id);
    expect(status?.status).toBe("running");
  });

  // 9. listActiveRaces returns only "running" races
  it("listActiveRaces returns only running races", async () => {
    const race1 = await monitor.startRace("parent-1", "test-project", undefined, parallelRetryConfig);
    await monitor.startRace("parent-2", "test-project", undefined, parallelRetryConfig);

    // Make race1 won
    vi.mocked(sessionManager.get).mockImplementation(async (id: SessionId) => {
      if (id === "race-session-1") {
        return makeSession(id, { pr: makePR(id) });
      }
      return makeSession(id);
    });
    vi.mocked(mockSCM.getCISummary).mockResolvedValue("passing" as CIStatus);
    await monitor.checkRace(race1.id);

    const active = monitor.listActiveRaces();

    expect(active).toHaveLength(1);
    expect(active[0].parentSessionId).toBe("parent-2");
  });

  // 10. killOnSuccess: false keeps losers alive
  it("resolveRace with killOnSuccess false keeps losers alive", async () => {
    const noKillConfig = { maxParallel: 3, strategies, killOnSuccess: false };
    const race = await monitor.startRace("parent-1", "test-project", undefined, noKillConfig);

    vi.mocked(sessionManager.get).mockImplementation(async (id: SessionId) => {
      if (id === "race-session-1") {
        return makeSession(id, { pr: makePR(id) });
      }
      return makeSession(id);
    });
    vi.mocked(mockSCM.getCISummary).mockResolvedValue("passing" as CIStatus);

    await monitor.checkRace(race.id);
    const result = await monitor.resolveRace(race.id);

    expect(result.winner.sessionId).toBe("race-session-1");
    expect(result.losers).toHaveLength(2);
    expect(sessionManager.kill).not.toHaveBeenCalled();
  });

  // resolveRace throws if race is not won
  it("resolveRace throws if race is not won", async () => {
    const race = await monitor.startRace("parent-1", "test-project", undefined, parallelRetryConfig);

    await expect(monitor.resolveRace(race.id)).rejects.toThrow();
  });

  // --- New tests for CR review fixes ---

  // 11. startRace passes strategy as agent field, not prompt
  it("startRace passes strategy as agent field, not prompt", async () => {
    await monitor.startRace("parent-1", "test-project", undefined, parallelRetryConfig);

    const firstCall = vi.mocked(sessionManager.spawn).mock.calls[0][0];
    expect(firstCall.agent).toBe("fix-lint");
    expect(firstCall.prompt).toBeUndefined();
  });

  // 12. checkRace returns immediately for already-won race without re-polling
  it("checkRace returns immediately for already-won race", async () => {
    const race = await monitor.startRace("parent-1", "test-project", undefined, parallelRetryConfig);

    vi.mocked(sessionManager.get).mockImplementation(async (id: SessionId) => {
      if (id === "race-session-1") {
        return makeSession(id, { pr: makePR(id) });
      }
      return makeSession(id);
    });
    vi.mocked(mockSCM.getCISummary).mockResolvedValue("passing" as CIStatus);

    // First check sets it to "won"
    await monitor.checkRace(race.id);
    expect(race.status).toBe("won");

    // Reset call counts
    vi.mocked(sessionManager.get).mockClear();
    vi.mocked(mockSCM.getCISummary).mockClear();

    // Second check should not re-poll
    const result = await monitor.checkRace(race.id);
    expect(result.status).toBe("won");
    expect(sessionManager.get).not.toHaveBeenCalled();
    expect(mockSCM.getCISummary).not.toHaveBeenCalled();
  });

  // 13. checkRace returns immediately for already-failed race
  it("checkRace returns immediately for already-failed race", async () => {
    const race = await monitor.startRace("parent-1", "test-project", undefined, parallelRetryConfig);

    vi.mocked(sessionManager.get).mockImplementation(async (id: SessionId) =>
      makeSession(id, { pr: makePR(id), status: "errored", activity: "exited" }),
    );
    vi.mocked(mockSCM.getCISummary).mockResolvedValue("failing" as CIStatus);

    await monitor.checkRace(race.id);
    expect(race.status).toBe("failed");

    vi.mocked(sessionManager.get).mockClear();
    vi.mocked(mockSCM.getCISummary).mockClear();

    const result = await monitor.checkRace(race.id);
    expect(result.status).toBe("failed");
    expect(sessionManager.get).not.toHaveBeenCalled();
  });

  // 14. startRace rolls back spawned sessions on spawn failure
  it("startRace rolls back spawned sessions on spawn failure", async () => {
    let spawnCount = 0;
    vi.mocked(sessionManager.spawn).mockImplementation(async () => {
      spawnCount++;
      if (spawnCount === 2) {
        throw new Error("spawn failed");
      }
      return makeSession(`race-session-${spawnCount}`);
    });

    await expect(
      monitor.startRace("parent-1", "test-project", undefined, parallelRetryConfig),
    ).rejects.toThrow("spawn failed");

    // The first session should have been killed as rollback
    expect(sessionManager.kill).toHaveBeenCalledWith("race-session-1");
    // Race should not be registered
    expect(monitor.listActiveRaces()).toHaveLength(0);
  });

  // 15. checkRace throws when SCM plugin is not found
  it("checkRace throws when SCM plugin is not found", async () => {
    // Override registry.get to return undefined (no SCM plugin)
    vi.mocked(registry.get).mockReturnValue(undefined);

    const race = await monitor.startRace("parent-1", "test-project", undefined, parallelRetryConfig);

    await expect(monitor.checkRace(race.id)).rejects.toThrow(
      /SCM plugin "github" not found/,
    );
  });

  // 16. Serialize checkRace — concurrent calls skip re-polling
  it("checkRace serializes concurrent calls for the same race", async () => {
    const race = await monitor.startRace("parent-1", "test-project", undefined, parallelRetryConfig);

    // Make sessionManager.get slow to create a window for concurrency
    let getCallCount = 0;
    vi.mocked(sessionManager.get).mockImplementation(async (id: SessionId) => {
      getCallCount++;
      // Simulate async delay
      await new Promise((resolve) => setTimeout(resolve, 50));
      return makeSession(id, { pr: makePR(id) });
    });
    vi.mocked(mockSCM.getCISummary).mockResolvedValue("pending" as CIStatus);

    // Fire two concurrent checks
    const [result1, result2] = await Promise.all([
      monitor.checkRace(race.id),
      monitor.checkRace(race.id),
    ]);

    expect(result1.status).toBe("running");
    expect(result2.status).toBe("running");
    // Only one check should have actually polled sessions (3 sessions)
    // The other should have returned the snapshot immediately
    expect(getCallCount).toBe(3);
  });

  // 17. resolveRace transitions status to "resolved" preventing double-kill
  it("resolveRace marks race as resolved, preventing repeated calls", async () => {
    const race = await monitor.startRace("parent-1", "test-project", undefined, parallelRetryConfig);

    vi.mocked(sessionManager.get).mockImplementation(async (id: SessionId) => {
      if (id === "race-session-1") {
        return makeSession(id, { pr: makePR(id) });
      }
      return makeSession(id);
    });
    vi.mocked(mockSCM.getCISummary).mockResolvedValue("passing" as CIStatus);

    await monitor.checkRace(race.id);
    await monitor.resolveRace(race.id);

    expect(race.status).toBe("resolved");

    // Second resolveRace should throw because status is no longer "won"
    await expect(monitor.resolveRace(race.id)).rejects.toThrow(
      /not won/,
    );
  });

  // 18. Terminal sessions with pending CI are treated as failed
  it("checkRace treats terminal sessions with pending CI as failed", async () => {
    const race = await monitor.startRace("parent-1", "test-project", undefined, parallelRetryConfig);

    vi.mocked(sessionManager.get).mockImplementation(async (id: SessionId) =>
      makeSession(id, { pr: makePR(id), status: "errored", activity: "exited" }),
    );
    // CI is still "pending" but sessions are terminal — race should still fail
    vi.mocked(mockSCM.getCISummary).mockResolvedValue("pending" as CIStatus);

    const updated = await monitor.checkRace(race.id);

    expect(updated.status).toBe("failed");
  });

  // 19. resolveRace uses allSettled — one kill failure doesn't block others
  it("resolveRace continues killing losers even if one kill fails", async () => {
    const race = await monitor.startRace("parent-1", "test-project", undefined, parallelRetryConfig);

    vi.mocked(sessionManager.get).mockImplementation(async (id: SessionId) => {
      if (id === "race-session-1") {
        return makeSession(id, { pr: makePR(id) });
      }
      return makeSession(id);
    });
    vi.mocked(mockSCM.getCISummary).mockResolvedValue("passing" as CIStatus);

    await monitor.checkRace(race.id);

    // Make the first kill fail, second should still be attempted
    vi.mocked(sessionManager.kill).mockImplementation(async (id: SessionId) => {
      if (id === "race-session-2") {
        throw new Error("kill failed");
      }
    });

    // Should NOT throw even though one kill failed
    const result = await monitor.resolveRace(race.id);

    expect(result.winner.sessionId).toBe("race-session-1");
    expect(result.losers).toHaveLength(2);
    // Both kills should have been attempted
    expect(sessionManager.kill).toHaveBeenCalledTimes(2);
  });
});
