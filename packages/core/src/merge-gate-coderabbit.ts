/**
 * CodeRabbit-specific merge gate extensions.
 *
 * These helpers evaluate CodeRabbit review state for the merge gate.
 * Splitting them into a companion module keeps merge-gate.ts orchestration-only
 * and allows focused testing of the CR-specific logic.
 *
 * Uses the canonical `Review` interface from types.ts so that the local type
 * declaration does not shadow the upstream definition with a weaker shape.
 */

import type { Review } from "./types.js";

// Re-export so callers can use the canonical type through this module's surface
export type { Review };

/** Sort comparator: newest-first by submittedAt. Exported for reuse by both helpers. */
export function sortReviewsNewestFirst(a: Review, b: Review): number {
  return b.submittedAt.getTime() - a.submittedAt.getTime();
}

/**
 * Return the most recent non-dismissed, non-pending review from the given author.
 * Ignores "dismissed", "commented", and "pending" states.
 */
export function getLatestDecisiveReview(reviews: Review[], author: string): Review | null {
  return (
    reviews
      .filter(
        (r) =>
          r.author === author &&
          (r.state === "approved" || r.state === "changes_requested"),
      )
      .sort(sortReviewsNewestFirst)[0] ?? null
  );
}

/**
 * Detect if a CodeRabbit review was dismissed without a subsequent real APPROVED
 * review replacing it. When GitHub dismisses a CHANGES_REQUESTED review, the review's
 * state transitions to "dismissed" (it is NOT deleted). The getLatestDecisiveReview
 * filter skips "dismissed" entries, so a dismissed CHANGES_REQUESTED would be
 * invisible — potentially letting the gate pass on nothing.
 *
 * Scan chronologically (newest → oldest):
 *   - If we hit "dismissed" before any "approved": the dismissal was not followed
 *     by a real re-review → return true (blocked).
 *   - If we hit "approved" before any "dismissed": dismissal was superseded → return false.
 *
 * NOTE: non-dismissed, non-approved states (e.g. "changes_requested") are handled
 * separately by getLatestDecisiveReview; this helper only detects unresolved dismissals.
 * The combined gate rule requires both:
 *   (a) hasUnresolvedDismissedReview == false  AND
 *   (b) latestDecisiveReview?.state == "approved"
 */
export function hasUnresolvedDismissedReview(
  reviews: Review[],
  author: string,
): boolean {
  const crReviews = reviews.filter((r) => r.author === author);
  if (crReviews.length === 0) return false;

  // Sort newest-first (reuses sortReviewsNewestFirst)
  const sorted = [...crReviews].sort(sortReviewsNewestFirst);

  for (const review of sorted) {
    if (review.state === "dismissed") return true;
    if (review.state === "approved") return false;
  }
  return false;
}

/**
 * Evaluate the CodeRabbit review condition for the merge gate.
 *
 * Returns { passed, detail } where:
 *   - passed is true only when the latest decisive CR review is "approved"
 *     AND no dismissed CHANGES_REQUESTED without a subsequent real approval exists.
 *   - detail explains the current state.
 */
export function evaluateCoderabbitApproval(
  reviews: Review[],
): { passed: boolean; detail: string } {
  const latestCR = getLatestDecisiveReview(reviews, "coderabbitai[bot]");
  const hasDismissed = hasUnresolvedDismissedReview(reviews, "coderabbitai[bot]");
  const passed = latestCR?.state === "approved" && !hasDismissed;

  const detail = passed
    ? "CodeRabbit approved"
    : latestCR?.state === "changes_requested"
      ? "CodeRabbit requested changes"
      : hasDismissed
        ? "CodeRabbit review was dismissed without a subsequent approval"
        : "No CodeRabbit approval found";

  return { passed, detail };
}
