import { describe, it, expect, vi, beforeEach } from "vitest";
import { reapStaleSessions, type ReaperConfig, type ReaperDeps } from "../session-reaper.js";
import { sessionFromMetadata } from "../utils/session-from-metadata.js";
import { VALID_PR_STATES, type Session, type SessionManager, type SessionId, type PRState } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_NOW = new Date("2025-01-01T12:00:00Z");
const TWO_HOURS_MS = 7_200_000;
const FOUR_HOURS_MS = 14_400_000;

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
    createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
    lastActivityAt: new Date(BASE_NOW.getTime() - TWO_HOURS_MS - 1000),
    metadata: {},
    ...overrides,
  };
}

function makeSessionManager(sessions: Session[]): SessionManager {
  const sm: SessionManager = {
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    restore: vi.fn(),
    list: vi.fn().mockResolvedValue(sessions),
    get: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
    send: vi.fn(),
    claimPR: vi.fn(),
  };
  return sm;
}

function makeConfig(overrides?: Partial<ReaperConfig>): ReaperConfig {
  return {
    orphanedThresholdMs: TWO_HOURS_MS,
    noPrThresholdMs: FOUR_HOURS_MS,
    maxKillsPerRun: 5,
    ...overrides,
  };
}

function makeDeps(sm: SessionManager): ReaperDeps {
  return {
    sessionManager: sm,
    now: BASE_NOW,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reapStaleSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. empty session list → empty result", async () => {
    const sm = makeSessionManager([]);
    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.dryRun).toBe(false);
  });

  it("2. all sessions in terminal state → all skipped", async () => {
    const sessions = [
      makeSession("s1", { status: "killed" }),
      makeSession("s2", { status: "done" }),
      makeSession("s3", { status: "merged" }),
      makeSession("s4", { status: "terminated" }),
      makeSession("s5", { status: "errored" }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toHaveLength(5);
    expect(sm.kill).not.toHaveBeenCalled();
  });

  it("3. session with no PR past noPrThreshold → killed", async () => {
    const sessions = [
      makeSession("s1", {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].sessionId).toBe("s1");
    expect(result.killed[0].reason).toContain("no PR");
    expect(sm.kill).toHaveBeenCalledWith("s1");
  });

  it("4. session with no PR under noPrThreshold → skipped", async () => {
    const sessions = [
      makeSession("s1", {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS + 60_000), // under threshold
      }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(sm.kill).not.toHaveBeenCalled();
  });

  it("5. orphaned session (exited activity) past orphanedThreshold → killed", async () => {
    const sessions = [
      makeSession("s1", {
        status: "working",
        activity: "exited",
        pr: { number: 1, url: "https://github.com/test/repo/pull/1", title: "PR", owner: "test", repo: "repo", branch: "branch-s1", baseBranch: "main", isDraft: false },
        createdAt: new Date(BASE_NOW.getTime() - TWO_HOURS_MS - 1000),
        lastActivityAt: new Date(BASE_NOW.getTime() - TWO_HOURS_MS - 1000),
      }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].sessionId).toBe("s1");
    expect(result.killed[0].reason).toContain("orphaned");
    expect(sm.kill).toHaveBeenCalledWith("s1");
  });

  it("6. idle session past orphanedThreshold → killed", async () => {
    const sessions = [
      makeSession("s1", {
        status: "idle",
        activity: "idle",
        pr: { number: 1, url: "https://github.com/test/repo/pull/1", title: "PR", owner: "test", repo: "repo", branch: "branch-s1", baseBranch: "main", isDraft: false },
        lastActivityAt: new Date(BASE_NOW.getTime() - TWO_HOURS_MS - 1000),
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].sessionId).toBe("s1");
    expect(result.killed[0].reason).toContain("stale idle");
  });

  it("7. active session → skipped", async () => {
    const sessions = [
      makeSession("s1", {
        status: "working",
        activity: "active",
        pr: { number: 1, url: "https://github.com/test/repo/pull/1", title: "PR", owner: "test", repo: "repo", branch: "branch-s1", baseBranch: "main", isDraft: false },
        lastActivityAt: new Date(BASE_NOW.getTime() - 60_000), // 1 min ago
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(sm.kill).not.toHaveBeenCalled();
  });

  it("8. session with PR → not killed for no-PR reason", async () => {
    const sessions = [
      makeSession("s1", {
        status: "working",
        activity: "active",
        pr: { number: 1, url: "https://github.com/test/repo/pull/1", title: "PR", owner: "test", repo: "repo", branch: "branch-s1", baseBranch: "main", isDraft: false },
        lastActivityAt: new Date(BASE_NOW.getTime() - 60_000),
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    const noPrKill = result.killed.find(k => k.reason.includes("no PR"));
    expect(noPrKill).toBeUndefined();
  });

  // bd-s4t tests: merged/closed PR state → zombie kill via explicit reaper safety net
  it("session with merged PR state but non-terminal status → killed as zombie (bd-s4t)", async () => {
    const sessions = [
      makeSession("s1", {
        status: "working", // non-terminal; lifecycle-manager missed the transition
        activity: "active",
        // session.pr.state reflects GitHub PR state (separate from AO session status)
        pr: {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          title: "PR",
          owner: "test",
          repo: "repo",
          branch: "branch-s1",
          baseBranch: "main",
          isDraft: false,
          state: "merged", // GitHub PR is merged; AO status is stale
        },
        lastActivityAt: new Date(BASE_NOW.getTime() - 60_000),
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].sessionId).toBe("s1");
    expect(result.killed[0].reason).toContain("zombie");
    expect(result.killed[0].reason).toContain("merged");
    expect(sm.kill).toHaveBeenCalledWith("s1");
  });

  it("session with closed PR state but non-terminal status → killed as zombie (bd-s4t)", async () => {
    const sessions = [
      makeSession("s1", {
        status: "working", // non-terminal; lifecycle-manager missed the transition
        activity: "active",
        pr: {
          number: 2,
          url: "https://github.com/test/repo/pull/2",
          title: "WIP PR",
          owner: "test",
          repo: "repo",
          branch: "branch-s1",
          baseBranch: "main",
          isDraft: false,
          state: "closed", // GitHub PR was closed without merge
        },
        lastActivityAt: new Date(BASE_NOW.getTime() - 60_000),
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].sessionId).toBe("s1");
    expect(result.killed[0].reason).toContain("zombie");
    expect(result.killed[0].reason).toContain("closed");
    expect(sm.kill).toHaveBeenCalledWith("s1");
  });

  it("kill count observability: result reflects exact kills and skips per cycle (bd-s4t)", async () => {
    // 3 candidates: 2 merge-zombies + 1 orphaned — verify count fields are accurate
    const sessions = [
      makeSession("s1", {
        status: "working",
        activity: "active",
        pr: { number: 1, url: "https://github.com/test/repo/pull/1", title: "PR", owner: "test", repo: "repo", branch: "branch-s1", baseBranch: "main", isDraft: false, state: "merged" as const },
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
        lastActivityAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
      makeSession("s2", {
        status: "working",
        activity: "active",
        pr: { number: 2, url: "https://github.com/test/repo/pull/2", title: "PR2", owner: "test", repo: "repo", branch: "branch-s2", baseBranch: "main", isDraft: false, state: "closed" as const },
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
        lastActivityAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
      makeSession("s3", {
        status: "working",
        activity: "active",
        pr: null, // no PR → qualifies for no-PR reaping path
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
        lastActivityAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    // All 3 should be killed (2 zombies + 1 orphaned)
    expect(result.killed).toHaveLength(3);
    expect(sm.kill).toHaveBeenCalledTimes(3);

    // Reasons cover all three paths
    const reasons = result.killed.map(k => k.reason);
    expect(reasons.some(r => r.includes("zombie") && r.includes("merged"))).toBe(true);
    expect(reasons.some(r => r.includes("zombie") && r.includes("closed"))).toBe(true);
    expect(reasons.some(r => r.includes("no PR"))).toBe(true);

    // Observability: skipped and errors should be accurate
    expect(result.errors).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.dryRun).toBe(false);
  });

  it("9. maxKillsPerRun cap respected (6 candidates, max 5 → only 5 killed)", async () => {
    // 6 sessions all past noPrThreshold with no PR
    const sessions = Array.from({ length: 6 }, (_, i) =>
      makeSession(`s${i + 1}`, {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
    );
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(makeConfig({ maxKillsPerRun: 5 }), makeDeps(sm));

    expect(result.killed).toHaveLength(5);
    expect(sm.kill).toHaveBeenCalledTimes(5);
    // The 6th session should be in skipped with a cap reason
    expect(result.skipped.some(s => s.reason.includes("cap"))).toBe(true);
  });

  it("10. dryRun mode → no kills, sessions listed as would-kill", async () => {
    const sessions = [
      makeSession("s1", {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(makeConfig({ dryRun: true }), makeDeps(sm));

    expect(result.dryRun).toBe(true);
    expect(result.killed).toHaveLength(1);
    expect(sm.kill).not.toHaveBeenCalled();
  });

  it("11. failed kills count toward cap (maxKillsPerRun=1, first fails → second skipped)", async () => {
    const sessions = [
      makeSession("s1", {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
      makeSession("s2", {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
    ];
    const sm = makeSessionManager(sessions);
    (sm.kill as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("kill failed"));

    const result = await reapStaleSessions(makeConfig({ maxKillsPerRun: 1 }), makeDeps(sm));

    expect(result.errors).toHaveLength(1);
    expect(result.killed).toHaveLength(0);
    expect(result.skipped.some(s => s.reason.includes("cap"))).toBe(true);
    expect(sm.kill).toHaveBeenCalledTimes(1);
  });

  it("12. kill failure → captured in errors, continues to next", async () => {
    const sessions = [
      makeSession("s1", {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
      makeSession("s2", {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
    ];
    const sm = makeSessionManager(sessions);
    (sm.kill as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("kill failed"))
      .mockResolvedValueOnce(undefined);

    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].sessionId).toBe("s1");
    expect(result.errors[0].error).toContain("kill failed");
    // s2 should still be killed
    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].sessionId).toBe("s2");
  });

  it("13. idleThresholdMs gates no-PR reaping: old-but-active session is NOT killed", async () => {
    // Session is 5h old (past 4h noPrThreshold) but was active 1 min ago.
    // With idleThresholdMs=5min, it should NOT be reaped.
    const sessions = [
      makeSession("s1", {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
        lastActivityAt: new Date(BASE_NOW.getTime() - 60_000), // 1 min ago — still active
      }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(
      makeConfig({ noPrThresholdMs: FOUR_HOURS_MS, idleThresholdMs: 5 * 60_000 }),
      makeDeps(sm),
    );

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(sm.kill).not.toHaveBeenCalled();
  });

  it("14. idleThresholdMs gates no-PR reaping: old-and-idle session IS killed", async () => {
    // Session is 5h old AND has been idle for 10 min — past both thresholds.
    const sessions = [
      makeSession("s1", {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
        lastActivityAt: new Date(BASE_NOW.getTime() - 10 * 60_000), // 10 min ago
      }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(
      makeConfig({ noPrThresholdMs: FOUR_HOURS_MS, idleThresholdMs: 5 * 60_000 }),
      makeDeps(sm),
    );

    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].sessionId).toBe("s1");
    expect(sm.kill).toHaveBeenCalledWith("s1");
  });

  it("15. idleThresholdMs=undefined preserves backward-compatible age-only behavior", async () => {
    // Without idleThresholdMs, a 5h-old session (even if recently active) is killed.
    const sessions = [
      makeSession("s1", {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
        lastActivityAt: new Date(BASE_NOW.getTime() - 60_000), // 1 min ago
      }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(
      makeConfig({ noPrThresholdMs: FOUR_HOURS_MS }),
      makeDeps(sm),
    );

    // Without idleThresholdMs, the age gate is the only condition
    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].sessionId).toBe("s1");
    expect(sm.kill).toHaveBeenCalledWith("s1");
  });
});

// ---------------------------------------------------------------------------
// Metadata round-trip tests (bd-s4t)
// ---------------------------------------------------------------------------

describe("sessionFromMetadata: prState round-trip", () => {
  it("hydrates session.pr.state from metadata prState=open", () => {
    const session = sessionFromMetadata("test-1", {
      project: "test-project",
      branch: "feat/test",
      status: "working",
      worktree: "/tmp/test-1",
      pr: "https://github.com/org/repo/pull/42",
      prState: "open",
    });
    expect(session.pr).not.toBeNull();
    expect(session.pr!.state).toBe("open");
    expect(session.metadata["prState"]).toBe("open");
  });

  it("hydrates session.pr.state from metadata prState=merged", () => {
    const session = sessionFromMetadata("test-2", {
      project: "test-project",
      branch: "feat/test",
      status: "working",
      worktree: "/tmp/test-2",
      pr: "https://github.com/org/repo/pull/99",
      prState: "merged",
    });
    expect(session.pr).not.toBeNull();
    expect(session.pr!.state).toBe("merged");
    expect(session.metadata["prState"]).toBe("merged");
  });

  it("hydrates session.pr.state from metadata prState=closed", () => {
    const session = sessionFromMetadata("test-3", {
      project: "test-project",
      branch: "feat/test",
      status: "working",
      worktree: "/tmp/test-3",
      pr: "https://github.com/org/repo/pull/17",
      prState: "closed",
    });
    expect(session.pr).not.toBeNull();
    expect(session.pr!.state).toBe("closed");
  });

  it("rejects invalid prState values (session.pr.state remains undefined)", () => {
    const session = sessionFromMetadata("test-4", {
      project: "test-project",
      status: "working",
      pr: "https://github.com/org/repo/pull/1",
      prState: "invalid-state",
    });
    expect(session.pr).not.toBeNull();
    expect(session.pr!.state).toBeUndefined();
    expect(session.metadata["prState"]).toBe("invalid-state");
  });

  it("VALID_PR_STATES correctly identifies valid and invalid values", () => {
    const valid: PRState[] = ["open", "merged", "closed"];
    const invalid = ["pending", "draft", "APPROVED", "CHANGES_REQUESTED", ""];
    for (const v of valid) {
      expect(VALID_PR_STATES.has(v)).toBe(true);
    }
    for (const v of invalid) {
      expect(VALID_PR_STATES.has(v as PRState)).toBe(false);
    }
  });

  it("no prState in metadata → session.pr.state is undefined", () => {
    const session = sessionFromMetadata("test-5", {
      project: "test-project",
      status: "working",
      worktree: "/tmp/test-5",
      pr: "https://github.com/org/repo/pull/5",
    });
    expect(session.pr).not.toBeNull();
    expect(session.pr!.state).toBeUndefined();
  });

  it("zombie detection: merged prState in metadata triggers zombie kill path", async () => {
    // This is the bd-s4t zombie detection: session with merged PR state but
    // non-terminal status should be killed by the reaper
    const zombieSession = makeSession("zombie-1", {
      status: "working", // non-terminal
      pr: { number: 42, url: "https://github.com/org/repo/pull/42", title: "", owner: "org", repo: "repo", branch: "feat/test", baseBranch: "main", isDraft: false, state: "merged" },
      metadata: { prState: "merged" },
    });
    const sm = makeSessionManager([zombieSession]);
    const result = await reapStaleSessions(makeConfig({ maxKillsPerRun: 20 }), makeDeps(sm));
    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].sessionId).toBe("zombie-1");
    expect(sm.kill).toHaveBeenCalledWith("zombie-1");
  });
});
