/**
 * Skeptic prompt builder — constructs the skeptical LLM evaluation prompt.
 * Single responsibility: given PR state + diff, produce evaluation prompt.
 */

import type { PRInfo, ReviewInfo } from "./gh-client.js";
import type { MergeGateState } from "./mergeGate.js";

// Truncation limits for content included in the skeptic prompt
const MAX_DESIGN_DOC_CHARS = 6_000;
const MAX_PR_DESCRIPTION_CHARS = 4_000;
const MAX_DIFF_CHARS = 12_000;
const MAX_REVIEW_BODY_CHARS = 200;
const MAX_REVIEWS_TO_SHOW = 8;

export function buildSkepticPrompt(
  pr: PRInfo,
  state: MergeGateState,
  diff: string,
  reviews: ReviewInfo[],
  designDoc: string | null,
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

  const designDocSection = designDoc
    ? [
        "",
        "--- DESIGN DOC (docs/design/pr-designs/pr-" + pr.number + ".md) ---",
        designDoc.slice(0, MAX_DESIGN_DOC_CHARS),
      ].join("\n")
    : [
        "",
        "--- DESIGN DOC ---",
        "DESIGN DOC NOT FOUND for this PR. The generate-pr-design-docs.yml workflow",
        "should have generated one on PR open. If no design doc exists, flag this as a gap.",
      ].join("\n");

  const prDescriptionSection = pr.body
    ? [
        "",
        "--- PR DESCRIPTION ---",
        pr.body.slice(0, MAX_PR_DESCRIPTION_CHARS),
      ].join("\n")
    : "";

  const summary = [
    `PR #${pr.number}: ${pr.title}`,
    `State: ${pr.state} | Draft: ${pr.isDraft}`,
    `Base: ${pr.baseRefName}`,
    "",
    "--- 7-GREEN STATUS ---",
    `  1. CI green:            ${state.ciPassing ? "PASS" : "FAIL"} (raw commit status state: "${state.ciRawState}")`,
    ...(state.checkRuns && state.checkRuns.length > 0
      ? [`     Check runs: ${state.checkRuns.map(r => `${r.name}=${r.conclusion ?? r.status}`).join(", ")}`]
      : []),
    `  2. No merge conflicts:  ${state.noConflicts ? "PASS" : "FAIL"} (raw mergeable: ${state.mergeableRaw === null ? "null/unknown" : state.mergeableRaw})`,
    `  3. CR APPROVED:         ${state.crApproved ? "PASS" : "FAIL"} (state: ${crDetail}${state.crChatApproval ? " | chat_approval=YES (CR posted [approve]/READY FOR MERGE)" : ""})`,
    `  4. Bugbot clean:        ${state.bugbotErrors === 0 ? "PASS" : "FAIL"} (errors: ${state.bugbotErrors})`,
    `  5. Comments resolved:   ${unresolvedLabel} (nitpick comments excluded, per checkMergeGate)`,
    `  6. Evidence review:    ${evidenceLabel}`,
    `  7. Skeptic verdict:     ${state.skepticVerdict ?? "not posted yet"}`,
    "",
    "--- RECENT REVIEWS (chronological) ---",
    ...reviews
      .slice(0, MAX_REVIEWS_TO_SHOW)
      .sort(
        (a, b) =>
          new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime(),
      )
      .map(
        (r) =>
          `[${r.submittedAt.slice(0, 16)}] ${r.author?.login} (${r.state}): ${(r.body ?? "(no body)").slice(0, MAX_REVIEW_BODY_CHARS)}`,
      ),
    "",
    "--- DIFF (first 300 lines) ---",
    diff.slice(0, MAX_DIFF_CHARS),
  ].join("\n");

  return [
    "You are a Skeptic QA Agent. Your job is to FIND GAPS in this PR.",
    "INVERTED INCENTIVE: You are rewarded for finding missing evidence.",
    "A false PASS is YOUR failure. A thorough FAIL report is success.",
    "",
    "RULES:",
    "1. Verify each of the 7-green conditions independently — do not trust the status summary alone.",
    "2. CR APPROVED means: (a) review state=APPROVED, OR (b) review state=COMMENTED/none AND CR has posted a PR/issue comment containing 'READY FOR MERGE' or '[approve]' AFTER its latest review AND unresolvedBlockingComments=0 AND no CHANGES_REQUESTED in CR review history (CR incremental review deadlock bypass — CR formal APPROVED is broken after rebases; it approves via chat comment instead). If the status shows 'chat_approval=YES', treat CR as APPROVED.",
    "3. CR COMMENTED alone (without an explicit [approve]/READY FOR MERGE chat comment) is NOT approval. CR CHANGES_REQUESTED is NOT approval.",
    "4. A dismissed CR review without a subsequent real APPROVED review is a blocker.",
    "5. Bugbot errors always block merge.",
    "6. Unresolved Major/Critical inline comments always block merge (nitpicks excluded).",
    "7. If CI is still in_progress at merge time, that is a gap even if the PR is already merged.",
    "8. If CR posted CHANGES_REQUESTED and it was never addressed, that is a gap even if CR later APPROVED.",
    "9. If CR's most recent state is CHANGES_REQUESTED and the review body says 'REQUEST CHANGES', that is a gap.",
    "10. Evidence review is required only when config requires it; default is N/A.",
    "",
    "--- DESIGN ALIGNMENT CHECK (Rule 11) ---",
    "IMPORTANT: The design doc is auto-generated from this PR's metadata and diff",
    "(via generate-pr-design-docs.yml). It is NOT an independent specification.",
    "Your job is to use it as a starting point — verify its accuracy against the diff",
    "and PR description, and flag any discrepancies or omissions.",
    "",
    "You MUST check that the code diff aligns with what the design doc and PR description claim.",
    "Specifically check:",
    "  11a. If the design doc says 'adds X package/file', verify the diff adds it.",
    "  11b. If the PR description says 'fixes Y bug', verify the diff contains the fix.",
    "  11c. If the design doc describes a new capability, verify the diff implements it.",
    "  11d. If the diff changes a file that the design doc/PR description does not mention, flag it as unexplained.",
    "  11e. If functionality described in the design doc is absent from the diff, flag it as missing.",
    "Gap examples that Rule 11 catches:",
    "  - Design doc says 'adds agent-foo plugin' but no new plugin file exists in the diff",
    "  - PR description says 'fixes auth token expiry bug' but no auth-related code is changed",
    "  - Design doc shows a new API endpoint but the diff only touches tests",
    "When flagging Rule 11 gaps, quote the specific design doc claim and the corresponding diff gap.",
    "If no design doc exists, flag it as a gap (Rule 11f: missing design doc).",
    "",
    "OUTPUT FORMAT:",
    "VERDICT: PASS — All 7-green conditions genuinely satisfied",
    "OR",
    "VERDICT: FAIL — Missing: [specific list of gaps, be concrete]",
    "",
    "Include a '## Design Alignment' section in your FAIL report when Rule 11 gaps are found.",
    "",
    "Be specific. 'The code looks fine' is NOT a valid PASS.",
    "Find at least one concrete gap before declaring FAIL.",
    "If every check genuinely passes, say so and explain why.",
    "",
    "--- PR CONTEXT ---",
    summary,
    prDescriptionSection,
    designDocSection,
  ].join("\n");
}
