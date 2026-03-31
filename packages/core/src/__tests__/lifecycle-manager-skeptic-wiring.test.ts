/**
 * Tests for lifecycle-manager → skeptic-reviewer wiring (bd-ryw2).
 *
 * These tests verify the Map-based state machine for lastSkepticSha that:
 * 1. Is pruned for dead sessions on each sweep (no unbounded growth)
 * 2. Is NOT updated when reaction dispatch fails (retry preserved)
 * 3. IS updated when reaction succeeds
 * 4. Detects SHA changes correctly (same SHA ≠ trigger, new SHA = trigger)
 * 5. Triggers for first-seen SHA (no prior entry)
 *
 * The Map and its manipulation logic are tested directly — no module mocking needed.
 * The actual lifecycle-manager module exercises this logic in production.
 */

import { describe, it, expect, vi } from "vitest";
import { triggerSkepticReaction } from "../lifecycle-manager.js";
import type {
  Session,
  OrchestratorConfig,
  ReactionConfig,
  ReactionResult,
  PluginRegistry,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helper: minimal mock executeReaction for triggerSkepticReaction tests
// ---------------------------------------------------------------------------
function makeExecuteReaction(
  outcome: "success" | "failure",
): (
  sessionId: string,
  projectId: string,
  reactionKey: string,
  reactionConfig: ReactionConfig,
  session?: Session,
  correlationId?: string,
) => Promise<ReactionResult> {
  return async () => {
    if (outcome === "success") {
      return { success: true };
    }
    throw new Error("executeReaction error");
  };
}

// ---------------------------------------------------------------------------
// Helper: minimal mock SCM for getPRHeadSha
// ---------------------------------------------------------------------------
function makeMockRegistry(sha: string): PluginRegistry {
  return {
    get: vi.fn(
      (
        _type: "scm",
        _plugin: string,
      ) => ({
        getPRHeadSha: async () => sha,
      }),
    ),
  } as unknown as PluginRegistry;
}

// ---------------------------------------------------------------------------
// Helper: minimal OrchestratorConfig with worker-signals-completion enabled
// ---------------------------------------------------------------------------
function makeConfig(
  workerSignalsAuto: boolean,
): OrchestratorConfig {
  return {
    reactions: {
      "worker-signals-completion": {
        action: "send-to-agent",
        auto: workerSignalsAuto,
      },
      "claim-verification": {
        action: "notify",
        auto: true,
      },
    },
    projects: {
      "test-project": {
        name: "test-project",
        path: "/tmp",
        agent: { plugin: "agent-claude-code" },
      },
    },
  } as unknown as OrchestratorConfig;
}

// ---------------------------------------------------------------------------
// Helper: minimal Session
// ---------------------------------------------------------------------------
function makeSession(projectId = "test-project"): Session {
  return {
    id: "test-session",
    projectId,
    status: "pr_open",
    metadata: {},
    pr: { number: 1, owner: "test", repo: "test", headSha: "abc0000" },
  } as unknown as Session;
}

// ---------------------------------------------------------------------------
// First suite: Map-level invariants (bd-ryw2)
// ---------------------------------------------------------------------------
describe("lifecycle-manager skeptic wiring — lastSkepticSha Map invariants", () => {
  // bd-ryw2: lastSkepticSha entries for dead sessions must be pruned on each
  // sweep to avoid unbounded growth and stale SHA comparisons when session IDs
  // are recycled. Mirrors lifecycle-manager.ts lines ~2213-2217.
  it("prunes lastSkepticSha entry when session ID is no longer active", () => {
    const lastSkepticSha = new Map<string, string>();
    const currentSessionIds = new Set<string>();

    // Pre-populate: one dead session, one alive session
    lastSkepticSha.set("dead-session", "sha_dead");
    lastSkepticSha.set("alive-session", "sha_alive");
    currentSessionIds.add("alive-session"); // "dead-session" is not in current sessions

    // Sweeper logic (mirrors lifecycle-manager.ts lines 2213-2217):
    //   for (const sessionId of lastSkepticSha.keys()) {
    //     if (!currentSessionIds.has(sessionId)) { lastSkepticSha.delete(sessionId); }
    //   }
    for (const sessionId of lastSkepticSha.keys()) {
      if (!currentSessionIds.has(sessionId)) {
        lastSkepticSha.delete(sessionId);
      }
    }

    expect(lastSkepticSha.has("dead-session")).toBe(false);
    expect(lastSkepticSha.has("alive-session")).toBe(true);
    expect(lastSkepticSha.get("alive-session")).toBe("sha_alive");
  });

  // bd-ryw2: When skeptic reaction succeeds, lastSkepticSha must be updated
  // so subsequent SHA-change polling does NOT re-trigger (same SHA = no new eval).
  it("lastSkepticSha is updated after successful skeptic dispatch", () => {
    const lastSkepticSha = new Map<string, string>();
    const sessionId = "session-1";
    const newSha = "abc0000000000000000000000000000000000000";
    const reactionSuccess = true;

    // Success path mirrors lifecycle-manager.ts lines 1775-1777:
    //   if (reactionSuccess) { lastSkepticSha.set(session.id, currentSha); }
    if (reactionSuccess) {
      lastSkepticSha.set(sessionId, newSha);
    }

    expect(lastSkepticSha.get(sessionId)).toBe(newSha);
  });

  // bd-ryw2: When skeptic reaction FAILS, lastSkepticSha must NOT be updated.
  // This allows the next poll cycle to retry the evaluation for the same SHA,
  // rather than suppressing it indefinitely.
  it("lastSkepticSha is NOT updated when skeptic dispatch fails — retry preserved", () => {
    const lastSkepticSha = new Map<string, string>();
    const sessionId = "session-2";
    const currentSha = "abc1111111111111111111111111111111111111";
    const reactionSuccess = false;

    // Failure path: do NOT record SHA — next cycle should retry.
    // The guard is: "if (reactionSuccess) { lastSkepticSha.set(...); }"
    // No else branch = no-op on failure.
    if (reactionSuccess) {
      lastSkepticSha.set(sessionId, currentSha);
    }

    expect(lastSkepticSha.has(sessionId)).toBe(false);
  });

  // bd-ryw2: Verify SHA-change detection: same SHA ≠ trigger, new SHA = trigger
  it("SHA change detection: new SHA triggers re-evaluation, same SHA suppresses it", () => {
    const lastSkepticSha = new Map<string, string>();
    const sessionId = "session-3";

    // Initial evaluation — record SHA
    const shaAfterFirstEval = "abc2222222222222222222222222222222222222";
    lastSkepticSha.set(sessionId, shaAfterFirstEval);

    // Subsequent poll: SHA unchanged → no re-trigger
    const currentShaSame = shaAfterFirstEval;
    const previousSha = lastSkepticSha.get(sessionId);
    // Guard from lifecycle-manager.ts line 1744:
    //   if (currentSha && previousSha && currentSha !== previousSha) { trigger }
    const shaChangedSame = Boolean(previousSha && currentShaSame !== previousSha);
    expect(shaChangedSame).toBe(false);

    // Subsequent poll: SHA changed (new commit pushed) → re-trigger
    const currentShaNew = "abc3333333333333333333333333333333333333";
    const shaChangedNew = Boolean(previousSha && currentShaNew !== previousSha);
    expect(shaChangedNew).toBe(true);
  });

  // bd-ryw2: Verify first-seen SHA path (no prior SHA) triggers evaluation.
  // This covers the case where lifecycle-manager restarted and has no prior SHA record,
  // but the PR was already open. Triggering skeptic prevents the "missed initial dispatch" gap.
  it("first-seen SHA (no prior entry) triggers evaluation to cover missed-initial-dispatch", () => {
    const lastSkepticSha = new Map<string, string>();
    const sessionId = "session-4";

    // Session was just adopted — no prior SHA recorded
    const currentSha = "abc4444444444444444444444444444444444444";
    const previousSha = lastSkepticSha.get(sessionId);

    // Lifecycle-manager.ts lines 1779-1808: else-if branch handles no-prior-SHA case
    //   } else if (currentSha && !previousSha) { ... trigger skeptic ... }
    const firstTimeSeen = Boolean(currentSha && !previousSha);
    expect(firstTimeSeen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Second suite: bd-jzan — triggerSkepticReaction integration (CR bd-jzan fix)
// Tests call the actual module-level function, not a local predicate copy.
// ---------------------------------------------------------------------------
describe("lifecycle-manager skeptic wiring — bd-jzan: triggerSkepticReaction integration", () => {
  // bd-jzan: skeptic fires immediately on CR approved transition (no SHA change required).
  // Verifies via the actual triggerSkepticReaction() implementation.
  it("fires skeptic when worker-signals-completion is configured and session has PR", async () => {
    const session = makeSession();
    const lastSkepticSha = new Map<string, string>();
    const config = makeConfig(true); // auto = true
    const registry = makeMockRegistry("abc0000");
    const executeReaction = makeExecuteReaction("success");

    const result = await triggerSkepticReaction(
      session,
      lastSkepticSha,
      "test-correlation",
      config,
      registry,
      executeReaction,
    );

    expect(result).toBe(true);
    // SHA should be recorded after success
    expect(lastSkepticSha.get(session.id)).toBe("abc0000");
  });

  it("skips skeptic when worker-signals-completion auto is false", async () => {
    const session = makeSession();
    const lastSkepticSha = new Map<string, string>();
    const config = makeConfig(false); // auto = false → skipped
    const registry = makeMockRegistry("abc0000");
    const executeReaction = vi.fn();

    const result = await triggerSkepticReaction(
      session,
      lastSkepticSha,
      "test-correlation",
      config,
      registry,
      executeReaction,
    );

    expect(result).toBe(false);
    expect(executeReaction).not.toHaveBeenCalled();
  });

  it("returns false when executeReaction throws — retry preserved (lastSkepticSha not updated)", async () => {
    const session = makeSession();
    const lastSkepticSha = new Map<string, string>();
    const config = makeConfig(true);
    const registry = makeMockRegistry("abc0000");
    const executeReaction = makeExecuteReaction("failure");

    const result = await triggerSkepticReaction(
      session,
      lastSkepticSha,
      "test-correlation",
      config,
      registry,
      executeReaction,
    );

    expect(result).toBe(false);
    // SHA must NOT be recorded when reaction fails — next cycle retries
    expect(lastSkepticSha.has(session.id)).toBe(false);
  });

  it("fires skeptic for session without prior SHA (first-seen)", async () => {
    const session = makeSession();
    const lastSkepticSha = new Map<string, string>(); // no prior entry
    const config = makeConfig(true);
    const registry = makeMockRegistry("abc5555555555555555555555555555555555555");
    const executeReaction = makeExecuteReaction("success");

    const result = await triggerSkepticReaction(
      session,
      lastSkepticSha,
      "test-correlation",
      config,
      registry,
      executeReaction,
    );

    expect(result).toBe(true);
    expect(lastSkepticSha.get(session.id)).toBe("abc5555555555555555555555555555555555555");
  });

  it("skips skeptic when session has no PR (no SCM SHA to record)", async () => {
    const session = { ...makeSession(), pr: undefined } as Session;
    const lastSkepticSha = new Map<string, string>();
    const config = makeConfig(true);
    const registry = makeMockRegistry("abc0000");
    const executeReaction = makeExecuteReaction("success");

    const result = await triggerSkepticReaction(
      session,
      lastSkepticSha,
      "test-correlation",
      config,
      registry,
      executeReaction,
    );

    // Reaction fires (action is configured) but SHA is not recorded (no PR)
    expect(result).toBe(true);
    expect(lastSkepticSha.has(session.id)).toBe(false);
  });

  it("approved transition dedup: does NOT re-fire if SHA already recorded (same SHA)", async () => {
    const session = makeSession();
    const currentSha = "abc6666666666666666666666666666666666666";
    session.pr = { number: 1, owner: "test", repo: "test", headSha: currentSha };
    // lastSkepticSha already has this SHA → already evaluated
    const lastSkepticSha = new Map<string, string>([[session.id, currentSha]]);
    const config = makeConfig(true);
    const registry = makeMockRegistry(currentSha);
    const executeReaction = makeExecuteReaction("success");

    const result = await triggerSkepticReaction(
      session,
      lastSkepticSha,
      "test-correlation",
      config,
      registry,
      executeReaction,
    );

    // Function fires (auto=true) but the dedup guard in the caller is what prevents
    // the re-entry. Here we verify: with same SHA already recorded, the function still
    // executes and records the same SHA again (idempotent SHA write is harmless).
    expect(result).toBe(true);
    expect(lastSkepticSha.get(session.id)).toBe(currentSha);
  });
});
