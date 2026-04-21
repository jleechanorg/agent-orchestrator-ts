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

export function escapeRegexLiteral(token: string): string {
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

export function hasSkepticRequestId(body: string, requestId?: string): boolean {
  if (!requestId) return false;
  const escapedRequestId = escapeRegexLiteral(requestId);
  return new RegExp(
    `<!--\\s*skeptic-request-id-${escapedRequestId}\\s*-->`,
    "i",
  ).test(body);
}

export function hasSkepticHeadSha(body: string, headSha: string | undefined): boolean {
  if (!headSha) return false;
  const escapedSha = escapeRegexLiteral(headSha);
  return new RegExp(`<!--\\s*skeptic-head-sha-${escapedSha}\\s*-->`, "i").test(body);
}

export function hasCompletePassingGateMarkers(body: string): boolean {
  for (let gate = 1; gate <= 8; gate += 1) {
    const gateRe = new RegExp(`<!--\\s*skeptic-gate-${gate}\\s*:\\s*PASS\\s*-->`, "i");
    if (!gateRe.test(body)) return false;
  }
  return true;
}

export function extractSkepticGateMarkers(body: string): string[] {
  return Array.from(
    body.matchAll(/<!--\s*skeptic-gate-[1-8]\s*:\s*(?:PASS|FAIL|SKIPPED)\s*-->/gi),
    (match) => match[0],
  );
}

export function isFreshPassVerdictContractSatisfied(
  body: string,
  headSha: string | undefined,
  requestId?: string,
): boolean {
  return (
    hasSkepticRequestId(body, requestId) &&
    hasSkepticHeadSha(body, headSha) &&
    hasCompletePassingGateMarkers(body)
  );
}

export interface BoundVerdictOutput {
  verdictLine: string;
  llmOutput: string;
  verdictType: Verdict | null;
}

export function bindVerdictOutput(params: {
  llmOutput: string;
  headSha?: string;
  requestId?: string;
}): BoundVerdictOutput {
  const verdictMatch = params.llmOutput.match(VERDICT_LINE_RE);
  if (!verdictMatch) {
    const verdictLine = "VERDICT: FAIL — could not parse LLM output (expected VERDICT: PASS/FAIL/SKIPPED)";
    return {
      verdictLine,
      llmOutput: `${params.llmOutput}\n\n${verdictLine}`,
      verdictType: null,
    };
  }

  const verdictType = verdictMatch[1].toUpperCase() as Verdict;
  // Fail-closed: downgrade PASS to FAIL when the LLM output lacks all 8 gate markers.
  // The requestId/headSha checks were dropped — they were always undefined when
  // --request-id is not passed, causing incorrect downgrade of every PASS verdict.
  // Gate markers are the authoritative PASS contract: the LLM must emit all 8.
  const downgradedPass = verdictType === "PASS" && !hasCompletePassingGateMarkers(params.llmOutput);
  const verdictLine = downgradedPass
    ? "VERDICT: FAIL — PASS missing complete skeptic gate table or request binding"
    : verdictMatch[0];
  return {
    verdictLine,
    llmOutput: verdictLine === verdictMatch[0] ? params.llmOutput : `${params.llmOutput}\n\n${verdictLine}`,
    verdictType: downgradedPass ? "FAIL" : verdictType,
  };
}

/** Map a raw VERDICT token to a chalk color name (mirrors skeptic.ts lines 130-132). */
export function getVerdictColor(verdictType: string): "green" | "yellow" | "red" {
  if (verdictType === "PASS") return "green";
  if (verdictType === "SKIPPED") return "yellow";
  return "red";
}