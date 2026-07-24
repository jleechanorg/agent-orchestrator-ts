/**
 * Session Reaper — nightly cleanup of orphaned/stale tmux sessions.
 *
 * Scheduled job (daily 3am): poll sessions, kill those that are:
 * - orphaned (activity=exited or process dead) for > orphanedThresholdMs
 * - have no PR for > noPrThresholdMs
 * - idle for > orphanedThresholdMs
 *
 * Respects maxKillsPerRun cap per execution.
 */

import { TERMINAL_STATUSES, type SessionManager } from "./types.js";
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
   * bd-ara.2: AO session statuses that are treated as zombie signals.
   * Sessions in any of these statuses are immediately reaped (unconditionally,
   * regardless of age or activity). Default: new Set(["merged", "killed"]).
   * "merged" = PR was merged; tmux should be reaped by post-merge sweep but
   * zombie path catches any that slip through.
   * "killed" = lifecycle-manager marked as killed; tmux should already be dead
   * but zombie path cleans any stragglers.
   */
  zombieStatuses?: Set<string>;
  /** Optional project scope. When set, only sessions belonging to this project are reaped. */
  projectId?: string;
  /**
   * jleechan-issue-12: ms a session may remain in status="spawning" before
   * being reaped. Spawn init (tmux pane creation, agent CLI startup) either
   * succeeds and transitions status away from "spawning", or fails and
   * should free its queue slot promptly — it should never take hours.
   * A session stuck in "spawning" is created with activity="active", so it
   * matches none of the activity-based kill conditions below, and — since
   * spawn failures always start with pr===null — was previously only
   * caught (if at all) by the much coarser noPrThresholdMs fallback.
   * When omitted, this check is disabled (backward-compatible default).
   */
  spawnTimeoutMs?: number;
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
}

// =============================================================================
// Default config
// =============================================================================

export const DEFAULT_REAPER_CONFIG: ReaperConfig = {
  orphanedThresholdMs: 7_200_000, // 2h
  noPrThresholdMs: 14_400_000, // 4h
  maxKillsPerRun: 15, // bd-s4t: raised from 5 to handle burst cleanup when zombie
                       // sessions accumulate past the 20-session spawn gate
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

  const sessions = await deps.sessionManager.list(config.projectId);

  for (const session of sessions) {
    // Stop if we hit the kill cap — count attempts (killed + errors), not just successes
    if (killed.length + errors.length >= config.maxKillsPerRun) {
      skipped.push({ sessionId: session.id, reason: "kill cap reached" });
      continue;
    }

    // bd-ara.2: Zombie detection runs BEFORE the terminal-status skip.
    // Sessions with status="merged" or "killed" MUST be reaped — their tmux
    // process is alive even though the AO status is terminal. The terminal-status
    // skip below is for truly dead sessions (done, errored, terminated); the zombie
    // check handles sessions whose PR was merged but tmux wasn't reaped yet.
    // Policy lives in the companion module session-reaper-extensions.ts.
    const zombieResult = await checkAndKillZombie({
      session,
      sessionManager: deps.sessionManager,
      orphanedThresholdMs: config.orphanedThresholdMs,
      now,
      dryRun,
      ZOMBIE_STATUSES: config.zombieStatuses,
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

    // Skip sessions already in terminal status (not activity — exited activity is reaped).
    // bd-ara.2: "merged" and "killed" are excluded from this guard because they
    // are handled by the zombie check above. Other terminal statuses (done, errored,
    // terminated) are truly dead sessions that don't need reaping.
    if (TERMINAL_STATUSES.has(session.status)) {
      skipped.push({ sessionId: session.id, reason: "terminal state" });
      continue;
    }

    const ageMs = now.getTime() - session.createdAt.getTime();

    // bd-85r: Skip sessions within startup grace period
    const gracePeriodMs = config.startupGracePeriodMs ?? 0;
    if (gracePeriodMs > 0 && ageMs < gracePeriodMs) {
      skipped.push({ sessionId: session.id, reason: "startup grace period" });
      continue;
    }

    const idleMs = now.getTime() - session.lastActivityAt.getTime();
    const meetsIdleGate =
      config.idleThresholdMs === undefined || idleMs > config.idleThresholdMs;

    // Determine kill reason (priority order)
    let killReason: string | null = null;

    if (
      config.spawnTimeoutMs !== undefined &&
      session.status === "spawning" &&
      ageMs > config.spawnTimeoutMs
    ) {
      // jleechan-issue-12: dedicated check for sessions stuck in "spawning".
      // Must run before the generic noPrThresholdMs fallback below so a
      // configured spawnTimeoutMs (typically far shorter than 24h) takes
      // effect promptly instead of waiting on the coarser no-PR window.
      killReason = "stuck in spawning past timeout";
    } else if (session.pr === null && ageMs > config.noPrThresholdMs && meetsIdleGate) {
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
