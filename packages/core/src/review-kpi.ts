/**
 * Review KPI emitter — tracks and emits metrics for CHANGES_REQUESTED stalls.
 *
 * Mechanism (8): measurable KPI emission + summary.
 *
 * Tracked KPIs:
 * - review_cycle_count: number of CHANGES_REQUESTED → approved cycles
 * - avg_review_resolution_minutes: mean time to resolve a review cycle
 * - stuck_review_count: how many times a session was marked stuck
 * - no_delta_warn_count: how many no-delta warnings were emitted
 * - sla_escalation_count: how many SLA escalation events fired
 * - last_review_cycle_at: ISO timestamp of last cycle start
 * - last_review_resolved_at: ISO timestamp of last resolution
 * - current_review_age_minutes: how long current CHANGES_REQUESTED has been open
 *
 * KPI data is stored in session metadata and emitted as structured events.
 * Downstream dashboards (e.g. Grafana, beads) can scrape these from events
 * or from session metadata snapshots.
 */

import type { Session, OrchestratorConfig, OrchestratorEvent, EventPriority } from "./types.js";
import { updateSessionMetadataHelper } from "./fork-utils.js";
import { type CommentBatchJudgment } from "./review-judgment-matrix.js";

// ---------------------------------------------------------------------------
// KPI metadata keys
// ---------------------------------------------------------------------------

const META_RC_COUNT         = "kpi_review_cycle_count";
const META_RC_AVG_MIN       = "kpi_avg_resolution_minutes";
const META_RC_STUCK_COUNT   = "kpi_stuck_review_count";
const META_RC_NO_DELTA_WARN = "kpi_no_delta_warn_count";
const META_RC_SLA_ESC       = "kpi_sla_escalation_count";
const META_RC_LAST_START    = "kpi_last_cycle_start_at";
const META_RC_LAST_RESOLVED = "kpi_last_cycle_resolved_at";
const META_RC_CURRENT_AGE   = "kpi_current_review_age_minutes";

function now(): string { return new Date().toISOString(); }
function minutesSince(iso: string): number {
  if (!iso) return 0;
  return (Date.now() - new Date(iso).getTime()) / 60_000;
}

// ---------------------------------------------------------------------------
// KPI state read
// ---------------------------------------------------------------------------

export interface ReviewKPIs {
  reviewCycleCount: number;
  avgResolutionMinutes: number;
  stuckReviewCount: number;
  noDeltaWarnCount: number;
  slaEscalationCount: number;
  lastCycleStartedAt: string | null;
  lastCycleResolvedAt: string | null;
  currentReviewAgeMinutes: number;
}

export function getReviewKPIs(session: Session): ReviewKPIs {
  const currentAgeStart = session.metadata[META_RC_LAST_START] ?? session.metadata["review_sla_first_seen_at"] ?? "";
  return {
    reviewCycleCount:    parseInt(session.metadata[META_RC_COUNT]         ?? "0", 10),
    avgResolutionMinutes: parseFloat(session.metadata[META_RC_AVG_MIN]       ?? "0"),
    stuckReviewCount:     parseInt(session.metadata[META_RC_STUCK_COUNT]     ?? "0", 10),
    noDeltaWarnCount:     parseInt(session.metadata[META_RC_NO_DELTA_WARN]  ?? "0", 10),
    slaEscalationCount:   parseInt(session.metadata[META_RC_SLA_ESC]        ?? "0", 10),
    lastCycleStartedAt:   session.metadata[META_RC_LAST_START]   ?? null,
    lastCycleResolvedAt:  session.metadata[META_RC_LAST_RESOLVED] ?? null,
    currentReviewAgeMinutes: minutesSince(currentAgeStart),
  };
}

// ---------------------------------------------------------------------------
// KPI mutations
// ---------------------------------------------------------------------------

/**
 * Record that a review cycle has started (CHANGES_REQUESTED received).
 */
export function recordCycleStart(session: Session, config: OrchestratorConfig): void {
  const nowIso = now();
  const currentCount = parseInt(session.metadata[META_RC_COUNT] ?? "0", 10);
  updateSessionMetadataHelper(session, {
    [META_RC_COUNT]:        String(currentCount + 1),
    [META_RC_LAST_START]:   nowIso,
    [META_RC_CURRENT_AGE]:  "0",
  }, config);
}

/**
 * Record that a review cycle was resolved (approved).
 * Updates avg resolution time using exponential moving average.
 */
export function recordCycleResolved(
  session: Session,
  config: OrchestratorConfig,
  resolutionMinutes: number,
): void {
  const nowIso = now();
  const prevAvg = parseFloat(session.metadata[META_RC_AVG_MIN] ?? "0");
  const count   = parseInt(session.metadata[META_RC_COUNT] ?? "0", 10);

  // Exponential moving average: new_avg = 0.7*prev_avg + 0.3*new_value
  const newAvg = count <= 1 ? resolutionMinutes : 0.7 * prevAvg + 0.3 * resolutionMinutes;

  updateSessionMetadataHelper(session, {
    [META_RC_AVG_MIN]:       newAvg.toFixed(1),
    [META_RC_LAST_RESOLVED]: nowIso,
    [META_RC_CURRENT_AGE]:    "0",
  }, config);
}

/**
 * Increment stuck review counter.
 */
export function recordStuckReview(session: Session, config: OrchestratorConfig): void {
  const count = parseInt(session.metadata[META_RC_STUCK_COUNT] ?? "0", 10);
  updateSessionMetadataHelper(session, { [META_RC_STUCK_COUNT]: String(count + 1) }, config);
}

/**
 * Increment no-delta warning counter.
 */
export function recordNoDeltaWarning(session: Session, config: OrchestratorConfig): void {
  const count = parseInt(session.metadata[META_RC_NO_DELTA_WARN] ?? "0", 10);
  updateSessionMetadataHelper(session, { [META_RC_NO_DELTA_WARN]: String(count + 1) }, config);
}

/**
 * Increment SLA escalation counter.
 */
export function recordSLAEscalation(session: Session, config: OrchestratorConfig): void {
  const count = parseInt(session.metadata[META_RC_SLA_ESC] ?? "0", 10);
  updateSessionMetadataHelper(session, { [META_RC_SLA_ESC]: String(count + 1) }, config);
}

// ---------------------------------------------------------------------------
// KPI emission
// ---------------------------------------------------------------------------

export interface KPIEmitDeps {
  session: Session;
  createEvent: (
    type: string,
    opts: { sessionId: string; projectId: string; message: string; data?: Record<string, unknown> },
  ) => OrchestratorEvent;
  notifyHuman: (event: OrchestratorEvent, priority: EventPriority) => Promise<void>;
}

/**
 * Emit current KPIs as a structured event.
 */
export async function emitKPIEvent(deps: KPIEmitDeps): Promise<void> {
  const { session, createEvent, notifyHuman } = deps;
  const kpis = getReviewKPIs(session);

  const event = createEvent("kpi.review_summary", {
    sessionId: session.id,
    projectId: session.projectId,
    message: buildKPISummary(kpis),
    data: {
      review_cycle_count:           kpis.reviewCycleCount,
      avg_resolution_minutes:       kpis.avgResolutionMinutes,
      stuck_review_count:            kpis.stuckReviewCount,
      no_delta_warn_count:           kpis.noDeltaWarnCount,
      sla_escalation_count:         kpis.slaEscalationCount,
      last_cycle_started_at:        kpis.lastCycleStartedAt,
      last_cycle_resolved_at:       kpis.lastCycleResolvedAt,
      current_review_age_minutes:   Math.round(kpis.currentReviewAgeMinutes),
    },
  });

  await notifyHuman(event, "info");
}

/**
 * Build a human-readable KPI summary string.
 */
export function buildKPISummary(kpis: ReviewKPIs): string {
  const lines = [
    `Review KPIs for session:`,
    `  Cycles: ${kpis.reviewCycleCount} | Avg resolution: ${kpis.avgResolutionMinutes.toFixed(0)}m`,
    `  Stuck: ${kpis.stuckReviewCount} | No-delta warns: ${kpis.noDeltaWarnCount} | SLA esc: ${kpis.slaEscalationCount}`,
    `  Current review age: ${kpis.currentReviewAgeMinutes.toFixed(0)}m`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Comment-batch KPI enrichment
// ---------------------------------------------------------------------------

/**
 * Build a structured KPI data object from a comment batch judgment.
 * Useful for emitting per-cycle classification data.
 */
export function enrichWithCommentJudgment(
  kpis: ReviewKPIs,
  judgment: CommentBatchJudgment,
): Record<string, unknown> {
  return {
    ...kpis,
    comment_batch_total:      judgment.total,
    comment_batch_blocking:   judgment.blocking.length,
    comment_batch_objective:  judgment.objective.length,
    comment_batch_subjective: judgment.subjective.length,
    comment_batch_unknown:    judgment.unknown.length,
    comment_batch_fingerprint: judgment.batchFingerprint,
  };
}
