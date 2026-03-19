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
    [ciStatus, mergeability, reviews, automatedComments, pendingComments] =
      await Promise.all([
        scm.getCISummary(pr),
        scm.getMergeability(pr),
        scm.getReviews(pr),
        scm.getAutomatedComments(pr),
        scm.getPendingComments(pr),
      ]);
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

  // 3. CodeRabbit approved — check the latest decisive review (not just any approval)
  const latestCR = getLatestDecisiveReview(reviews, "coderabbitai[bot]");
  const crApproved = latestCR?.state === "approved";
  checks.push({
    name: "CodeRabbit approved",
    passed: crApproved,
    detail: crApproved
      ? "CodeRabbit approved"
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
