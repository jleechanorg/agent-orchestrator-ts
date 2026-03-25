/**
 * No-delta watchdog — detects when a session's agent is not making progress.
 *
 * Mechanism (7): no-delta watchdog heartbeat behavior — monitors session
 * heartbeat metadata for signs of agent stall (no output delta, no file
 * changes, no status change over a threshold period).
 *
 * Design:
 * - Tracks last "meaningful delta" (new commits, file changes, status transitions)
 * - If no delta seen for `stuckThresholdMinutes`, transitions session to "stuck"
 * - Only transitions to "stuck" if terminal guard also passes
 * - Records watchdog events to session metadata for KPI emission
 */

import type { Session, OrchestratorConfig, OrchestratorEvent, EventPriority } from "./types.js";
import { updateSessionMetadataHelper } from "./fork-utils.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NoDeltaWatchdogConfig {
  /** Minutes with no meaningful delta before marking stuck (default: 60) */
  stuckThresholdMinutes: number;
  /** Minutes before first nudge warning (default: 20) */
  warnThresholdMinutes: number;
  /** Enable watchdog (default: true) */
  enabled: boolean;
}

export const DEFAULT_NO_DELTA_CONFIG: NoDeltaWatchdogConfig = {
  stuckThresholdMinutes: 60,
  warnThresholdMinutes: 20,
  enabled: true,
};

// ---------------------------------------------------------------------------
// Metadata keys
// ---------------------------------------------------------------------------

const META_LAST_DELTA_AT        = "no_delta_last_delta_at";
const META_DELTA_WARN_AT        = "no_delta_warn_at";
const META_DELTA_STUCK_AT       = "no_delta_stuck_at";
const META_DELTA_WARN_COUNT     = "no_delta_warn_count";
const META_DELTA_CHECK_COUNT    = "no_delta_check_count";

function now(): string { return new Date().toISOString(); }
function minutesSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 60_000;
}

// ---------------------------------------------------------------------------
// Delta tracking — call when a meaningful change is detected
// ---------------------------------------------------------------------------

/**
 * Record a meaningful delta event (commit, file change, status change).
 * Resets the watchdog timer.
 */
export function recordDelta(session: Session, config: OrchestratorConfig): void {
  const nowIso = now();
  updateSessionMetadataHelper(session, {
    [META_LAST_DELTA_AT]: nowIso,
    [META_DELTA_WARN_AT]: "",
    [META_DELTA_STUCK_AT]: "",
  }, config);
}

// ---------------------------------------------------------------------------
// Watchdog evaluation
// ---------------------------------------------------------------------------

export type NoDeltaResult = "ok" | "warn" | "stuck";

export interface NoDeltaEvaluation {
  result: NoDeltaResult;
  minutesSinceDelta: number;
  warnCount: number;
  checkCount: number;
  shouldNotify: boolean;
  shouldMarkStuck: boolean;
}

/**
 * Evaluate the no-delta watchdog for a session.
 *
 * Returns:
 * - "ok"      — delta is recent or watchdog is disabled
 * - "warn"    — delta is stale; notify agent/user
 * - "stuck"   — delta is very stale; should mark session as stuck
 */
export function evaluateNoDeltaWatchdog(
  session: Session,
  config: NoDeltaWatchdogConfig,
): NoDeltaEvaluation {
  if (!config.enabled) {
    return { result: "ok", minutesSinceDelta: 0, warnCount: 0, checkCount: 0, shouldNotify: false, shouldMarkStuck: false };
  }

  const lastDeltaAt   = session.metadata[META_LAST_DELTA_AT] ?? "";
  const deltaWarnAt   = session.metadata[META_DELTA_WARN_AT] ?? "";
  const deltaStuckAt  = session.metadata[META_DELTA_STUCK_AT] ?? "";
  const warnCount     = parseInt(session.metadata[META_DELTA_WARN_COUNT] ?? "0", 10);
  const checkCount    = parseInt(session.metadata[META_DELTA_CHECK_COUNT] ?? "0", 10) + 1;

  if (!lastDeltaAt) {
    // No delta recorded yet — check against session start time
    const sessionStart = session.metadata["created_at"] ?? now();
    const minutes = minutesSince(sessionStart);
    const result: NoDeltaResult = minutes >= config.stuckThresholdMinutes ? "stuck" : minutes >= config.warnThresholdMinutes ? "warn" : "ok";
    return {
      result,
      minutesSinceDelta: minutes,
      warnCount: 0,
      checkCount,
      shouldNotify: result === "warn",
      shouldMarkStuck: result === "stuck",
    };
  }

  const minutesSinceDelta = minutesSince(lastDeltaAt);
  const result: NoDeltaResult =
    minutesSinceDelta >= config.stuckThresholdMinutes ? "stuck"
    : minutesSinceDelta >= config.warnThresholdMinutes ? "warn"
    : "ok";

  const shouldNotify   = result === "warn" && !deltaWarnAt;
  const shouldMarkStuck = result === "stuck" && !deltaStuckAt;

  return { result, minutesSinceDelta, warnCount, checkCount, shouldNotify, shouldMarkStuck };
}

// ---------------------------------------------------------------------------
// Watchdog state mutations
// ---------------------------------------------------------------------------

/**
 * Record that a warning nudge was sent.
 */
export function recordDeltaWarning(
  session: Session,
  config: OrchestratorConfig,
  warnCount: number,
): void {
  updateSessionMetadataHelper(session, {
    [META_DELTA_WARN_AT]: now(),
    [META_DELTA_WARN_COUNT]: String(warnCount + 1),
  }, config);
}

/**
 * Record that the session was marked as stuck due to no delta.
 */
export function recordDeltaStuck(
  session: Session,
  config: OrchestratorConfig,
): void {
  updateSessionMetadataHelper(session, {
    [META_DELTA_STUCK_AT]: now(),
  }, config);
}

// ---------------------------------------------------------------------------
// Convenience: build watchdog event
// ---------------------------------------------------------------------------

export interface WatchdogEventDeps {
  session: Session;
  createEvent: (
    type: string,
    opts: { sessionId: string; projectId: string; message: string; data?: Record<string, unknown> },
  ) => OrchestratorEvent;
  notifyHuman: (event: OrchestratorEvent, priority: EventPriority) => Promise<void>;
}

export async function emitWatchdogEvent(
  deps: WatchdogEventDeps,
  result: NoDeltaResult,
  minutesSinceDelta: number,
): Promise<void> {
  const { session, createEvent, notifyHuman } = deps;
  const event = createEvent(
    result === "stuck" ? "no_delta.stuck" : "no_delta.warn",
    {
      sessionId: session.id,
      projectId: session.projectId,
      message:
        result === "stuck"
          ? `Session ${session.id} marked stuck — no meaningful delta for ${minutesSinceDelta.toFixed(0)} minutes`
          : `Session ${session.id} has no meaningful delta for ${minutesSinceDelta.toFixed(0)} minutes — consider checking agent health`,
      data: { minutesSinceDelta: Math.round(minutesSinceDelta), result },
    },
  );
  await notifyHuman(event, result === "stuck" ? "urgent" : "warning");
}
