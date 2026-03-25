/**
 * Edge-case tests for reapStaleSessions: cap enforcement, dryRun, error
 * handling, idleThresholdMs gating, and zombie detection.
 *
 * Core kill/skip behavior tests are in session-reaper.test.ts.
 * Metadata hydration tests are in session-reaper-metadata.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { reapStaleSessions } from "../session-reaper.js";
import { sessionFromMetadata } from "../utils/session-from-metadata.js";
import {
  BASE_NOW,
  FOUR_HOURS_MS,
  makeSession,
  makeSessionManager,
  makeConfig,
  makeDeps,
} from "./session-reaper-test-helpers.js";

describe("reapStaleSessions edge cases", () => {
  it("9. maxKillsPerRun cap respected (6 candidates, max 5 → only 5 killed)", async () => {
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
    vi.mocked(sm.kill)
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
    vi.mocked(sm.kill)
      .mockRejectedValueOnce(new Error("kill failed"))
      .mockResolvedValueOnce(undefined);

    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].sessionId).toBe("s1");
    expect(result.errors[0].error).toContain("kill failed");
    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].sessionId).toBe("s2");
  });

  it("13. idleThresholdMs gates no-PR reaping: old-but-active session is NOT killed", async () => {
    const sessions = [
      makeSession("s1", {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
        lastActivityAt: new Date(BASE_NOW.getTime() - 60_000),
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
    const sessions = [
      makeSession("s1", {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
        lastActivityAt: new Date(BASE_NOW.getTime() - 10 * 60_000),
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
    const sessions = [
      makeSession("s1", {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
        lastActivityAt: new Date(BASE_NOW.getTime() - 60_000),
      }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(
      makeConfig({ noPrThresholdMs: FOUR_HOURS_MS }),
      makeDeps(sm),
    );

    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].sessionId).toBe("s1");
    expect(sm.kill).toHaveBeenCalledWith("s1");
  });
});

describe("zombie detection via pr.state (bd-s4t)", () => {
  it("kills session with merged pr.state (bd-s4t zombie path)", async () => {
    const zombieSession = makeSession("zombie-1", {
      status: "working",
      pr: { number: 42, url: "https://github.com/org/repo/pull/42", title: "", owner: "org", repo: "repo", branch: "feat/test", baseBranch: "main", isDraft: false, state: "merged" },
      metadata: { prState: "merged" },
    });
    const sm = makeSessionManager([zombieSession]);
    const result = await reapStaleSessions(makeConfig({ maxKillsPerRun: 20 }), makeDeps(sm));
    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].sessionId).toBe("zombie-1");
    expect(sm.kill).toHaveBeenCalledWith("zombie-1");
  });

  it("kills session with closed pr.state (bd-s4t zombie path)", async () => {
    const zombieSession = makeSession("zombie-2", {
      status: "working",
      pr: { number: 99, url: "https://github.com/org/repo/pull/99", title: "", owner: "org", repo: "repo", branch: "feat/test", baseBranch: "main", isDraft: false, state: "closed" },
      metadata: { prState: "closed" },
    });
    const sm = makeSessionManager([zombieSession]);
    const result = await reapStaleSessions(makeConfig({ maxKillsPerRun: 20 }), makeDeps(sm));
    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].sessionId).toBe("zombie-2");
    expect(sm.kill).toHaveBeenCalledWith("zombie-2");
  });

  it("skips closed PR session that is not yet idle past orphanedThreshold (bd-s4t idle guard)", async () => {
    // Explicitly verifies the idle-threshold guard: 1 min idle < 5 min threshold → skip
    const recentlyActiveSession = makeSession("closed-active", {
      status: "working",
      pr: { number: 100, url: "https://github.com/org/repo/pull/100", title: "", owner: "org", repo: "repo", branch: "feat/test", baseBranch: "main", isDraft: false, state: "closed" },
      metadata: { prState: "closed" },
      lastActivityAt: new Date(BASE_NOW.getTime() - 60_000), // 1 minute ago
    });
    const sm = makeSessionManager([recentlyActiveSession]);
    const result = await reapStaleSessions(
      makeConfig({ maxKillsPerRun: 20, orphanedThresholdMs: 5 * 60_000 }), // 5 min threshold
      makeDeps(sm),
    );
    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain("may reopen");
    expect(sm.kill).not.toHaveBeenCalled();
  });

  it("kills session reconstructed from metadata with prState=merged (bd-s4t round-trip integration)", async () => {
    // This exercises the full chain: sessionFromMetadata hydrates session.pr.state
    // from metadata prState field, then reapStaleSessions detects zombie state
    const hydratedSession = sessionFromMetadata("zombie-3", {
      project: "test",
      branch: "feat/test",
      status: "working",
      worktree: "/tmp/wt",
      pr: "https://github.com/org/repo/pull/77",
      prState: "merged",
    });
    expect(hydratedSession.pr).not.toBeNull();
    expect(hydratedSession.pr!.state).toBe("merged");

    const sm = makeSessionManager([hydratedSession]);
    const result = await reapStaleSessions(makeConfig({ maxKillsPerRun: 20 }), makeDeps(sm));
    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].sessionId).toBe("zombie-3");
    expect(sm.kill).toHaveBeenCalledWith("zombie-3");
  });
});
