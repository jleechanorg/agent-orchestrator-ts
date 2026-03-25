/**
 * Review SLA tracker for CHANGES_REQUESTED cycles.
 *
 * Mechanism (3): stuck-review SLA — tracks how long a PR has been in
 * changes_requested status and auto-triggers escalation after threshold.
 *
 * Design:
 * - Per-session SLA state stored in session metadata
 * - Tracks: first_seen_at, cycle_count, last_escalate_at
 * - Escalation = re-dispatch reaction + notify human at SLA boundary
 * - Configurable SLA thresholds via OrchestratorConfig
 */

import type { Session, OrchestratorConfig } from "./types.js";
import { updateSessionMetadataHelper } from "./fork-utils.js";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface ReviewSLAConfig {
  /** Minutes before first escalation nudge (default: 15) */
  warnAfterMinutes: number;
  /** Minutes before second/escalate trigger (default: 45) */
  escalateAfterMinutes: number;
  /** Minutes before terminal abandon (default: 120) */
  abandonAfterMinutes: number;
  /** Notify human on SLA events (default: true) */
  notifyOnSlaEvent: boolean;
}

export const DEFAULT_REVIEW_SLA_CONFIG: ReviewSLAConfig = {
  warnAfterMinutes: 15,
  escalateAfterMinutes: 45,
  abandonAfterMinutes: 120,
  notifyOnSlaEvent: true,
};

// ---------------------------------------------------------------------------
// SLA state keys (session metadata)
// ---------------------------------------------------------------------------

const META_FIRST_SEEN_AT      = "review_sla_first_seen_at";
const META_LAST_ESCL_AT        = "review_sla_last_escalate_at";
const META_CYCLE_COUNT         = "review_sla_cycle_count";
const _META_LAST_SLA_CHECK_AT  = "review_sla_last_check_at";
const META_SLA_LEVEL           = "review_sla_level"; // "ok" | "warn" | "escalate" | "abandon"

export type SLAState = "ok" | "warn" | "escalate" | "abandon";

// ---------------------------------------------------------------------------
// SLA state accessors
// ---------------------------------------------------------------------------

export function getSLAState(session: Session): {
  firstSeenAt: string | null;
  lastEscalateAt: string | null;
  cycleCount: number;
  currentLevel: SLAState;
} {
  return {
    firstSeenAt: session.metadata[META_FIRST_SEEN_AT] ?? null,
    lastEscalateAt: session.metadata[META_LAST_ESCL_AT] ?? null,
    cycleCount: parseInt(session.metadata[META_CYCLE_COUNT] ?? "0", 10),
    currentLevel: (session.metadata[META_SLA_LEVEL] as SLAState) ?? "ok",
  };
}

function now(): string {
  return new Date().toISOString();
}

function minutesSince(isoTimestamp: string): number {
  const then = new Date(isoTimestamp).getTime();
  return (Date.now() - then) / 60_000;
}

// ---------------------------------------------------------------------------
// SLA evaluation
// ---------------------------------------------------------------------------

export interface SLAEvaluation {
  level: SLAState;
  minutesInState: number;
  shouldWarn: boolean;
  shouldEscalate: boolean;
  shouldAbandon: boolean;
  /** True if this is the first transition into a new level */
  levelTransition: boolean;
}

/**
 * Evaluate SLA state for a session currently in changes_requested.
 */
export function evaluateReviewSLA(
  session: Session,
  config: ReviewSLAConfig,
): SLAEvaluation {
  const { firstSeenAt, lastEscalateAt, cycleCount, currentLevel } = getSLAState(session);
  const slaConfig = config ?? DEFAULT_REVIEW_SLA_CONFIG;

  if (!firstSeenAt) {
    return {
      level: "ok",
      minutesInState: 0,
      shouldWarn: false,
      shouldEscalate: false,
      shouldAbandon: false,
      levelTransition: false,
    };
  }

  const minutesInState = minutesSince(firstSeenAt);
  const minutesSinceLastEscalate = lastEscalateAt ? minutesSince(lastEscalateAt) : Infinity;
  const escalationInterval = slaConfig.escalateAfterMinutes * (cycleCount + 1);

  const shouldWarn      = minutesInState >= slaConfig.warnAfterMinutes && currentLevel === "ok";
  // First escalation: escalate if past the base escalate threshold.
  // Subsequent escalations: escalate only after the per-cycle interval has elapsed since last escalation.
  const shouldEscalate = !lastEscalateAt
    ? minutesInState >= slaConfig.escalateAfterMinutes
    : minutesSinceLastEscalate >= escalationInterval;
  const shouldAbandon  = minutesInState >= slaConfig.abandonAfterMinutes;

  const nextLevel: SLAState = shouldAbandon
    ? "abandon"
    : shouldEscalate
    ? "escalate"
    : shouldWarn
    ? "warn"
    : "ok";

  const levelTransition = nextLevel !== currentLevel && nextLevel !== "ok";

  return { level: nextLevel, minutesInState, shouldWarn, shouldEscalate, shouldAbandon, levelTransition };
}

// ---------------------------------------------------------------------------
// SLA state mutations (persist to session metadata)
// ---------------------------------------------------------------------------

/**
 * Record that a session has entered changes_requested state.
 * Called once per cycle start.
 */
export function recordSLAStart(
  session: Session,
  config: OrchestratorConfig,
): void {
  const nowIso = now();
  updateSessionMetadataHelper(
    session,
    {
      [META_FIRST_SEEN_AT]: nowIso,
      [META_LAST_ESCL_AT]: "",
      [META_CYCLE_COUNT]: "0",
      [META_SLA_LEVEL]: "ok",
    },
    config,
  );
}

/**
 * Record that an escalation event was triggered.
 */
export function recordSLAEscalation(
  session: Session,
  config: OrchestratorConfig,
): void {
  const { cycleCount } = getSLAState(session);
  const nowIso = now();
  updateSessionMetadataHelper(
    session,
    {
      [META_LAST_ESCL_AT]: nowIso,
      [META_CYCLE_COUNT]: String(cycleCount + 1),
      [META_SLA_LEVEL]: "escalate",
    },
    config,
  );
}

/**
 * Clear SLA state when the session exits changes_requested (e.g. approved, merged).
 */
export function clearSLAState(
  session: Session,
  config: OrchestratorConfig,
): void {
  updateSessionMetadataHelper(
    session,
    {
      [META_FIRST_SEEN_AT]: "",
      [META_LAST_ESCL_AT]: "",
      [META_CYCLE_COUNT]: "0",
      [META_SLA_LEVEL]: "",
    },
    config,
  );
}

/**
 * Advance SLA level to warn.
 */
export function recordSLAWarn(
  session: Session,
  config: OrchestratorConfig,
): void {
  updateSessionMetadataHelper(session, { [META_SLA_LEVEL]: "warn" }, config);
}
