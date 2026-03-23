/**
 * TMUX Session Sweeper — orphan cleanup for the lifecycle-manager.
 *
 * Periodically audits tmux sessions against the AO session DB and kills
 * sessions that are:
 * 1. AO-named (match the (ao|jc|wa|cc|ra|wc)-NNN pattern via parseTmuxName)
 * 2. Absent from the AO session DB (no metadata file)
 * 3. Idle beyond the configured threshold (default: 30 minutes)
 *
 * This prevents gradual tmux accumulation that would eventually block the
 * spawn gate (>15 sessions). Orphans arise from:
 * - Lifecycle-manager restarts mid-session
 * - Sessions killed outside AO's control
 * - Corrupted/deleted metadata files
 * - Sessions spawned by other AO installations on the same machine
 *
 * Runs on each lifecycle-manager poll cycle (every 30s by default).
 */

import { listSessions, killSession, type TmuxSessionInfo } from "./tmux.js";
import { parseTmuxName } from "./paths.js";
import type { SessionManager } from "./types.js";

// =============================================================================
// Types
// =============================================================================

/** AO session name prefixes that the sweeper will consider. */
export const AO_SESSION_PREFIXES = new Set(["ao", "jc", "wa", "cc", "ra", "wc"]);

export interface TmuxSweeperConfig {
  /**
   * Milliseconds a session must be idle before it is considered killable.
   * Default: 30 minutes (1_800_000 ms)
   */
  orphanIdleThresholdMs: number;
  /**
   * Maximum orphan tmux sessions to kill per sweep invocation.
   * Default: 10
   */
  maxKillsPerSweep: number;
  /**
   * If true, log what would be killed but do not actually kill.
   * Default: false
   */
  dryRun?: boolean;
  /**
   * Optional logger for sweep events.
   */
  log?: (msg: string) => void;
}

export interface SweptOrphan {
  tmuxName: string;
  aoSessionId: string | null;
  created: string;
  idleMs: number;
  reason: string;
}

export interface SkippedOrphan {
  tmuxName: string;
  reason: string;
}

export interface SweeperError {
  tmuxName: string;
  error: string;
}

export interface TmuxSweepResult {
  killed: SweptOrphan[];
  skipped: SkippedOrphan[];
  errors: SweeperError[];
  dryRun: boolean;
  scanned: number;
}

export interface TmuxSweeperDeps {
  sessionManager: SessionManager;
  /** Override current time (testing only) */
  now?: Date;
}

// =============================================================================
// Default config
// =============================================================================

export const DEFAULT_TMUX_SWEEPER_CONFIG: TmuxSweeperConfig = {
  orphanIdleThresholdMs: 1_800_000, // 30 minutes
  maxKillsPerSweep: 10,
};

// =============================================================================
// Core sweeper logic
// =============================================================================

/**
 * Determines if a tmux session is AO-named (matches the session naming pattern).
 * Uses parseTmuxName which requires the 12-char hex hash prefix.
 */
function isAoTmuxSession(session: TmuxSessionInfo): boolean {
  const parsed = parseTmuxName(session.name);
  return parsed !== null && AO_SESSION_PREFIXES.has(parsed.prefix);
}

/**
 * Extract the AO session ID from a tmux session name.
 * Returns null if the name doesn't parse as an AO session.
 */
function aoSessionIdFromTmuxName(tmuxName: string): string | null {
  const parsed = parseTmuxName(tmuxName);
  if (!parsed) return null;
  return `${parsed.prefix}-${parsed.num}`;
}

/**
 * Compute how long a tmux session has existed (used as idle proxy when
 * last-activity is unavailable for detached sessions).
 *
 * Parses tmux's `session_created_string` format (e.g. "Mon Mar 23 12:00:00 2025")
 * and returns milliseconds since creation.
 */
function computeIdleMs(session: TmuxSessionInfo, now: Date): number {
  try {
    // tmux format: "Mon Mar 23 12:00:00 2025"
    const createdDate = new Date(session.created);
    if (isNaN(createdDate.getTime())) {
      // Fallback: treat unparseable dates as very old so the session is killable
      return now.getTime();
    }
    return now.getTime() - createdDate.getTime();
  } catch {
    // If parsing fails entirely, return max value so the session is always killable
    return now.getTime();
  }
}

/**
 * Audit all tmux sessions and kill orphans not tracked in the AO DB.
 *
 * @param config   - Sweeper configuration (threshold, dryRun, etc.)
 * @param deps     - Dependency injection (sessionManager, optional now)
 * @returns Result describing what was killed, skipped, or errored
 */
export async function sweepOrphanTmuxSessions(
  config: TmuxSweeperConfig,
  deps: TmuxSweeperDeps,
): Promise<TmuxSweepResult> {
  const now = deps.now ?? new Date();
  const dryRun = config.dryRun ?? false;
  const logFn = config.log ?? ((_msg: string) => {});

  const allTmuxSessions = await listSessions();
  const scanned = allTmuxSessions.length;

  // Get all active AO session IDs from the DB
  const aoSessions = await deps.sessionManager.list();
  const aoSessionIds = new Set(aoSessions.map((s) => s.id));

  const killed: SweptOrphan[] = [];
  const skipped: SkippedOrphan[] = [];
  const errors: SweeperError[] = [];

  for (const session of allTmuxSessions) {
    // Skip non-AO-named sessions (e.g., user's manual tmux sessions)
    if (!isAoTmuxSession(session)) {
      continue;
    }

    const aoSessionId = aoSessionIdFromTmuxName(session.name);

    // Skip sessions that are tracked in the AO DB — they are legitimate
    if (aoSessionId !== null && aoSessionIds.has(aoSessionId)) {
      skipped.push({ tmuxName: session.name, reason: "tracked in AO DB" });
      continue;
    }

    // Session is not in the AO DB — check idle time
    const idleMs = computeIdleMs(session, now);

    if (idleMs < config.orphanIdleThresholdMs) {
      skipped.push({
        tmuxName: session.name,
        reason: `not yet idle (${Math.round(idleMs / 60_000)}min < ${Math.round(config.orphanIdleThresholdMs / 60_000)}min threshold)`,
      });
      continue;
    }

    // Orphan candidate: not in AO DB, past idle threshold
    const reason = aoSessionId
      ? `no AO DB record, idle ${Math.round(idleMs / 60_000)}min`
      : `unparseable AO name, idle ${Math.round(idleMs / 60_000)}min`;

    if (killed.length >= config.maxKillsPerSweep) {
      skipped.push({ tmuxName: session.name, reason: "max kills per sweep reached" });
      continue;
    }

    logFn(`[tmux-sweeper] ${dryRun ? "[DRYRUN] " : ""}killing orphan tmux session: ${session.name} (${reason})`);

    if (!dryRun) {
      try {
        await killSession(session.name);
        killed.push({ tmuxName: session.name, aoSessionId, created: session.created, idleMs, reason });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // "no server" / "session not found" means it vanished between list and kill — not an error
        if (/session not found|no server/i.test(msg)) {
          logFn(`[tmux-sweeper] session already gone: ${session.name}`);
        } else {
          errors.push({ tmuxName: session.name, error: msg });
        }
      }
    } else {
      killed.push({ tmuxName: session.name, aoSessionId, created: session.created, idleMs, reason });
    }
  }

  return { killed, skipped, errors, dryRun, scanned };
}
