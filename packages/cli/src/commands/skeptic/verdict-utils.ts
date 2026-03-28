/**
 * Shared verdict parsing utilities.
 * Exported so skeptic.ts and tests can both import the same symbols
 * instead of duplicating the logic.
 */

/** Line-anchored VERDICT matcher — accepts VERDICT: PASS/FAIL/SKIPPED with optional markdown prefix. */
export const VERDICT_LINE_RE = /^(?:#{1,3}\s*|\*{1,2})?VERDICT:\s*(PASS|FAIL|SKIPPED)\b/im;

export type Verdict = "PASS" | "FAIL" | "SKIPPED";

/** Map a raw VERDICT token to a chalk color name (mirrors skeptic.ts lines 130-132). */
export function getVerdictColor(verdictType: string): "green" | "yellow" | "red" {
  if (verdictType === "PASS") return "green";
  if (verdictType === "SKIPPED") return "yellow";
  return "red";
}
