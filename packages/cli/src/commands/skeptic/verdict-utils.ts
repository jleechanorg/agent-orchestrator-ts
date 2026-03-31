/**
 * Shared verdict parsing utilities.
 * Exported so skeptic.ts and tests can both import the same symbols
 * instead of duplicating the logic.
 */

/** Line-anchored VERDICT matcher — accepts VERDICT: PASS, VERDICT: FAIL, or VERDICT: SKIPPED.
 * Handles four variants:
 *   - plain:          VERDICT: PASS
 *   - blockquote:     > **VERDICT: SKIPPED**  (skeptic-gate.yml SKIPPED fallback)
 *   - markdown-bold:  **VERDICT: FAIL**       (LLM output with bold)
 *   - markdown-hdr:   ## VERDICT: FAIL        (LLM output with ATX headers — bd-qcwl) */
export const VERDICT_LINE_RE = /^(?:> ?)?(?:#{1,6}\s*)?\*?\*?VERDICT:\s*(PASS|FAIL|SKIPPED)\b/im;

export type Verdict = "PASS" | "FAIL" | "SKIPPED";

/** Map a raw VERDICT token to a chalk color name (mirrors skeptic.ts lines 130-132). */
export function getVerdictColor(verdictType: string): "green" | "yellow" | "red" {
  if (verdictType === "PASS") return "green";
  if (verdictType === "SKIPPED") return "yellow";
  return "red";
}
