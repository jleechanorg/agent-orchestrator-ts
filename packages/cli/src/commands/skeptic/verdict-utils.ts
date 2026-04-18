/**
 * Shared verdict parsing utilities.
 * Exported so skeptic.ts and tests can both import the same symbols
 * instead of duplicating the logic.
 */

export type Verdict = "PASS" | "FAIL" | "SKIPPED";

const VERDICT_LINE_PREFIX =
  String.raw`^[ \t]*(?:> ?)?(?:#{1,6}[ \t]*)?(?:\*{1,2})?VERDICT:[ \t]*`;
const VERDICT_LINE_SUFFIX =
  String.raw`(?:\*{1,2})?[ \t]*(?:[-—:].*)?$`;

function escapeRegexLiteral(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildVerdictLineRe(verdicts: readonly string[]): RegExp {
  return new RegExp(
    `${VERDICT_LINE_PREFIX}(${verdicts.map(escapeRegexLiteral).join("|")})${VERDICT_LINE_SUFFIX}`,
    "im",
  );
}

/** Line-anchored VERDICT matcher — accepts VERDICT: PASS, VERDICT: FAIL, or VERDICT: SKIPPED.
 * Handles four variants:
 *   - plain:          VERDICT: PASS
 *   - blockquote:     > **VERDICT: SKIPPED**  (skeptic-gate.yml SKIPPED fallback)
 *   - markdown-bold:  **VERDICT: FAIL**       (LLM output with bold)
 *   - markdown-hdr:   ## VERDICT: FAIL        (LLM output with ATX headers — bd-qcwl) */
/** Shared VERDICT matcher for GitHub comment parsing — accepts SKIPPED.
 * Unlike llm-eval.ts's STRICT_VERDICT_RE (which only accepts PASS|FAIL), this regex
 * is used for parsing LLM output that may contain "VERDICT: SKIPPED" — which the
 * model emits when it cannot reach a decision. The SKIPPED path exits 0 in
 * skeptic-gate.yml so infra failures don't block cron; SKIPPED in llm-eval.ts's
 * strict chain is treated as missing-a-verdict and triggers fail-closed fallback.
 * These are two separate concerns (parsing vs. strict internal validation). */
export const VERDICT_LINE_RE = buildVerdictLineRe(["PASS", "FAIL", "SKIPPED"]);

/** Map a raw VERDICT token to a chalk color name (mirrors skeptic.ts lines 130-132). */
export function getVerdictColor(verdictType: string): "green" | "yellow" | "red" {
  if (verdictType === "PASS") return "green";
  if (verdictType === "SKIPPED") return "yellow";
  return "red";
}
