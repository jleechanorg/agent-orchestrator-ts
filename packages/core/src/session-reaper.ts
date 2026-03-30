/**
 * Session Reaper — nightly cleanup of orphaned/stale tmux sessions.
 *
 * Scheduled job (daily 3am): poll sessions, kill those that are:
 * - orphaned (activity=exited or process dead) for > orphanedThresholdMs
 * - have no PR for > noPrThresholdMs
 * - idle for > orphanedThresholdMs
 * - alive longer than sessionTtlMs (orch-ju1)
 * - tmux process dead (orch-ju1)
 *
 * Respects maxKillsPerRun cap per execution.
 */

import { TERMINAL_STATUSES, type Session, type SessionManager } from "./types.js";
import { checkAndKillZombie } from "./session-reaper-extensions.js";

// =============================================================================
// Types
// =============================================================================

export interface ReaperConfig {
  /** ms before an orphaned session is killed (default: 2h) */
  orphanedThresholdMs: number;
  /** ms before a session with no PR is killed (default: 4h) */
  noPrThresholdMs: number;
  /** max sessions to kill per run (default: 15) */
  maxKillsPerRun: number;
  /** if true, log what would be killed but don't actually kill */
  dryRun?: boolean;
  /**
   * ms of inactivity required before a no-PR session is eligible for reaping.
   * When omitted, the no-PR condition is gated solely on session age (backward-
   * compatible default). Set to a positive value to require both age AND idle
   * time before reaping, preventing termination of sessions that are actively
   * working but happen to have been running longer than the age threshold.
   */
  idleThresholdMs?: number;
  /**
   * bd-85r: ms after session creation during which the session is immune to
   * reaping. Prevents killing sessions before the agent CLI has initialized.
   */
  startupGracePeriodMs?: number;
  /**
   * orch-ju1: ms after which a session is reaped regardless of other conditions.
   * Sessions that exceed this TTL are killed even if they are active and have
   * an open PR. Default: 4h (14_400_000 ms). Set to undefined to disable.
   */
  sessionTtlMs?: number;
}

export interface ReapedSession {
  sessionId: string;
  reason: string;
}

export interface SkippedSession {
  sessionId: string;
  reason: string;
}

export interface ReaperError {
  sessionId: string;
  error: string;
}

export interface ReaperResult {
  killed: ReapedSession[];
  skipped: SkippedSession[];
  errors: ReaperError[];
  dryRun: boolean;
}

export interface ReaperDeps {
  sessionManager: SessionManager;
  /** Override current time (for testing) */
  now?: Date;
  /**
   * orch-ju1: Check if a tmux session is still alive.
   * Receives the full tmux name (e.g. "a3b4c5d6e7f8-ao-42") from session metadata.
   * Returns true if the tmux session exists, false if the process is dead.
   */
  tmuxHealth?: (tmuxName: string) => Promise<boolean>;
  /**
   * orch-ju1: Respawn a replacement worker for the given session.
   * Called after kill() when the dead-tmux session had an open PR — the
   * replacement worker is spawned targeting the same PR.
   * The respawn fn must extract pr.number from the session and call
   * sessionManager.claimPR(newSessionId, String(pr.number)).
   */
  respawnSession?: (sessionId: string, projectId: string, session: Session) => Promise<void>;
}

// =============================================================================
// Default config
// =============================================================================

export const DEFAULT_REAPER_CONFIG: ReaperConfig = {
  orphanedThresholdMs: 7_200_000, // 2h
  noPrThresholdMs: 14_400_000, // 4h
  maxKillsPerRun: 15, // bd-s4t: raised from 5 to handle burst cleanup when zombie
                       // sessions accumulate past the 15-session spawn gate
};

// =============================================================================
// Core reaper logic
// =============================================================================

/**
 * Reap stale/orphaned sessions according to the given config.
 */
export async function reapStaleSessions(
  config: ReaperConfig,
  deps: ReaperDeps,
): Promise<ReaperResult> {
  const now = deps.now ?? new Date();
  const dryRun = config.dryRun ?? false;

  const killed: ReapedSession[] = [];
  const skipped: SkippedSession[] = [];
  const errors: ReaperError[] = [];

  const sessions = await deps.sessionManager.list();

  for (const session of sessions) {
    // Stop if we hit the kill cap — count attempts (killed + errors), not just successes
    if (killed.length + errors.length >= config.maxKillsPerRun) {
      skipped.push({ sessionId: session.id, reason: "kill cap reached" });
      continue;
    }

    // Skip sessions already in terminal status (not activity — exited activity is reaped)
    if (TERMINAL_STATUSES.has(session.status)) {
      skipped.push({ sessionId: session.id, reason: "terminal state" });
      continue;
    }

    // bd-s4t.2: zombie detection — sessions whose GitHub PR was merged/closed
    // but whose AO status hasn't been reconciled yet. Policy lives in the
    // companion module session-reaper-extensions.ts (fork-specific logic).
    const zombieResult = await checkAndKillZombie({
      session,
      sessionManager: deps.sessionManager,
      orphanedThresholdMs: config.orphanedThresholdMs,
      now,
      dryRun,
    });
    if (zombieResult.action === "killed") {
      killed.push(zombieResult.entry);
      continue;
    }
    if (zombieResult.action === "error") {
      errors.push(zombieResult.entry);
      continue;
    }
    if (zombieResult.action === "skipped") {
      skipped.push(zombieResult.entry);
      continue;
    }

    const ageMs = now.getTime() - session.createdAt.getTime();

    // bd-85r: Skip sessions within startup grace period
    const gracePeriodMs = config.startupGracePeriodMs ?? 0;
    if (gracePeriodMs > 0 && ageMs < gracePeriodMs) {
      skipped.push({ sessionId: session.id, reason: "startup grace period" });
      continue;
    }

    // orch-ju1: Check if the tmux session is still alive.
    // Only possible when tmuxName is stored in session metadata (new architecture).
    const tmuxName = session.metadata["tmuxName"];
    if (deps.tmuxHealth && tmuxName) {
      const tmuxAlive = await deps.tmuxHealth(tmuxName);
      if (!tmuxAlive) {
        // tmux process is dead — kill the AO session and optionally respawn.
        // Grace period already applied above.
        const prState = session.pr?.state;
        const isTerminalPr = prState === "merged" || prState === "closed";
        if (!dryRun) {
          let killedSuccessfully = false;
          try {
            await deps.sessionManager.kill(session.id);
            killedSuccessfully = true;
            killed.push({ sessionId: session.id, reason: `tmux dead (${tmuxName})` });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push({ sessionId: session.id, error: msg });
          }
          // Respawn replacement worker only when kill succeeded and PR is open.
          // Do NOT respawn if kill failed — a failed kill means the session still
          // exists and the respawn would create a duplicate worker.
          if (killedSuccessfully && session.pr && !isTerminalPr && deps.respawnSession) {
            try {
              await deps.respawnSession(session.id, session.projectId, session);
            } catch (respawnErr) {
              const msg = respawnErr instanceof Error ? respawnErr.message : String(respawnErr);
              errors.push({ sessionId: session.id, error: `respawn: ${msg}` });
            }
          }
        } else {
          killed.push({ sessionId: session.id, reason: `tmux dead (${tmuxName})` });
        }
        continue;
      }
    }

    // orch-ju1: TTL check — reap sessions that have been alive longer than configured TTL.
    // Sessions within grace period are already skipped above.
    if (config.sessionTtlMs !== undefined && ageMs > config.sessionTtlMs) {
      if (!dryRun) {
        try {
          await deps.sessionManager.kill(session.id);
          killed.push({ sessionId: session.id, reason: `TTL exceeded (${Math.round(ageMs / 3_600_000)}h > ${Math.round(config.sessionTtlMs / 3_600_000)}h)` });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ sessionId: session.id, error: msg });
        }
      } else {
        killed.push({ sessionId: session.id, reason: `TTL exceeded (${Math.round(ageMs / 3_600_000)}h > ${Math.round(config.sessionTtlMs / 3_600_000)}h)` });
      }
      continue;
    }

    const idleMs = now.getTime() - session.lastActivityAt.getTime();
    const meetsIdleGate =
      config.idleThresholdMs === undefined || idleMs > config.idleThresholdMs;

    // Determine kill reason (priority order)
    let killReason: string | null = null;

    if (session.pr === null && ageMs > config.noPrThresholdMs && meetsIdleGate) {
      // No PR after threshold AND idle long enough (if idle gate is configured)
      killReason = "no PR after threshold";
    } else if (session.activity === "exited" && idleMs > config.orphanedThresholdMs) {
      // Orphaned: process exited
      killReason = "orphaned (process exited)";
    } else if (session.activity === "idle" && idleMs > config.orphanedThresholdMs) {
      // Stale idle
      killReason = "stale idle";
    }

    if (killReason === null) {
      skipped.push({ sessionId: session.id, reason: "no reap condition met" });
      continue;
    }

    // Kill (or dry-run)
    if (!dryRun) {
      try {
        await deps.sessionManager.kill(session.id);
        killed.push({ sessionId: session.id, reason: killReason });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ sessionId: session.id, error: msg });
      }
    } else {
      // dryRun: record what would have been killed without actually killing
      killed.push({ sessionId: session.id, reason: killReason });
    }
  }

  return { killed, skipped, errors, dryRun };
}
