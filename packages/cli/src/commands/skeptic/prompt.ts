/**
 * Skeptic prompt builder — constructs the skeptical LLM evaluation prompt.
 * Single responsibility: given PR state + diff, produce evaluation prompt.
 */

import type { PRInfo, ReviewInfo } from "./gh-client.js";
import type { MergeGateState } from "./mergeGate.js";

export function buildSkepticPrompt(
  pr: PRInfo,
  state: MergeGateState,
  diff: string,
  reviews: ReviewInfo[],
): string {
  const crDetail = state.crDismissedWithoutApproval
    ? `${state.crState} + DISMISSED_WITHOUT_APPROVAL`
    : state.crState;

  const unresolvedLabel =
    state.unresolvedBlockingComments > 0
      ? `FAIL (${state.unresolvedBlockingComments} blocking)`
      : "PASS";

  const evidenceLabel = state.evidenceRequired
    ? state.evidenceApproved
      ? "PASS"
      : "FAIL"
    : "N/A (not required)";

  const summary = [
    `PR #${pr.number}: ${pr.title}`,
    `State: ${pr.state} | Draft: ${pr.isDraft}`,
    `Base: ${pr.baseRefName}`,
    "",
    "--- 7-GREEN STATUS ---",
    `  1. CI green:            ${state.ciPassing ? "PASS" : "FAIL"}`,
    `  2. No merge conflicts:  ${state.noConflicts ? "PASS" : "FAIL"}`,
    `  3. CR APPROVED:         ${state.crApproved ? "PASS" : "FAIL"} (state: ${crDetail})`,
    `  4. Bugbot clean:        ${state.bugbotErrors === 0 ? "PASS" : "FAIL"} (errors: ${state.bugbotErrors})`,
    `  5. Comments resolved:   ${unresolvedLabel} (nitpick comments excluded, per checkMergeGate)`,
    `  6. Evidence review:    ${evidenceLabel}`,
    `  7. Skeptic verdict:     ${state.skepticVerdict ?? "not posted yet"}`,
    "",
    "--- RECENT REVIEWS (chronological) ---",
    ...reviews
      .slice(0, 8)
      .sort(
        (a, b) =>
          new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime(),
      )
      .map(
        (r) =>
          `[${r.submittedAt.slice(0, 16)}] ${r.author?.login} (${r.state}): ${(r.body ?? "(no body)").slice(0, 200)}`,
      ),
    "",
    "--- DIFF (first 300 lines) ---",
    diff.slice(0, 12_000),
  ].join("\n");

  return [
    "You are a Skeptic QA Agent. Your job is to FIND GAPS in this PR.",
    "INVERTED INCENTIVE: You are rewarded for finding missing evidence.",
    "A false PASS is YOUR failure. A thorough FAIL report is success.",
    "",
    "RULES:",
    "1. Verify each of the 7-green conditions independently — do not trust the status summary alone.",
    "2. CR APPROVED means review state=APPROVED with body_len>0, OR body_len=0 with CR posting 'all good'/'✅'/'No actionable comments' AFTER the APPROVED.",
    "3. CR COMMENTED is NOT approval. CR CHANGES_REQUESTED is NOT approval.",
    "4. A dismissed CR review without a subsequent real APPROVED review is a blocker.",
    "5. Bugbot errors always block merge.",
    "6. Unresolved Major/Critical inline comments always block merge (nitpicks excluded).",
    "7. If CI is still in_progress at merge time, that is a gap even if the PR is already merged.",
    "8. If CR posted CHANGES_REQUESTED and it was never addressed, that is a gap even if CR later APPROVED.",
    "9. If CR's most recent state is CHANGES_REQUESTED and the review body says 'REQUEST CHANGES', that is a gap.",
    "10. Evidence review is required only when config requires it; default is N/A.",
    "",
    "OUTPUT FORMAT:",
    "VERDICT: PASS — All 7-green conditions genuinely satisfied",
    "OR",
    "VERDICT: FAIL — Missing: [specific list of gaps, be concrete]",
    "",
    "Be specific. 'The code looks fine' is NOT a valid PASS.",
    "Find at least one concrete gap before declaring FAIL.",
    "If every check genuinely passes, say so and explain why.",
    "",
    "--- PR CONTEXT ---",
    summary,
  ].join("\n");
}
