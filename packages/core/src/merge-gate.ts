/**
 * Merge Gate — 6-condition enforcement for PR merge readiness (bd-nrp)
 */

import type { PRInfo, MergeGateConfig, SCM } from "./types.js";

export interface MergeGateCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface MergeGateResult {
  passed: boolean;
  checks: MergeGateCheck[];
  blockers: string[];
}

function getLatestDecisiveReview(
  reviews: Array<{ author: string; state: string; submittedAt?: Date }>,
  author: string,
) {
  return reviews
    .filter(
      (r) =>
        r.author === author &&
        (r.state === "approved" || r.state === "changes_requested"),
    )
    .sort(
      (a, b) =>
        new Date(b.submittedAt ?? 0).getTime() -
        new Date(a.submittedAt ?? 0).getTime(),
    )[0] ?? null;
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
function hasUnresolvedDismissedReview(
  reviews: Array<{ author: string; state: string; submittedAt?: Date }>,
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
    // A non-dismissed, non-approved state (e.g. "changes_requested") is not approved
    // but also not a dismissal — keep scanning to see if there's a dismissed entry above.
    // Once we hit "approved" we know no dismissal is unresolved.
    if (review.state === "approved") return false;
  }
  return false;
}

export async function checkMergeGate(
  pr: PRInfo,
  config: MergeGateConfig,
  scm: SCM,
): Promise<MergeGateResult> {
  // Short-circuit when merge gate is disabled
  if (!config.enabled) {
    return { passed: true, checks: [], blockers: [] };
  }

  let ciStatus: string;
  let mergeability: { noConflicts: boolean; mergeable?: boolean };
  let reviews: Array<{ author: string; state: string; submittedAt?: Date }>;
  let automatedComments: Array<{ botName: string; severity: string; body: string }>;
  let pendingComments: Array<{ isResolved: boolean; body: string }>;

  try {
    const [ci, mergeabilityResult, reviewsResult, automatedCommentsResult, pendingCommentsResult] =
      await Promise.all([
        scm.getCISummary(pr),
        scm.getMergeability(pr),
        scm.getReviews(pr),
        scm.getAutomatedComments(pr),
        scm.getPendingComments(pr),
      ]);

    ciStatus = ci;
    mergeability = mergeabilityResult;
    reviews = reviewsResult ?? [];
    automatedComments = automatedCommentsResult ?? [];
    pendingComments = pendingCommentsResult ?? [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: "SCM query", passed: false, detail: `SCM query failed: ${message}` }],
      blockers: ["SCM query"],
    };
  }

  const checks: MergeGateCheck[] = [];

  // 1. CI green
  const ciPassing = ciStatus === "passing";
  checks.push({
    name: "CI green",
    passed: ciPassing,
    detail: ciPassing ? "CI is passing" : `CI status: ${ciStatus}`,
  });

  // 2. Mergeable (no conflicts)
  const noConflicts = mergeability.noConflicts;
  checks.push({
    name: "Mergeable",
    passed: noConflicts,
    detail: noConflicts ? "No merge conflicts" : "Merge conflicts detected",
  });

  // 3. CodeRabbit approved — requires:
  //   (a) latest decisive review is "approved"
  //   (b) no dismissed CHANGES_REQUESTED without a subsequent real APPROVED
  const latestCR = getLatestDecisiveReview(reviews, "coderabbitai[bot]");
  const hasDismissed = hasUnresolvedDismissedReview(reviews, "coderabbitai[bot]");
  const crApproved = latestCR?.state === "approved" && !hasDismissed;
  checks.push({
    name: "CodeRabbit approved",
    passed: crApproved,
    detail: crApproved
      ? "CodeRabbit approved"
      : hasDismissed
        ? "CodeRabbit review was dismissed without a subsequent approval"
        : latestCR?.state === "changes_requested"
          ? "CodeRabbit requested changes"
          : "No CodeRabbit approval found",
  });

  // 4. Bugbot clean — no error-severity comments from cursor bugbot
  const cursorBotPattern = /cursor\[bot\]/i;
  const bugbotErrors = automatedComments.filter(
    (c) => c.severity === "error" && cursorBotPattern.test(c.botName),
  );
  checks.push({
    name: "Bugbot clean",
    passed: bugbotErrors.length === 0,
    detail:
      bugbotErrors.length === 0
        ? "No Bugbot errors"
        : `${bugbotErrors.length} Bugbot error(s) found`,
  });

  // 5. Inline comments resolved — ignore nit/nitpick comments
  const nitPattern = /^(nit:|nitpick)/i;
  const unresolvedBlockingComments = pendingComments.filter(
    (c) => !c.isResolved && !nitPattern.test(c.body.trimStart()),
  );
  checks.push({
    name: "Inline comments resolved",
    passed: unresolvedBlockingComments.length === 0,
    detail:
      unresolvedBlockingComments.length === 0
        ? "All comments resolved"
        : `${unresolvedBlockingComments.length} unresolved comment(s)`,
  });

  // 6. Evidence review pass
  const evidenceRequired = config.requiredChecks?.includes("evidence-review");
  let evidencePassed = true;
  if (evidenceRequired) {
    const evidenceReview = getLatestDecisiveReview(reviews, "evidence-review-bot");
    evidencePassed = evidenceReview?.state === "approved";
  }
  checks.push({
    name: "Evidence review pass",
    passed: evidencePassed,
    detail: evidencePassed
      ? evidenceRequired
        ? "Evidence review approved"
        : "Evidence review not required"
      : "No evidence review approval found",
  });

  const blockers = checks.filter((c) => !c.passed).map((c) => c.name);

  return {
    passed: blockers.length === 0,
    checks,
    blockers,
  };
}
