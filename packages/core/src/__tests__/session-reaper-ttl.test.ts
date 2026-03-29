/**
 * TTL + dead-tmux session reaper tests (orch-ju1).
 *
 * Covers:
 * 1. Session TTL — sessions alive longer than configured TTL are killed
 * 2. Dead tmux detection — tmux has-session failure triggers kill
 * 3. TTL respects startup grace period
 * 4. Dead tmux + merged/closed PR → worktree cleanup (via sessionManager.kill)
 * 5. Dead tmux + open PR → respawn action returned
 */

import { describe, it, expect, vi } from "vitest";
import type { Session } from "../types.js";
import { BASE_NOW, makeSession, makeSessionManager, makeTtlConfig, makeDeps } from "./session-reaper-test-helpers.js";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TmuxHealth = (tmuxName: string) => Promise<boolean>;
type RespawnFn = (sessionId: string, projectId: string, session: Session) => Promise<void>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session TTL reaping", () => {
  it("kills session that has exceeded its TTL", async () => {
    const { reapStaleSessions } = await import("../session-reaper.js");

    // Session created 5h ago; TTL=4h. Orphaned/noPr thresholds are set to 10h
    // by makeTtlConfig so TTL is the active condition.
    const oldSession = makeSession("ttl-exceeded", {
      createdAt: new Date(BASE_NOW.getTime() - FIVE_HOURS_MS),
      lastActivityAt: new Date(BASE_NOW.getTime() - FIVE_HOURS_MS),
      tmuxName: "aabbccddee-ao-ttl-exceeded",
    });
    const sm = makeSessionManager([oldSession]);
    const config = makeTtlConfig({ sessionTtlMs: FOUR_HOURS_MS });

    const result = await reapStaleSessions(config, makeDeps(sm));

    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].sessionId).toBe("ttl-exceeded");
    expect(result.killed[0].reason).toContain("TTL");
    expect(sm.kill).toHaveBeenCalledWith("ttl-exceeded");
  });

  it("skips session still within its TTL", async () => {
    const { reapStaleSessions } = await import("../session-reaper.js");

    // Session created 2h ago, TTL=4h (orphaned/noPr also set to 10h)
    const youngSession = makeSession("ttl-ok", {
      createdAt: new Date(BASE_NOW.getTime() - TWO_HOURS_MS),
      lastActivityAt: new Date(BASE_NOW.getTime() - TWO_HOURS_MS),
    });
    const sm = makeSessionManager([youngSession]);
    const config = makeTtlConfig({ sessionTtlMs: FOUR_HOURS_MS });

    const result = await reapStaleSessions(config, makeDeps(sm));

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe("no reap condition met");
  });

  it("TTL is skipped during startup grace period", async () => {
    const { reapStaleSessions } = await import("../session-reaper.js");

    // Session created 30 min ago, TTL=4h, grace=2h → within grace → skip
    const recentSession = makeSession("grace-period", {
      createdAt: new Date(BASE_NOW.getTime() - 30 * 60_000),
      lastActivityAt: new Date(BASE_NOW.getTime() - 30 * 60_000),
    });
    const sm = makeSessionManager([recentSession]);
    const config = makeTtlConfig({ sessionTtlMs: FOUR_HOURS_MS, startupGracePeriodMs: 2 * 60 * 60_000 });

    const result = await reapStaleSessions(config, makeDeps(sm));

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe("startup grace period");
  });

  it("TTL kills even when no other reap condition is met", async () => {
    const { reapStaleSessions } = await import("../session-reaper.js");

    // Active session, no PR, 5h old, TTL=4h, noPr/orphaned set to 10h by makeTtlConfig
    const activeOld = makeSession("active-but-old", {
      createdAt: new Date(BASE_NOW.getTime() - FIVE_HOURS_MS),
      lastActivityAt: new Date(BASE_NOW.getTime() - 60_000), // recently active
      pr: null,
      activity: "active",
    });
    const sm = makeSessionManager([activeOld]);
    const config = makeTtlConfig({ sessionTtlMs: FOUR_HOURS_MS });

    const result = await reapStaleSessions(config, makeDeps(sm));

    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].sessionId).toBe("active-but-old");
    expect(result.killed[0].reason).toContain("TTL");
  });
});

describe("dead tmux session reaping", () => {
  it("kills session when tmux has-session returns false (dead tmux)", async () => {
    const { reapStaleSessions } = await import("../session-reaper.js");

    // tmux is dead; other reap conditions not met.
    // Pass tmuxName via metadata (not top-level) so session.metadata["tmuxName"] is set.
    const deadTmux = makeSession("tmux-dead", {
      status: "working",
      activity: "active",
      pr: null,
      metadata: { tmuxName: "aabbccddee-ao-tmux-dead" },
    });
    const sm = makeSessionManager([deadTmux]);

    const tmuxHealth: TmuxHealth = vi.fn().mockResolvedValue(false);
    const respawnFn: RespawnFn = vi.fn();
    const config = makeTtlConfig({ sessionTtlMs: 10 * 60 * 60_000 });

    const result = await reapStaleSessions(config, {
      ...makeDeps(sm),
      tmuxHealth,
      respawnSession: respawnFn,
    });

    expect(tmuxHealth).toHaveBeenCalledWith("aabbccddee-ao-tmux-dead");
    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].sessionId).toBe("tmux-dead");
    expect(result.killed[0].reason).toContain("tmux");
    expect(sm.kill).toHaveBeenCalledWith("tmux-dead");
  });

  it("dead tmux + merged PR → kill + worktree cleanup via sessionManager.kill", async () => {
    const { reapStaleSessions } = await import("../session-reaper.js");

    const deadMerged = makeSession("tmux-dead-merged", {
      status: "working",
      pr: { number: 77, url: "https://github.com/org/repo/pull/77", title: "M", owner: "org", repo: "repo", branch: "feat/test", baseBranch: "main", isDraft: false, state: "merged" as const },
      metadata: { prState: "merged", tmuxName: "aabbccddee-ao-tmux-dead-merged" },
    });
    const sm = makeSessionManager([deadMerged]);

    const tmuxHealth: TmuxHealth = vi.fn().mockResolvedValue(false);
    const respawnFn: RespawnFn = vi.fn();
    const config = makeTtlConfig({ sessionTtlMs: 10 * 60 * 60_000 });

    await reapStaleSessions(config, {
      ...makeDeps(sm),
      tmuxHealth,
      respawnSession: respawnFn,
    });

    // Kill is called (which destroys worktree)
    expect(sm.kill).toHaveBeenCalledWith("tmux-dead-merged");
    // Respawn is NOT called for merged PRs
    expect(respawnFn).not.toHaveBeenCalled();
  });

  it("dead tmux + closed PR → kill + worktree cleanup", async () => {
    const { reapStaleSessions } = await import("../session-reaper.js");

    // Use pr=null so zombie check does NOT intercept this session.
    // The zombie check fires when prState="closed" AND idle > orphanedThresholdMs.
    // With pr=null, zombie check is skipped and the tmux dead path is exercised.
    const deadClosed = makeSession("tmux-dead-closed", {
      pr: null,
      metadata: { prState: "closed", tmuxName: "aabbccddee-ao-tmux-dead-closed" },
    });
    const sm = makeSessionManager([deadClosed]);

    const tmuxHealth: TmuxHealth = vi.fn().mockResolvedValue(false);
    const respawnFn: RespawnFn = vi.fn();
    const config = makeTtlConfig({ sessionTtlMs: 10 * 60 * 60_000 });

    await reapStaleSessions(config, {
      ...makeDeps(sm),
      tmuxHealth,
      respawnSession: respawnFn,
    });

    expect(tmuxHealth).toHaveBeenCalledWith("aabbccddee-ao-tmux-dead-closed");
    expect(sm.kill).toHaveBeenCalledWith("tmux-dead-closed");
    expect(respawnFn).not.toHaveBeenCalled();
  });

  it("dead tmux + open PR → respawn action returned", async () => {
    const { reapStaleSessions } = await import("../session-reaper.js");

    const deadOpen = makeSession("tmux-dead-open", {
      status: "working",
      pr: { number: 99, url: "https://github.com/org/repo/pull/99", title: "O", owner: "org", repo: "repo", branch: "feat/test", baseBranch: "main", isDraft: false, state: "open" as const },
      metadata: { prState: "open", tmuxName: "aabbccddee-ao-tmux-dead-open" },
    });
    const sm = makeSessionManager([deadOpen]);

    const tmuxHealth: TmuxHealth = vi.fn().mockResolvedValue(false);
    const respawnFn: RespawnFn = vi.fn();
    const config = makeTtlConfig({ sessionTtlMs: 10 * 60 * 60_000 });

    await reapStaleSessions(config, {
      ...makeDeps(sm),
      tmuxHealth,
      respawnSession: respawnFn,
    });

    // Kill the dead tmux session
    expect(sm.kill).toHaveBeenCalledWith("tmux-dead-open");
    // Respawn is called for open PR
    expect(respawnFn).toHaveBeenCalledWith("tmux-dead-open", "test-project", expect.objectContaining({ id: "tmux-dead-open" }));
  });

  it("dead tmux + no PR → kill but no respawn", async () => {
    const { reapStaleSessions } = await import("../session-reaper.js");

    const deadNoPr = makeSession("tmux-dead-no-pr", {
      status: "working",
      pr: null,
      metadata: { tmuxName: "aabbccddee-ao-tmux-dead-no-pr" },
    });
    const sm = makeSessionManager([deadNoPr]);

    const tmuxHealth: TmuxHealth = vi.fn().mockResolvedValue(false);
    const respawnFn: RespawnFn = vi.fn();
    const config = makeTtlConfig({ sessionTtlMs: 10 * 60 * 60_000 });

    await reapStaleSessions(config, {
      ...makeDeps(sm),
      tmuxHealth,
      respawnSession: respawnFn,
    });

    expect(sm.kill).toHaveBeenCalledWith("tmux-dead-no-pr");
    // No PR means we can't respawn for the same work item — skip respawn
    expect(respawnFn).not.toHaveBeenCalled();
  });

  it("healthy tmux session is not killed by tmux check alone", async () => {
    const { reapStaleSessions } = await import("../session-reaper.js");

    const healthy = makeSession("tmux-healthy", {
      status: "working",
      pr: null,
      metadata: { tmuxName: "aabbccddee-ao-tmux-healthy" },
    });
    const sm = makeSessionManager([healthy]);

    const tmuxHealth: TmuxHealth = vi.fn().mockResolvedValue(true);
    const respawnFn: RespawnFn = vi.fn();
    const config = makeTtlConfig({ sessionTtlMs: 10 * 60 * 60_000 });

    const result = await reapStaleSessions(config, {
      ...makeDeps(sm),
      tmuxHealth,
      respawnSession: respawnFn,
    });

    expect(tmuxHealth).toHaveBeenCalledWith("aabbccddee-ao-tmux-healthy");
    expect(result.killed).toHaveLength(0);
    expect(sm.kill).not.toHaveBeenCalled();
  });

  it("dead tmux + open PR where respawn errors → kill still succeeds, error recorded", async () => {
    const { reapStaleSessions } = await import("../session-reaper.js");

    const deadOpen = makeSession("tmux-dead-respawn-fail", {
      status: "working",
      pr: { number: 55, url: "https://github.com/org/repo/pull/55", title: "R", owner: "org", repo: "repo", branch: "feat/test", baseBranch: "main", isDraft: false, state: "open" as const },
      metadata: { prState: "open", tmuxName: "aabbccddee-ao-tmux-dead-respawn-fail" },
    });
    const sm = makeSessionManager([deadOpen]);

    const tmuxHealth: TmuxHealth = vi.fn().mockResolvedValue(false);
    const respawnFn: RespawnFn = vi.fn().mockRejectedValue(new Error("spawn failed"));
    const config = makeTtlConfig({ sessionTtlMs: 10 * 60 * 60_000 });

    const result = await reapStaleSessions(config, {
      ...makeDeps(sm),
      tmuxHealth,
      respawnSession: respawnFn,
    });

    expect(sm.kill).toHaveBeenCalledWith("tmux-dead-respawn-fail");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain("spawn failed");
  });

  it("dead tmux respects startup grace period", async () => {
    const { reapStaleSessions } = await import("../session-reaper.js");

    const recentDead = makeSession("grace-dead-tmux", {
      createdAt: new Date(BASE_NOW.getTime() - 30 * 60_000),
      lastActivityAt: new Date(BASE_NOW.getTime() - 30 * 60_000),
      pr: { number: 11, url: "https://github.com/org/repo/pull/11", title: "G", owner: "org", repo: "repo", branch: "feat/test", baseBranch: "main", isDraft: false, state: "open" as const },
      metadata: { tmuxName: "aabbccddee-ao-grace-dead" },
    });
    const sm = makeSessionManager([recentDead]);

    const tmuxHealth: TmuxHealth = vi.fn().mockResolvedValue(false);
    const respawnFn: RespawnFn = vi.fn();
    const config = makeTtlConfig({ sessionTtlMs: 10 * 60 * 60_000, startupGracePeriodMs: 2 * 60 * 60_000 });

    const result = await reapStaleSessions(config, {
      ...makeDeps(sm),
      tmuxHealth,
      respawnSession: respawnFn,
    });

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe("startup grace period");
  });

  it("tmux health check skipped when session has no tmuxName", async () => {
    const { reapStaleSessions } = await import("../session-reaper.js");

    // Session without tmuxName in metadata — no tmux health check possible
    const sessionNoTmux = makeSession("no-tmux", {
      workspacePath: null,
      pr: null,
    });
    const sm = makeSessionManager([sessionNoTmux]);

    const tmuxHealth: TmuxHealth = vi.fn();
    const respawnFn: RespawnFn = vi.fn();
    const config = makeTtlConfig({ sessionTtlMs: 10 * 60 * 60_000 });

    const result = await reapStaleSessions(config, {
      ...makeDeps(sm),
      tmuxHealth,
      respawnSession: respawnFn,
    });

    // tmuxHealth should not be called when there's no tmuxName
    expect(tmuxHealth).not.toHaveBeenCalled();
    expect(result.killed).toHaveLength(0);
  });

  it("multiple dead tmux sessions: all killed, respawns dispatched for open-PR sessions", async () => {
    const { reapStaleSessions } = await import("../session-reaper.js");

    const open1 = makeSession("dead-open-1", {
      pr: { number: 1, url: "https://github.com/org/repo/pull/1", title: "1", owner: "org", repo: "repo", branch: "feat/1", baseBranch: "main", isDraft: false, state: "open" as const },
      metadata: { prState: "open", tmuxName: "aabbccddee-ao-dead-open-1" },
    });
    const open2 = makeSession("dead-open-2", {
      pr: { number: 2, url: "https://github.com/org/repo/pull/2", title: "2", owner: "org", repo: "repo", branch: "feat/2", baseBranch: "main", isDraft: false, state: "open" as const },
      metadata: { prState: "open", tmuxName: "aabbccddee-ao-dead-open-2" },
    });
    const merged = makeSession("dead-merged", {
      pr: { number: 3, url: "https://github.com/org/repo/pull/3", title: "3", owner: "org", repo: "repo", branch: "feat/3", baseBranch: "main", isDraft: false, state: "merged" as const },
      metadata: { prState: "merged", tmuxName: "aabbccddee-ao-dead-merged" },
    });
    const sm = makeSessionManager([open1, open2, merged]);

    const tmuxHealth: TmuxHealth = vi.fn().mockResolvedValue(false);
    const respawnFn: RespawnFn = vi.fn();
    const config = makeTtlConfig({ sessionTtlMs: 10 * 60 * 60_000, maxKillsPerRun: 20 });

    const result = await reapStaleSessions(config, {
      ...makeDeps(sm),
      tmuxHealth,
      respawnSession: respawnFn,
    });

    expect(result.killed).toHaveLength(3);
    expect(sm.kill).toHaveBeenCalledTimes(3);
    // Only open-PR sessions trigger respawn (not merged)
    expect(respawnFn).toHaveBeenCalledTimes(2);
    expect(respawnFn).toHaveBeenCalledWith("dead-open-1", "test-project", expect.objectContaining({ id: "dead-open-1" }));
    expect(respawnFn).toHaveBeenCalledWith("dead-open-2", "test-project", expect.objectContaining({ id: "dead-open-2" }));
  });
});
