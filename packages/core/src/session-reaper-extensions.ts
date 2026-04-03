/**
 * session-reaper-extensions.ts — fork-specific zombie detection policy (bd-s4t).
 *
 * Extracted from session-reaper.ts to keep core diff minimal per CLAUDE.md
 * guideline: "extract fork logic into *-extensions.ts or fork-*.ts companion files."
 *
 * Handles sessions whose GitHub PR was merged or closed while the AO session
 * status was not yet reconciled by lifecycle-manager.
 */

import type { Session, SessionManager } from "./types.js";
import type { ReapedSession, ReaperError, SkippedSession } from "./session-reaper.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ZombieCheckInput {
  session: Session;
  sessionManager: SessionManager;
  orphanedThresholdMs: number;
  now: Date;
  dryRun: boolean;
  /**
   * bd-ara.2: AO session statuses that are terminal on GitHub but not yet
   * reconciled — the session's AO status is "merged" (or "killed") but the
   * PR has not been cleaned up by the lifecycle-manager's post-merge sweep.
   * Using session.status as the primary signal is more reliable than
   * session.pr?.state because:
   *   (a) session.pr is nullified after the lifecycle-manager's merged
   *       transition (the PR field is cleared in session.pr after persist)
   *   (b) session.pr?.state is only updated when it changes, so it can be
   *       stale if persistPrState fails or the PR state was already cached
   *       before the merge.
   * The session.status field is always correctly set to "merged" on the
   * poll cycle that detects the PR merge, and is persisted in the session
   * file — making it the authoritative zombie signal.
   */
  readonly ZOMBIE_STATUSES?: Set<string>;
}

export type ZombieCheckResult =
  | { action: "killed"; entry: ReapedSession }
  | { action: "error"; entry: ReaperError }
  | { action: "skipped"; entry: SkippedSession }
  | { action: "none" };

// ---------------------------------------------------------------------------
// Module-level constant (avoids recreating on every call)
// ---------------------------------------------------------------------------

const ZOMBIE_STATUSES_SET = new Set(["merged", "killed"]);

// ---------------------------------------------------------------------------
// Zombie detection policy
// ---------------------------------------------------------------------------

/**
 * Determine whether a session is a zombie (PR merged/closed but AO status
 * not yet reconciled) and perform or record the kill.
 *
 * bd-ara.2 fix: Uses session.status as the primary zombie signal instead of
 * session.pr?.state.  The pr-state path is retained as a fallback for edge
 * cases where session.status hasn't been updated yet (e.g., poll cycle lag).
 *
 * Priority order:
 *   1. session.status === "merged"  → kill unconditionally (PR is merged)
 *   2. session.pr?.state === "merged" → kill (GitHub merged, AO not yet updated)
 *   3. session.pr?.state === "closed" + idle past threshold → kill
 *   4. Otherwise → "none"
 *
 * Returns "none" when this session does not match any zombie condition.
 */
export async function checkAndKillZombie(
  input: ZombieCheckInput,
): Promise<ZombieCheckResult> {
  const { session, sessionManager, orphanedThresholdMs, now, dryRun, ZOMBIE_STATUSES } = input;
  const ZOMBIE = ZOMBIE_STATUSES ?? ZOMBIE_STATUSES_SET;

  // 1. Primary signal: session.status set to "merged" by lifecycle-manager
  //    on the same poll cycle that detected the PR merge. This is always
  //    accurate because lifecycle-manager returns { status: "merged" } and
  //    calls sessionManager.update() before the reaper ever runs.
  if (ZOMBIE.has(session.status)) {
    return killZombie({
      session,
      sessionManager,
      reason: `zombie: AO status="${session.status}" — PR merged but tmux not yet reaped`,
      dryRun,
    });
  }

  // 2. Fallback: pr-state path (bd-s4t.2 original logic).  This catches the
  //    brief window before lifecycle-manager has updated session.status, and
  //    also handles cases where session.pr was already nullified after merge.
  const prState = session.pr?.state;

  if (prState === "merged") {
    return killZombie({ session, sessionManager, reason: `zombie: PR ${prState}`, dryRun });
  }

  if (prState === "closed") {
    const idleMs = now.getTime() - session.lastActivityAt.getTime();
    if (idleMs > orphanedThresholdMs) {
      return killZombie({ session, sessionManager, reason: `zombie: PR ${prState}`, dryRun });
    }
    return {
      action: "skipped",
      entry: {
        sessionId: session.id,
        reason: "closed PR but not yet idle past orphanedThreshold — may reopen",
      },
    };
  }

  return { action: "none" };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function killZombie({
  session,
  sessionManager,
  reason,
  dryRun,
}: {
  session: Session;
  sessionManager: SessionManager;
  reason: string;
  dryRun: boolean;
}): Promise<ZombieCheckResult> {
  if (dryRun) {
    return { action: "killed", entry: { sessionId: session.id, reason } };
  }
  try {
    await sessionManager.kill(session.id);
    return { action: "killed", entry: { sessionId: session.id, reason } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { action: "error", entry: { sessionId: session.id, error: msg } };
  }
}
