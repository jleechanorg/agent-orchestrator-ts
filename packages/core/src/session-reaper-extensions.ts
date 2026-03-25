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
}

export type ZombieCheckResult =
  | { action: "killed"; entry: ReapedSession }
  | { action: "error"; entry: ReaperError }
  | { action: "skipped"; entry: SkippedSession }
  | { action: "none" };

// ---------------------------------------------------------------------------
// Zombie detection policy
// ---------------------------------------------------------------------------

/**
 * Determine whether a session is a zombie (PR merged/closed but AO status
 * not yet reconciled) and perform or record the kill.
 *
 * - "merged" is a terminal GitHub state — kill unconditionally.
 * - "closed" can be re-opened — require idle > orphanedThresholdMs before
 *   treating it as a zombie.
 *
 * Returns "none" when this session does not match any zombie condition.
 */
export async function checkAndKillZombie(
  input: ZombieCheckInput,
): Promise<ZombieCheckResult> {
  const { session, sessionManager, orphanedThresholdMs, now, dryRun } = input;
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
