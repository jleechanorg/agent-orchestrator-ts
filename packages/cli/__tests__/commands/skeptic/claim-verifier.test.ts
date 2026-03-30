/**
 * Unit tests for claim-verifier.ts (bd-upxh).
 *
 * Verifies harness-level claim-verification for skeptic gate assertions:
 * "no agent may report 'working' unless run-level AND comment-level evidence passes."
 *
 * Fail-closed: ambiguous → INSUFFICIENT / FAIL.
 */

import { describe, it, expect } from "vitest";
import {
  checkRunLevel,
  checkCommentLevel,
  verifySkepticClaim,
} from "../../../src/commands/skeptic/claim-verifier.js";

// ---------------------------------------------------------------------------
// checkRunLevel
// ---------------------------------------------------------------------------

describe("checkRunLevel", () => {
  it("returns pass when CLI output contains VERDICT: PASS", () => {
    const result = checkRunLevel("Some analysis\nVERDICT: PASS\nAll conditions met.");
    expect(result.result).toBe("pass");
    expect(result.label).toBe("run-level");
  });

  it("returns fail when CLI output contains VERDICT: FAIL", () => {
    const result = checkRunLevel("VERDICT: FAIL — Missing tests");
    expect(result.result).toBe("fail");
  });

  it("returns absent when CLI output is empty", () => {
    const result = checkRunLevel("");
    expect(result.result).toBe("absent");
  });

  it("returns absent when CLI output has no VERDICT line", () => {
    const result = checkRunLevel("The code looks fine to me.");
    expect(result.result).toBe("absent");
  });

  it("returns absent when CLI output has VERDICT: SKIPPED (infra failure)", () => {
    const result = checkRunLevel("VERDICT: SKIPPED — infra: Neither Codex nor Claude available.");
    expect(result.result).toBe("absent");
    expect(result.detail).toContain("SKIPPED");
  });

  it("is case-insensitive on VERDICT keyword", () => {
    const result = checkRunLevel("verdict: pass");
    expect(result.result).toBe("pass");
  });

  it("handles blockquote markdown format", () => {
    const result = checkRunLevel("> **VERDICT: PASS**");
    expect(result.result).toBe("pass");
  });

  it("handles markdown-bold format **VERDICT: PASS**", () => {
    // bold on both sides — must match despite CLAIM_VERDICT_RE being stricter than old pattern
    const result = checkRunLevel("**VERDICT: PASS**");
    expect(result.result).toBe("pass");
  });

  it("extracts PASS even with surrounding text", () => {
    const result = checkRunLevel("## Conclusion\nVERDICT: PASS — All checks pass\n");
    expect(result.result).toBe("pass");
  });

  it("returns absent for VERDICT: SKIP (no word boundary)", () => {
    // "SKIP" without the "PED" should not match — word boundary required
    const result = checkRunLevel("VERDICT: SKIP");
    expect(result.result).toBe("absent");
  });

  it("returns absent when output is only whitespace", () => {
    const result = checkRunLevel("   \n\t\n  ");
    expect(result.result).toBe("absent");
  });
});

// ---------------------------------------------------------------------------
// checkCommentLevel
// ---------------------------------------------------------------------------

describe("checkCommentLevel", () => {
  const passComment = `<!-- skeptic-agent-verdict -->
**🤖 Skeptic Agent Verdict (bd-qw6)**

VERDICT: PASS — All 7-green conditions satisfied.

_Posted by jleechan2015 · 2026-03-29T00:00:00Z_`;

  const failComment = `<!-- skeptic-agent-verdict -->
VERDICT: FAIL — Missing: evidence section, tests`;

  it("returns pass when comment has VERDICT: PASS with marker", () => {
    const result = checkCommentLevel(passComment);
    expect(result.result).toBe("pass");
    expect(result.label).toBe("comment-level");
  });

  it("returns fail when comment has VERDICT: FAIL with marker", () => {
    const result = checkCommentLevel(failComment);
    expect(result.result).toBe("fail");
  });

  it("returns absent when comment body is empty", () => {
    const result = checkCommentLevel("");
    expect(result.result).toBe("absent");
  });

  it("returns absent when marker is missing", () => {
    const result = checkCommentLevel("VERDICT: PASS\n<!-- not-the-right-marker -->");
    expect(result.result).toBe("absent");
  });

  it("returns absent when comment has SKIPPED verdict (infra)", () => {
    const result = checkCommentLevel(
      "<!-- skeptic-agent-verdict -->\nVERDICT: SKIPPED — infra unavailable",
    );
    expect(result.result).toBe("absent");
    expect(result.detail).toContain("SKIPPED");
  });

  it("returns absent when comment has no VERDICT line", () => {
    const result = checkCommentLevel("<!-- skeptic-agent-verdict -->\nAnalysis complete.");
    expect(result.result).toBe("absent");
  });

  it("is case-insensitive on marker", () => {
    const result = checkCommentLevel("<!-- SKEPTIC-AGENT-VERDICT -->\nVERDICT: PASS");
    expect(result.result).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// verifySkepticClaim — decision matrix
// ---------------------------------------------------------------------------

describe("verifySkepticClaim — decision matrix", () => {
  const llmPASS = "VERDICT: PASS\nAll checks pass.";
  const llmFAIL = "VERDICT: FAIL\nMissing evidence.";
  const llmSKIPPED = "VERDICT: SKIPPED — infra: Codex unavailable.";
  const llmEmpty = "";
  const commentPASS = "<!-- skeptic-agent-verdict -->\nVERDICT: PASS";
  const commentFAIL = "<!-- skeptic-agent-verdict -->\nVERDICT: FAIL";
  const commentEmpty = "";

  // PASS — both layers consistent PASS
  it("returns PASS when run-level PASS and comment-level PASS", () => {
    const result = verifySkepticClaim(llmPASS, commentPASS);
    expect(result.outcome).toBe("PASS");
    expect(result.blocksWorking).toBe(false);
    expect(result.runLevel.result).toBe("pass");
    expect(result.commentLevel.result).toBe("pass");
  });

  // FAIL — either layer has FAIL verdict
  it("returns FAIL when run-level is FAIL (even if comment is PASS)", () => {
    const result = verifySkepticClaim(llmFAIL, commentPASS);
    expect(result.outcome).toBe("FAIL");
    expect(result.blocksWorking).toBe(true);
  });

  it("returns FAIL when comment-level is FAIL (even if run-level is PASS)", () => {
    const result = verifySkepticClaim(llmPASS, commentFAIL);
    expect(result.outcome).toBe("FAIL");
    expect(result.blocksWorking).toBe(true);
  });

  it("returns FAIL when both layers are FAIL", () => {
    const result = verifySkepticClaim(llmFAIL, commentFAIL);
    expect(result.outcome).toBe("FAIL");
    expect(result.blocksWorking).toBe(true);
  });

  // INSUFFICIENT — fail-closed for any missing or ambiguous evidence
  it("returns INSUFFICIENT when run-level PASS but no comment", () => {
    const result = verifySkepticClaim(llmPASS, commentEmpty);
    expect(result.outcome).toBe("INSUFFICIENT");
    expect(result.blocksWorking).toBe(true);
    expect(result.runLevel.result).toBe("pass");
    expect(result.commentLevel.result).toBe("absent");
  });

  it("returns INSUFFICIENT when run-level PASS but comment has no VERDICT", () => {
    const result = verifySkepticClaim(llmPASS, "<!-- skeptic-agent-verdict -->\nNo verdict");
    expect(result.outcome).toBe("INSUFFICIENT");
    expect(result.blocksWorking).toBe(true);
  });

  it("returns INSUFFICIENT when run-level is SKIPPED (infra failure)", () => {
    const result = verifySkepticClaim(llmSKIPPED, commentPASS);
    expect(result.outcome).toBe("INSUFFICIENT");
    expect(result.blocksWorking).toBe(true);
    expect(result.runLevel.result).toBe("absent");
  });

  it("returns INSUFFICIENT when run-level is empty (no LLM output)", () => {
    const result = verifySkepticClaim(llmEmpty, commentPASS);
    expect(result.outcome).toBe("INSUFFICIENT");
    expect(result.blocksWorking).toBe(true);
    expect(result.runLevel.result).toBe("absent");
  });

  it("returns INSUFFICIENT when both layers absent", () => {
    const result = verifySkepticClaim(llmEmpty, commentEmpty);
    expect(result.outcome).toBe("INSUFFICIENT");
    expect(result.blocksWorking).toBe(true);
  });

  // blocksWorking: only PASS clears it
  it("blocksWorking is false for PASS", () => {
    const result = verifySkepticClaim(llmPASS, commentPASS);
    expect(result.blocksWorking).toBe(false);
  });

  it("blocksWorking is true for FAIL", () => {
    const result = verifySkepticClaim(llmFAIL, commentPASS);
    expect(result.blocksWorking).toBe(true);
  });

  it("blocksWorking is true for INSUFFICIENT", () => {
    const result = verifySkepticClaim(llmPASS, commentEmpty);
    expect(result.blocksWorking).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifySkepticClaim — summary content
// ---------------------------------------------------------------------------

describe("verifySkepticClaim — summary", () => {
  it("summary includes outcome for PASS", () => {
    const result = verifySkepticClaim(
      "VERDICT: PASS\n",
      "<!-- skeptic-agent-verdict -->\nVERDICT: PASS",
    );
    expect(result.summary).toContain("PASS");
    expect(result.summary).toContain("verified");
  });

  it("summary explains which layer failed for FAIL", () => {
    const result = verifySkepticClaim(
      "VERDICT: FAIL\nMissing evidence.",
      "<!-- skeptic-agent-verdict -->\nVERDICT: PASS",
    );
    expect(result.summary).toContain("FAIL");
    expect(result.summary).toContain("run-level");
  });

  it("summary lists all absent layers for INSUFFICIENT", () => {
    const result = verifySkepticClaim(
      "VERDICT: SKIPPED",
      "",
    );
    expect(result.outcome).toBe("INSUFFICIENT");
    // summary includes the detail strings for each absent layer
    expect(result.summary).toContain("SKIPPED");
    expect(result.summary).toContain("<!-- skeptic-agent-verdict");
  });
});
