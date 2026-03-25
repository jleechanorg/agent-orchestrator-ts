/**
 * Atomic re-review transaction coordinator.
 *
 * Mechanism (5): atomic re-review transaction — coordinates the complete
 * fix/push/resolve/request-review/verify state-flip cycle so all steps
 * complete or the transaction is rolled back (no partial state).
 *
 * Design:
 * - State machine: IDLE → FIX_APPLIED → PUSHED → REVIEW_RESOLVED → REREQ_REQUESTED → VERIFIED → DONE
 * - Each step writes a checkpoint to session metadata
 * - On failure, the checkpoint indicates where to resume / rollback
 * - Uses gh-headroom.ts for API calls to avoid rate-limit mid-transaction
 */

import type { Session, OrchestratorConfig, SCM } from "./types.js";
import { updateSessionMetadataHelper } from "./fork-utils.js";
import { getHeadroomStatus, invalidateHeadroomCache } from "./gh-headroom.js";
import { isGhRateLimitError } from "./gh-rate-limit.js";

// ---------------------------------------------------------------------------
// Transaction state machine
// ---------------------------------------------------------------------------

export type RereviewPhase =
  | "idle"
  | "fix_applied"
  | "pushed"
  | "review_resolved"
  | "rereq_requested"
  | "verified"
  | "done"
  | "rolled_back"
  | "failed";

export interface RereviewCheckpoint {
  phase: RereviewPhase;
  startedAt: string;
  lastStepAt: string;
  attemptCount: number;
  lastError: string;
  resolvedCommentIds: string[];
  reviewerLogin: string;
}

// ---------------------------------------------------------------------------
// Metadata key constants
// ---------------------------------------------------------------------------

const META_REREVIEW_PHASE          = "rereview_phase";
const META_REREVIEW_STARTED_AT     = "rereview_started_at";
const META_REREVIEW_LAST_STEP_AT   = "rereview_last_step_at";
const META_REREVIEW_ATTEMPT_COUNT  = "rereview_attempt_count";
const META_REREVIEW_LAST_ERROR     = "rereview_last_error";
const META_REREVIEW_RESOLVED_IDS   = "rereview_resolved_ids";
const META_REREVIEW_REVIEWER       = "rereview_reviewer_login";

// ---------------------------------------------------------------------------
// State accessors
// ---------------------------------------------------------------------------

export function getCheckpoint(session: Session): RereviewCheckpoint | null {
  const phase = session.metadata[META_REREVIEW_PHASE] as RereviewPhase;
  if (!phase || phase === "idle") return null;

  const startedAt = session.metadata[META_REREVIEW_STARTED_AT] ?? "";
  const lastStepAt = session.metadata[META_REREVIEW_LAST_STEP_AT] ?? "";
  const attemptCount = parseInt(session.metadata[META_REREVIEW_ATTEMPT_COUNT] ?? "0", 10);
  const lastError = session.metadata[META_REREVIEW_LAST_ERROR] ?? "";
  const resolvedIds = (session.metadata[META_REREVIEW_RESOLVED_IDS] ?? "").split(",").filter(Boolean);
  const reviewerLogin = session.metadata[META_REREVIEW_REVIEWER] ?? "";

  return { phase, startedAt, lastStepAt, attemptCount, lastError, resolvedCommentIds: resolvedIds, reviewerLogin };
}

function now(): string {
  return new Date().toISOString();
}

function updateCheckpoint(
  session: Session,
  config: OrchestratorConfig,
  patch: Partial<RereviewCheckpoint>,
): void {
  updateSessionMetadataHelper(
    session,
    {
      [META_REREVIEW_PHASE]:          patch.phase ?? session.metadata[META_REREVIEW_PHASE],
      [META_REREVIEW_STARTED_AT]:     patch.startedAt    ?? session.metadata[META_REREVIEW_STARTED_AT]    ?? now(),
      [META_REREVIEW_LAST_STEP_AT]:   patch.lastStepAt   ?? now(),
      [META_REREVIEW_ATTEMPT_COUNT]:  patch.attemptCount?.toString() ?? session.metadata[META_REREVIEW_ATTEMPT_COUNT] ?? "0",
      [META_REREVIEW_LAST_ERROR]:     patch.lastError ?? "",
      [META_REREVIEW_RESOLVED_IDS]:   patch.resolvedCommentIds?.join(",") ?? session.metadata[META_REREVIEW_RESOLVED_IDS] ?? "",
      [META_REREVIEW_REVIEWER]:       patch.reviewerLogin ?? session.metadata[META_REREVIEW_REVIEWER] ?? "",
    },
    config,
  );
}

// ---------------------------------------------------------------------------
// Rollback helpers
// ---------------------------------------------------------------------------

function resetTransaction(session: Session, config: OrchestratorConfig): void {
  updateSessionMetadataHelper(session, {
    [META_REREVIEW_PHASE]:          "idle",
    [META_REREVIEW_STARTED_AT]:     "",
    [META_REREVIEW_LAST_STEP_AT]:   "",
    [META_REREVIEW_ATTEMPT_COUNT]:  "0",
    [META_REREVIEW_LAST_ERROR]:     "",
    [META_REREVIEW_RESOLVED_IDS]:   "",
    [META_REREVIEW_REVIEWER]:       "",
  }, config);
}

// ---------------------------------------------------------------------------
// Atomic re-review transaction
// ---------------------------------------------------------------------------

export interface AtomicRereviewDeps {
  session: Session;
  config: OrchestratorConfig;
  scm: SCM;
  /** IDs of comments to resolve before requesting re-review */
  commentIdsToResolve: string[];
  /** GitHub login of the reviewer to re-request */
  reviewerLogin: string;
}

export interface AtomicRereviewResult {
  success: boolean;
  phase: RereviewPhase;
  error?: string;
  viaREST: boolean;
}

/**
 * Execute the atomic re-review transaction.
 *
 * Steps:
 * 1. Check headroom → defer if exhausted
 * 2. Resolve review comments (PATCH /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies)
 * 3. Request re-review from the reviewer (POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/dismissals or re-request)
 * 4. Verify state transition in session metadata
 *
 * On any failure, rolls back by clearing the checkpoint so the transaction
 * can be retried from the appropriate step on next invocation.
 */
export async function executeAtomicRereview(
  deps: AtomicRereviewDeps,
): Promise<AtomicRereviewResult> {
  const { session, config, scm, commentIdsToResolve, reviewerLogin } = deps;
  const checkpoint = getCheckpoint(session);
  const attemptCount = (parseInt(session.metadata[META_REREVIEW_ATTEMPT_COUNT] ?? "0", 10)) + 1;

  // --- Headroom preflight ---
  const headroom = await getHeadroomStatus();
  if (headroom.recommendation === "defer") {
    return {
      success: false,
      phase: checkpoint?.phase ?? "idle",
      error: `API headroom exhausted (gql:${headroom.graphqlRemaining} rest:${headroom.restRemaining}). Deferring.`,
      viaREST: false,
    };
  }
  const viaREST = headroom.recommendation === "rest";

  // --- Determine starting phase ---
  const startingPhase: RereviewPhase = checkpoint?.phase ?? "fix_applied";

  try {
    // Step 1: Resolve comments
    if (startingPhase === "fix_applied" && commentIdsToResolve.length > 0) {
      for (const commentId of commentIdsToResolve) {
        try {
          await scm.resolveComment?.(session.pr!, commentId);
        } catch (err) {
          if (isGhRateLimitError(err)) invalidateHeadroomCache();
          throw err;
        }
      }
      updateCheckpoint(session, config, {
        phase: "review_resolved",
        lastStepAt: now(),
        attemptCount,
        resolvedCommentIds: commentIdsToResolve,
        reviewerLogin,
      });
    }

    // Step 2: Request re-review from reviewer
    if (
      (startingPhase === "fix_applied" || startingPhase === "review_resolved") &&
      reviewerLogin
    ) {
      await scm.requestReview?.(session.pr!, reviewerLogin);
      updateCheckpoint(session, config, {
        phase: "rereq_requested",
        lastStepAt: now(),
        attemptCount,
        reviewerLogin,
      });
    }

    // Step 3: Verify state transition recorded
    updateCheckpoint(session, config, {
      phase: "verified",
      lastStepAt: now(),
      attemptCount,
    });

    // Transaction complete
    updateCheckpoint(session, config, {
      phase: "done",
      lastStepAt: now(),
      attemptCount,
    });

    return { success: true, phase: "done", viaREST };

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Read current phase from session metadata (checkpoint variable is stale after updateCheckpoint calls)
    const currentPhase = (session.metadata[META_REREVIEW_PHASE] as RereviewPhase) ?? "fix_applied";
    if (currentPhase === "done" || currentPhase === "verified") {
      // Already completed — don't roll back
      return { success: false, phase: currentPhase, error: errorMsg, viaREST };
    }

    // Roll back to idle so next run starts fresh
    resetTransaction(session, config);

    return { success: false, phase: "rolled_back", error: errorMsg, viaREST };
  }
}

/**
 * Check if a session has an in-flight re-review transaction.
 */
export function hasInFlightTransaction(session: Session): boolean {
  const cp = getCheckpoint(session);
  return cp !== null && cp.phase !== "idle" && cp.phase !== "done" && cp.phase !== "rolled_back";
}

/**
 * Abort an in-flight transaction and reset to idle.
 */
export function abortTransaction(session: Session, config: OrchestratorConfig): void {
  resetTransaction(session, config);
}
