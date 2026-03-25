import { describe, it, expect, vi, beforeEach } from "vitest";
import { reapStaleSessions } from "../session-reaper.js";
import {
  BASE_NOW,
  TWO_HOURS_MS,
  FOUR_HOURS_MS,
  makeSession,
  makeSessionManager,
  makeConfig,
  makeDeps,
} from "./session-reaper-test-helpers.js";
// Edge cases (9-15) and zombie detection are in session-reaper-edge-cases.test.ts
// Metadata hydration tests are in session-reaper-metadata.test.ts

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

});
