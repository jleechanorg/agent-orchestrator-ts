/**
 * Claim Verifier — Skeptic Gate Assertion Verifier (bd-upxh)
 *
 * Enforces harness-level claim-verification for skeptic gate assertions:
 *   "no agent may report 'working' unless run-level AND comment-level evidence passes."
 *
 * Fail-closed: ambiguous → INSUFFICIENT / FAIL.
 *
 * Verification layers:
 *   1. Run-level evidence: VERDICT line in the skeptic CLI output (PASS/FAIL/SKIPPED)
 *   2. Comment-level evidence: GitHub PR comment with <!-- skeptic-agent-verdict --> marker
 *
 * Both layers must be present and consistent for PASS.
 * Any ambiguity → INSUFFICIENT (not PASS).
 */

import { VERDICT_LINE_RE } from "./verdict-utils.js";

/** Strict VERDICT match — PASS or FAIL only (SKIPPED is infra-only, not a claim) */
const CLAIM_VERDICT_RE = /^(?:> ?\*\*)?VERDICT:\s*(PASS|FAIL)\b/im;

/** HTML marker identifying skeptic agent verdict comments */
const SKEPTIC_COMMENT_MARKER_RE = /<!--\s*skeptic-agent-verdict\s*-->/i;

/**
 * Result of a single evidence-layer check.
 * @property "pass"    — evidence is present and passes the check
 * @property "fail"    — evidence is present but fails the check
 * @property "absent"  — no evidence found for this layer
 */
export type EvidenceResult = "pass" | "fail" | "absent";

export interface ClaimCheck {
  /** Short human-readable label */
  label: string;
  /** Result of the evidence check */
  result: EvidenceResult;
  /** Detail shown in the report */
  detail: string;
}

/**
 * Outcome of verifySkepticClaim().
 *
 * @property "PASS"        — Both run-level AND comment-level evidence present and consistent = PASS
 * @property "FAIL"        — Run-level or comment-level evidence is FAIL (verdict contradicts claim)
 * @property "INSUFFICIENT" — Ambiguous / missing evidence; cannot confirm PASS. FAIL-closed.
 *
 * INSUFFICIENT is returned when:
 *   - Run-level VERDICT is PASS but no GitHub comment exists
 *   - Run-level VERDICT is PASS but comment has no matching VERDICT line
 *   - No run-level VERDICT was produced (infra SKIPPED)
 *   - Run-level VERDICT contradicts what the PR body / claim asserts
 *   - Comment-level evidence is present but VERDICT type differs from run-level
 */
export interface ClaimVerificationResult {
  outcome: "PASS" | "FAIL" | "INSUFFICIENT";
  runLevel: ClaimCheck;
  commentLevel: ClaimCheck;
  /** Human-readable summary */
  summary: string;
  /**
   * Whether this result should block a 'working' status report.
   * INSUFFICIENT always blocks.
   */
  blocksWorking: boolean;
}

/**
 * Check one evidence layer — run-level (CLI output).
 *
 * @param llmOutput  — raw stdout from the LLM evaluation (skeptic CLI output)
 * @returns ClaimCheck for the run-level layer
 */
export function checkRunLevel(llmOutput: string): ClaimCheck {
  const trimmed = (llmOutput ?? "").trim();
  if (!trimmed) {
    return {
      label: "run-level",
      result: "absent",
      detail: "No CLI output — LLM evaluation did not run or produced no output",
    };
  }

  const m = trimmed.match(CLAIM_VERDICT_RE);
  if (!m) {
    // Check if it's a SKIPPED verdict — infra failure, not a claim verdict
    const skippedMatch = trimmed.match(VERDICT_LINE_RE);
    if (skippedMatch && skippedMatch[1]?.toUpperCase() === "SKIPPED") {
      return {
        label: "run-level",
        result: "absent",
        detail: `VERDICT: SKIPPED — infra failure, not a claim verdict: ${skippedMatch[0]}`,
      };
    }
    return {
      label: "run-level",
      result: "absent",
      detail: `No VERDICT: PASS/FAIL in CLI output (got: ${trimmed.slice(0, 80)}...)`,
    };
  }

  const verdict = m[1].toUpperCase() as "PASS" | "FAIL";
  return {
    label: "run-level",
    result: verdict === "PASS" ? "pass" : "fail",
    detail: `VERDICT: ${verdict} — ${m[0]}`,
  };
}

/**
 * Check one evidence layer — comment-level (GitHub PR comment).
 *
 * @param commentBody  — body of the skeptic-agent-verdict comment, or empty string if absent
 * @returns ClaimCheck for the comment-level layer
 */
export function checkCommentLevel(commentBody: string): ClaimCheck {
  const trimmed = (commentBody ?? "").trim();
  if (!trimmed) {
    return {
      label: "comment-level",
      result: "absent",
      detail: "No <!-- skeptic-agent-verdict --> comment found on the PR",
    };
  }

  if (!SKEPTIC_COMMENT_MARKER_RE.test(trimmed)) {
    return {
      label: "comment-level",
      result: "absent",
      detail: "Comment exists but lacks <!-- skeptic-agent-verdict --> marker",
    };
  }

  const m = trimmed.match(CLAIM_VERDICT_RE);
  if (!m) {
    // Check for SKIPPED in comment
    const skippedMatch = trimmed.match(VERDICT_LINE_RE);
    if (skippedMatch && skippedMatch[1]?.toUpperCase() === "SKIPPED") {
      return {
        label: "comment-level",
        result: "absent",
        detail: "Comment has SKIPPED verdict — infra failure, not a claim verdict",
      };
    }
    return {
      label: "comment-level",
      result: "absent",
      detail: "Comment lacks VERDICT: PASS/FAIL line",
    };
  }

  const verdict = m[1].toUpperCase() as "PASS" | "FAIL";
  return {
    label: "comment-level",
    result: verdict === "PASS" ? "pass" : "fail",
    detail: `VERDICT: ${verdict} in PR comment`,
  };
}

/**
 * Verify skeptic claim — both run-level AND comment-level evidence.
 *
 * Fail-closed:
 *   - PASS only when BOTH layers are "pass" (consistent PASS on both)
 *   - FAIL when either layer is "fail" (FAIL verdict contradicts claim)
 *   - INSUFFICIENT for any other combination (missing, ambiguous, or inconsistent)
 *
 * @param llmOutput     — raw stdout from the skeptic LLM evaluation
 * @param commentBody   — body of the GitHub verdict comment (empty = no comment)
 * @returns ClaimVerificationResult with outcome, per-layer checks, and blocksWorking flag
 */
export function verifySkepticClaim(
  llmOutput: string,
  commentBody: string,
): ClaimVerificationResult {
  const runLevel = checkRunLevel(llmOutput);
  const commentLevel = checkCommentLevel(commentBody);

  let outcome: "PASS" | "FAIL" | "INSUFFICIENT";
  let summary: string;

  // Decision matrix
  if (runLevel.result === "pass" && commentLevel.result === "pass") {
    outcome = "PASS";
    summary =
      "Both run-level and comment-level VERDICT: PASS — claim verified.";
  } else if (runLevel.result === "fail" || commentLevel.result === "fail") {
    outcome = "FAIL";
    const failLayer = runLevel.result === "fail" ? runLevel : commentLevel;
    summary = `FAIL verdict in ${failLayer.label} layer — claim contradicted: ${failLayer.detail}`;
  } else {
    // At least one layer is "absent" or inconsistent
    outcome = "INSUFFICIENT";
    const reasons: string[] = [];
    if (runLevel.result === "absent") reasons.push(runLevel.detail);
    if (commentLevel.result === "absent") reasons.push(commentLevel.detail);
    summary = `Insufficient evidence — cannot confirm PASS:\n  • ${reasons.join("\n  • ")}`;
  }

  return {
    outcome,
    runLevel,
    commentLevel,
    summary,
    // INSUFFICIENT always blocks; FAIL also blocks (verdict contradicts)
    blocksWorking: outcome !== "PASS",
  };
}


/**
 * Format a ClaimVerificationResult for terminal output.
 */
export function formatClaimVerification(result: ClaimVerificationResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("┌─ Claim Verification ──────────────────────────────────────────────");
  lines.push(`│ Run-level:     [${result.runLevel.result.toUpperCase().padEnd(8)}] ${result.runLevel.detail}`);
  lines.push(`│ Comment-level: [${result.commentLevel.result.toUpperCase().padEnd(8)}] ${result.commentLevel.detail}`);
  lines.push("├──────────────────────────────────────────────────────────────────");
  lines.push(
    `│ Outcome:       [${result.outcome.padEnd(8)}] ${result.summary.split("\n")[0]}`,
  );
  lines.push(
    result.outcome !== "PASS"
      ? `│ ⚠  blocks 'working' status report`
      : `│ ✓  claim verified — 'working' status permitted`,
  );
  lines.push("└──────────────────────────────────────────────────────────────────");
  return lines.join("\n");
}
