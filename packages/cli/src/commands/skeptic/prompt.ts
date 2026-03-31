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
    : "(see Rule 10)";

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
    "2. CR APPROVED means review state=APPROVED with body_len>0, OR body_len=0 with CR posting 'all good'/'✅'/'No actionable comments' AFTER the APPROVED.",
    "3. CR COMMENTED is NOT approval. CR CHANGES_REQUESTED is NOT approval.",
    "4. A dismissed CR review without a subsequent real APPROVED review is a blocker.",
    "5. Bugbot errors always block merge.",
    "6. Unresolved Major/Critical inline comments always block merge (nitpicks excluded).",
    "7. If CI is still in_progress at merge time, that is a gap even if the PR is already merged.",
    "8. If CR posted CHANGES_REQUESTED and it was never addressed, that is a gap even if CR later APPROVED.",
    "9. If CR's most recent state is CHANGES_REQUESTED and the review body says 'REQUEST CHANGES', that is a gap.",
    "10. ALWAYS evaluate evidence authenticity in the PR body's ## Evidence section:",
    "    - FAIL if evidence contains 'simulated', 'example.com', '<screenshot path>', '<value>', 'TODO', 'TBD'",
    "    - FAIL if a coverage claim (unit test coverage) has no percentage numbers (e.g. '97%', '85%')",
    "    - FAIL if the evidence section is empty or contains only template placeholders",
    "    - PASS if evidence shows real command output, real test results, or real screenshots with non-placeholder URLs",
    "    - NOTE: Gate 6 (evidence-review-bot) is a separate pass/fail gate from your authenticity check. Gate 6 may be skipped depending on project configuration.",
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
    "--- GOALS SECTION VERIFICATION (Rule 12) ---",
    "12. GOALS SECTION VERIFICATION — systematic per-goal check:",
    "    If the PR description contains a '## Goals' or '## Goal' section with bullet or numbered items:",
    "    12a. Extract each bullet/numbered item from the Goals section",
    "    12b. For each goal bullet, verify there is diff evidence (code, config, workflow, or other changes) implementing it",
    "    12c. FAIL if any goal bullet has NO corresponding implementation in the diff",
    "    12d. For feature/bugfix goals, a goal with only test changes is NOT implemented (tests prove behavior, not create it). Goals explicitly about adding or updating tests CAN be satisfied by test changes.",
    "    12e. A goal about documentation only requires doc changes — no code changes needed",
    "    When flagging Rule 12 gaps, quote the specific goal bullet and explain what diff evidence you expected",
    "    NOTE: If PR has no Goals section, skip this rule (it's not mandatory to have Goals sections)",
    "",
    "OUTPUT FORMAT:",
    "",
    "// PASS — output brief confirmation only, no structured sections:",
    "VERDICT: PASS — [one sentence stating why the PR passes]",
    "--- // END PASS",
    "",
    "// FAIL — must include all four required sections in this exact order:",
    "## Background",
    "PR #[PR_NUMBER]: [title] — [what the PR claims to do]",
    "",
    "## Current Problem",
    "[Root cause — specific file, function, failure mode. Be concrete: 'function X in file Y uses stale cache' not 'cache issue']",
    "",
    "## Recommended Solution",
    "1. [Step 1 — specific and actionable]",
    "2. [Step 2]",
    "",
    "## Bot Consultation",
    "@coderabbitai — agree with this analysis?",
    "@cursor[bot] — does bugbot scan show the same?",
    "",
    "// Optional appendix sections — append after ## Bot Consultation if the corresponding rule has gaps:",
    "// ## Design Alignment     (include when Rule 11 gaps are found)",
    "// ## Goals Verification   (include when Rule 12 gaps are found)",
    "",
    "VERDICT: FAIL",
    "",
    "Be specific. 'The code looks fine' is NOT a valid PASS.",
    "Find at least one concrete gap before declaring FAIL.",
    "If every check genuinely passes, say so and explain why.",
    "--- PR CONTEXT ---",
    summary,
    prDescriptionSection,
    designDocSection,
  ].join("\n");
}
