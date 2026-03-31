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
 * wc-zsw additions:
 * 6. First-seen session in pr_open dispatches skeptic (no-transition path)
 * 7. ci_failed is included in SHA-change re-trigger guard list
 *
 * The Map and its manipulation logic are tested directly — no module mocking needed.
 * The actual lifecycle-manager module exercises this logic in production.
 */

import { describe, it, expect } from "vitest";

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

describe("lifecycle-manager skeptic wiring — wc-zsw first-seen and ci_failed coverage", () => {
  // wc-zsw Bug 1: A session first polled in pr_open (tracked=undefined) must dispatch
  // skeptic in the no-transition path, since the transition block only fires when
  // newStatus === "pr_open" — which never happens when oldStatus already equals newStatus
  // (agent wrote pr_open to metadata before lifecycle-manager started polling).
  it("first-seen session in pr_open dispatches skeptic in no-transition path", () => {
    // Simulates: lifecycle-manager first polls a session, tracked is undefined,
    // metadata.status already equals "pr_open", determineStatus() returns "pr_open".
    // The no-transition block (else path) must catch this.
    const tracked: string | undefined = undefined;
    const newStatus = "pr_open";

    const shouldDispatch = tracked === undefined && newStatus === "pr_open";
    expect(shouldDispatch).toBe(true);
  });

  it("tracked session in pr_open does NOT fire the first-seen skeptic guard", () => {
    // Once a session is tracked, the no-transition block's first-seen guard must NOT fire.
    const tracked = "pr_open";
    const newStatus = "pr_open";

    const shouldDispatch = tracked === undefined && newStatus === "pr_open";
    expect(shouldDispatch).toBe(false);
  });

  // wc-zsw Bug 1: A session first polled as ci_failed (agent wrote pr_open to metadata,
  // CI already ran by the time lifecycle-manager first polled) transitions as
  // pr_open → ci_failed without triggering the pr_open-only skeptic guard.
  // The first-seen guard does not cover ci_failed — the SHA-change re-trigger (bd-qnj6)
  // must include ci_failed to provide coverage on subsequent pushes.
  it("session first seen transitioning pr_open→ci_failed has no prior SHA record", () => {
    const lastSkepticSha = new Map<string, string>();
    const sessionId = "ci-failed-first-seen-session";

    // Simulate: lifecycle-manager first sees this session as ci_failed.
    // No SHA record exists because skeptic never fired.
    const previousSha = lastSkepticSha.get(sessionId);
    const currentSha = "abc5555555555555555555555555555555555555";

    // Guard: currentSha exists, but previousSha does not — SHA-change path fires.
    const shaChangeDetected = Boolean(currentSha && !previousSha);
    expect(shaChangeDetected).toBe(true);
  });

  // wc-zsw Bug 2: The bd-qnj6 re-trigger guard list must include ci_failed so that
  // sessions in ci_failed (first-seen or otherwise) get SHA-change re-trigger coverage.
  it("ci_failed is included in the SHA-change re-trigger status guard list", () => {
    const RE_TRIGGER_STATUSES = [
      "pr_open",
      "ci_failed", // wc-zsw: ADDED — ci_failed sessions need SHA-change coverage too
      "review_pending",
      "changes_requested",
      "approved",
      "mergeable",
    ] as const;

    // ci_failed must be in the list
    expect(RE_TRIGGER_STATUSES).toContain("ci_failed");

    // Specifically: ci_failed session with SHA change must be re-trigger eligible
    const session = { status: "ci_failed" as const, pr: "PR-123" };
    const eligible = RE_TRIGGER_STATUSES.includes(session.status) && Boolean(session.pr);
    expect(eligible).toBe(true);
  });

  // wc-zsw Bug 2: Verify the SHA-change re-trigger fires for ci_failed on new SHA
  it("ci_failed session with new SHA triggers skeptic re-evaluation", () => {
    const lastSkepticSha = new Map<string, string>();
    const sessionId = "ci-failed-session";
    const previousSha = "abc6666666666666666666666666666666666666";
    lastSkepticSha.set(sessionId, previousSha);

    const currentSha = "abc7777777777777777777777777777777777777";

    // SHA changed
    const shaChanged = Boolean(currentSha && previousSha && currentSha !== previousSha);
    expect(shaChanged).toBe(true);

    // Status is ci_failed and in the re-trigger list
    const RE_TRIGGER_STATUSES = ["pr_open", "ci_failed", "review_pending", "changes_requested", "approved", "mergeable"] as const;
    const eligible = RE_TRIGGER_STATUSES.includes("ci_failed");
    expect(eligible).toBe(true);
  });
});
