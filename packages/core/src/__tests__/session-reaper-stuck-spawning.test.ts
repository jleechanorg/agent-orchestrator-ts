/**
 * RED (jleechanorg/agent-orchestrator-mirror#12): sessions that fail during
 * spawn initialization (tmux pane creation, agent CLI startup, etc.) can get
 * stuck at status="spawning", activity="active" forever. None of
 * reapStaleSessions' three existing killReason branches match that state:
 *   - activity === "exited"  -> no, it's "active"
 *   - activity === "idle"    -> no, it's "active"
 *   - pr === null && age > noPrThresholdMs (24h in the daemon's override)
 *       -> too coarse/slow, and only an incidental catch, not a dedicated
 *          spawn-timeout check
 * Confirmed live on jeff-ubuntu 2026-07-10: 18 sessions stuck in [spawning]
 * for 18h-2d, permanently occupying spawn-queue capacity and causing
 * `transient_spawn_retry_cap_exceeded` / PARKED_HUMAN_HELD failures
 * elsewhere (dark-factory daemon log: "Spawn queue is full for project
 * 'worldarchitect' (100 pending requests)").
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { reapStaleSessions } from "../session-reaper.js";
import {
  BASE_NOW,
  makeSession,
  makeSessionManager,
  makeConfig,
  makeDeps,
} from "./session-reaper-test-helpers.js";

const FIFTEEN_MIN_MS = 900_000;
const TWENTY_MIN_MS = 1_200_000;
const TEN_MIN_MS = 600_000;

describe("reapStaleSessions — stuck spawning sessions (#12)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT currently reap a session stuck in spawning past a reasonable timeout (RED)", async () => {
    // A session that has been in status="spawning", activity="active" for
    // 20 minutes — well past any reasonable spawn-init window — with no PR
    // yet (spawn never completed) and well under the 24h no-PR fallback.
    const stuck = makeSession("stuck-1", {
      status: "spawning",
      activity: "active",
      pr: null,
      createdAt: new Date(BASE_NOW.getTime() - TWENTY_MIN_MS),
      lastActivityAt: new Date(BASE_NOW.getTime() - TWENTY_MIN_MS),
    });

    const sm = makeSessionManager([stuck]);
    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    // This is the bug: today, nothing reaps it — it falls through to
    // "no reap condition met" and stays stuck indefinitely, occupying a
    // spawn-queue slot. Once the fix lands (a dedicated spawnTimeoutMs
    // check), this session SHOULD be killed instead; this assertion
    // documents the current (broken) behavior and must be updated in the
    // same commit as the fix.
    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ sessionId: "stuck-1", reason: "no reap condition met" }),
    );
  });

  it("reaps a session stuck in spawning past spawnTimeoutMs once configured (GREEN)", async () => {
    const stuck = makeSession("stuck-2", {
      status: "spawning",
      activity: "active",
      pr: null,
      createdAt: new Date(BASE_NOW.getTime() - TWENTY_MIN_MS),
      lastActivityAt: new Date(BASE_NOW.getTime() - TWENTY_MIN_MS),
    });

    const sm = makeSessionManager([stuck]);
    const result = await reapStaleSessions(
      makeConfig({ spawnTimeoutMs: FIFTEEN_MIN_MS }),
      makeDeps(sm),
    );

    expect(result.killed).toContainEqual(
      expect.objectContaining({ sessionId: "stuck-2", reason: "stuck in spawning past timeout" }),
    );
    expect(sm.kill).toHaveBeenCalledWith("stuck-2");
  });

  it("does not reap a session still within the spawn timeout window", async () => {
    const fresh = makeSession("fresh-1", {
      status: "spawning",
      activity: "active",
      pr: null,
      createdAt: new Date(BASE_NOW.getTime() - TEN_MIN_MS),
      lastActivityAt: new Date(BASE_NOW.getTime() - TEN_MIN_MS),
    });

    const sm = makeSessionManager([fresh]);
    const result = await reapStaleSessions(
      makeConfig({ spawnTimeoutMs: FIFTEEN_MIN_MS }),
      makeDeps(sm),
    );

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ sessionId: "fresh-1" }),
    );
  });

  it("does not reap a non-spawning session even past spawnTimeoutMs (scope guard)", async () => {
    const working = makeSession("working-1", {
      status: "working",
      activity: "active",
      pr: null,
      createdAt: new Date(BASE_NOW.getTime() - TWENTY_MIN_MS),
      lastActivityAt: new Date(BASE_NOW.getTime() - TWENTY_MIN_MS),
    });

    const sm = makeSessionManager([working]);
    const result = await reapStaleSessions(
      makeConfig({ spawnTimeoutMs: FIFTEEN_MIN_MS }),
      makeDeps(sm),
    );

    expect(result.killed).toHaveLength(0);
  });

  it("is disabled by default (spawnTimeoutMs undefined) — backward compatible", async () => {
    const stuck = makeSession("stuck-3", {
      status: "spawning",
      activity: "active",
      pr: null,
      createdAt: new Date(BASE_NOW.getTime() - TWENTY_MIN_MS),
      lastActivityAt: new Date(BASE_NOW.getTime() - TWENTY_MIN_MS),
    });

    const sm = makeSessionManager([stuck]);
    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    expect(result.killed).toHaveLength(0);
  });
});
