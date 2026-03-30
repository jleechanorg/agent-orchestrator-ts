/**
 * Shared verdict parsing utilities.
 * Exported so skeptic.ts and tests can both import the same symbols
 * instead of duplicating the logic.
 */

/** Line-anchored VERDICT matcher — accepts VERDICT: PASS, VERDICT: FAIL, or VERDICT: SKIPPED.
 * Handles three variants:
 *   - plain:          VERDICT: PASS
 *   - blockquote:     > **VERDICT: SKIPPED**  (skeptic-gate.yml SKIPPED fallback)
 *   - markdown-bold:  **VERDICT: FAIL**       (LLM output with bold) */
export const VERDICT_LINE_RE = /^(?:> ?)?\*?\*?VERDICT:\s*(PASS|FAIL|SKIPPED)\b/im;

export type Verdict = "PASS" | "FAIL" | "SKIPPED";

/** Map a raw VERDICT token to a chalk color name (mirrors skeptic.ts lines 130-132). */
export function getVerdictColor(verdictType: string): "green" | "yellow" | "red" {
  if (verdictType === "PASS") return "green";
  if (verdictType === "SKIPPED") return "yellow";
  return "red";
}

/** bd-kvvx: fail-closed gate 3 enforcement.
 *
 * The LLM prompt instructs gate 3 (CR APPROVED) but the model can still issue
 * PASS when CR has only COMMENTED or CHANGES_REQUESTED. This overrides to FAIL.
 *
 * Returns { finalVerdict, wasOverridden, llmOutput } where:
 *   - finalVerdict: clean FAIL message (no appended original — preserves the verdict line cleanly)
 *   - wasOverridden: whether gate-3 override fired
 *   - llmOutput: original LLM output for separate display/posting (never lost)
 */
export function applyGate3Override(params: {
  llmVerdict: string;
  crApproved: boolean;
  crState: string;
  crDismissedWithoutApproval: boolean;
}): { finalVerdict: string; wasOverridden: boolean; llmOutput: string } {
  const { llmVerdict, crApproved, crState, crDismissedWithoutApproval } = params;
  if (!crApproved) {
    const parsed = llmVerdict.match(VERDICT_LINE_RE);
    const raw = parsed?.[1]?.toUpperCase();
    if (raw !== "FAIL") {
      const crDetail = crDismissedWithoutApproval
        ? `${crState} + DISMISSED_WITHOUT_APPROVAL`
        : crState;
      return {
        finalVerdict:
          "VERDICT: FAIL — Gate 3 (CR APPROVED) not satisfied. " +
          `CR review state: ${crDetail}. ` +
          "This is a hard requirement — no PASS is possible without CR APPROVED.",
        wasOverridden: true,
        llmOutput: llmVerdict,
      };
    }
  }
  return { finalVerdict: llmVerdict, wasOverridden: false, llmOutput: llmVerdict };
}
