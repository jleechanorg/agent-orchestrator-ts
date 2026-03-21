/**
 * CodeRabbit-specific merge gate extensions.
 *
 * These helpers evaluate CodeRabbit review state for the merge gate.
 * Splitting them into a companion module keeps merge-gate.ts orchestration-only
 * and allows focused testing of the CR-specific logic.
 */

export type Review = { author: string; state: string; submittedAt?: Date };

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
      .sort(
        (a, b) =>
          new Date(b.submittedAt ?? 0).getTime() -
          new Date(a.submittedAt ?? 0).getTime(),
      )[0] ?? null
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

  // Sort newest-first
  const sorted = [...crReviews].sort(
    (a, b) =>
      new Date(b.submittedAt ?? 0).getTime() -
      new Date(a.submittedAt ?? 0).getTime(),
  );

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
    : hasDismissed
      ? "CodeRabbit review was dismissed without a subsequent approval"
      : latestCR?.state === "changes_requested"
        ? "CodeRabbit requested changes"
        : "No CodeRabbit approval found";

  return { passed, detail };
}
