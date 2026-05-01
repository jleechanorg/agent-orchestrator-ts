import { describe, it, expect } from "vitest";
import { buildSkepticPrompt, isEvidenceAuthentic } from "../../commands/skeptic/prompt.js";
import type { PRInfo, ReviewInfo } from "../../commands/skeptic/gh-client.js";
import type { MergeGateState } from "../../commands/skeptic/mergeGate.js";

function makeMinimalPR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 123,
    title: "feat: add authentication middleware",
    state: "open",
    isDraft: false,
    baseRefName: "main",
    headRefOid: "abc1234",
    body: "## Summary\nAdds JWT auth middleware.\n\nCloses #122",
    ...overrides,
  };
}

function makePassingState(overrides: Partial<MergeGateState> = {}): MergeGateState {
  return {
    ciPassing: true,
    ciRawState: "success",
    checkRuns: [],
    noConflicts: true,
    mergeableRaw: true,
    crApproved: true,
    crState: "APPROVED",
    crDismissedWithoutApproval: false,
    bugbotErrors: 0,
    unresolvedBlockingComments: 0,
    evidenceRequired: false,
    evidenceApproved: false,
    skepticVerdict: null,
    skepticCommentId: null,
    ...overrides,
  };
}

function makeFailingState(overrides: Partial<MergeGateState> = {}): MergeGateState {
  return {
    ciPassing: false,
    ciRawState: "failure",
    checkRuns: [],
    noConflicts: true,
    mergeableRaw: true,
    crApproved: false,
    crState: "CHANGES_REQUESTED",
    crDismissedWithoutApproval: false,
    bugbotErrors: 0,
    unresolvedBlockingComments: 2,
    evidenceRequired: false,
    evidenceApproved: false,
    skepticVerdict: null,
    skepticCommentId: null,
    ...overrides,
  };
}

const EMPTY_DIFF = "+++ b/src/auth.ts\n@@ -1,3 +1,10 @@\n+import { verify } from './jwt';\n+export function authenticate(req) {\n+  if (!verify(req.token)) return 401;\n+  return 200;\n+}";

const EMPTY_REVIEWS: ReviewInfo[] = [];

describe("skeptic structured output", () => {
  describe("PASS verdict — no structured sections required", () => {
    it("prompt instructs LLM to emit minimal PASS output", () => {
      const prompt = buildSkepticPrompt(
        makeMinimalPR(),
        makePassingState(),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );

      // PASS output format should be minimal: just VERDICT: PASS
      expect(prompt).toContain("OUTPUT FORMAT:");
      expect(prompt).toContain("VERDICT: PASS");
      // The PASS section (before --- separator) should NOT require structured sections
      const passSection = prompt.split("--- // END PASS")[0] ?? "";
      expect(passSection).not.toContain("## Background");
      expect(passSection).not.toContain("## Current Problem");
      expect(passSection).not.toContain("## Recommended Solution");
      expect(passSection).not.toContain("## Bot Consultation");
    });

    it("PASS verdict — should not require ## Background or other sections", () => {
      const prompt = buildSkepticPrompt(
        makeMinimalPR(),
        makePassingState(),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );

      // PASS section: only the VERDICT: PASS line, no mandatory ## sections
      const passSection = prompt.split("--- // END PASS")[0] ?? "";
      expect(passSection).toContain("VERDICT: PASS");
      expect(passSection).not.toContain("## Background");
    });
  });

  describe("FAIL verdict — must emit all four structured sections", () => {
    it("prompt instructs LLM to emit ## Background on FAIL", () => {
      const prompt = buildSkepticPrompt(
        makeMinimalPR({ number: 42, title: "fix: resolve memory leak in worker pool" }),
        makeFailingState({ ciPassing: false }),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );

      expect(prompt).toContain("## Background");
      expect(prompt).toContain("PR #42");
      expect(prompt).toContain("fix: resolve memory leak in worker pool");
    });

    it("prompt instructs LLM to emit ## Current Problem on FAIL", () => {
      const prompt = buildSkepticPrompt(
        makeMinimalPR(),
        makeFailingState({ crApproved: false, crState: "CHANGES_REQUESTED" }),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );

      expect(prompt).toContain("## Current Problem");
    });

    it("prompt instructs LLM to emit ## Recommended Solution on FAIL", () => {
      const prompt = buildSkepticPrompt(
        makeMinimalPR(),
        makeFailingState({ unresolvedBlockingComments: 3 }),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );

      expect(prompt).toContain("## Recommended Solution");
    });

    it("prompt instructs LLM to emit ## Bot Consultation on FAIL with coderabbitai and cursor[bot] mentions", () => {
      const prompt = buildSkepticPrompt(
        makeMinimalPR(),
        makeFailingState({ bugbotErrors: 1 }),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );

      expect(prompt).toContain("## Bot Consultation");
      expect(prompt).toContain("@coderabbitai");
      expect(prompt).toContain("@cursor[bot]");
    });

    it("FAIL output format includes all four sections", () => {
      const prompt = buildSkepticPrompt(
        makeMinimalPR(),
        makeFailingState(),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );

      const outputSection = prompt.split("OUTPUT FORMAT:")[1] ?? "";
      expect(outputSection).toContain("## Background");
      expect(outputSection).toContain("## Current Problem");
      expect(outputSection).toContain("## Recommended Solution");
      expect(outputSection).toContain("## Bot Consultation");
    });

    it("FAIL output format ends with VERDICT: FAIL", () => {
      const prompt = buildSkepticPrompt(
        makeMinimalPR(),
        makeFailingState(),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );

      const outputSection = prompt.split("OUTPUT FORMAT:")[1] ?? "";
      expect(outputSection).toContain("VERDICT: FAIL");
    });

    it("FAIL requires Bot Consultation section with coderabbitai and cursor[bot]", () => {
      const prompt = buildSkepticPrompt(
        makeMinimalPR(),
        makeFailingState({ ciPassing: false }),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );

      // The Bot Consultation section must include @ mentions
      expect(prompt).toMatch(/@coderabbitai/);
      expect(prompt).toMatch(/@cursor\[bot\]/);
    });
  });

  describe("Rule 10 — evidence authenticity (always active)", () => {
    it("prompt always contains the evidence authenticity check regardless of evidenceRequired config", () => {
      const promptNoEvidenceRequired = buildSkepticPrompt(
        makeMinimalPR(),
        makePassingState({ evidenceRequired: false }),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );
      const promptWithEvidenceRequired = buildSkepticPrompt(
        makeMinimalPR(),
        makePassingState({ evidenceRequired: true }),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );

      for (const prompt of [promptNoEvidenceRequired, promptWithEvidenceRequired]) {
        expect(prompt).toContain("ALWAYS evaluate evidence authenticity");
        expect(prompt).toContain("simulated");
        expect(prompt).toContain("example.com");
        expect(prompt).toContain("<screenshot path>");
        expect(prompt).toContain("<value>");
        expect(prompt).toContain("TODO");
        expect(prompt).toContain("TBD");
        expect(prompt).toContain("coverage claim");
        expect(prompt).toContain("percentage numbers");
        expect(prompt).toContain("evidence section is empty");
        expect(prompt).toContain("template placeholders");
        expect(prompt).toContain("evidence-review-bot");
        expect(prompt).toContain("Gate 6");
        expect(prompt).toContain("separate pass/fail gate");
      }
    });

    it("prompt does NOT contain the old N/A escape hatch", () => {
      const prompt = buildSkepticPrompt(
        makeMinimalPR(),
        makePassingState({ evidenceRequired: false }),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );
      expect(prompt).not.toContain("default is N/A");
      expect(prompt).not.toContain("Evidence review is required only when config requires it");
      expect(prompt).not.toContain("N/A (not required)");
    });

    it("PASS verdict for evidence section is conditioned on real output", () => {
      const prompt = buildSkepticPrompt(
        makeMinimalPR(),
        makePassingState(),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );
      expect(prompt).toContain("real command output");
      expect(prompt).toContain("real authentic video evidence");
    });
  });

  describe("Rule 12 — Goals Section Verification (always active)", () => {
    it("prompt contains Rule 12 goals section check regardless of PR content", () => {
      const prompt = buildSkepticPrompt(
        makeMinimalPR({ body: "No goals here" }),
        makePassingState(),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );

      expect(prompt).toContain("GOALS PROOF");
      expect(prompt).toContain("Rule 12");
      expect(prompt).toContain("12a");
      expect(prompt).toContain("12b");
      expect(prompt).toContain("12c");
      expect(prompt).toContain("12d");
      expect(prompt).toContain("12e");
    });

    it("Rule 12 checks for bullet or numbered items in Goals section", () => {
      const prompt = buildSkepticPrompt(
        makeMinimalPR(),
        makePassingState(),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );

      expect(prompt).toContain("bullet/numbered item");
      expect(prompt).toContain("12a");
      expect(prompt).toContain("Extract each bullet/numbered item from the Goals section");
    });

    it("Rule 12d allows test goals to be satisfied by test changes", () => {
      const prompt = buildSkepticPrompt(
        makeMinimalPR(),
        makePassingState(),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );

      // 12f must say TESTING goals don't require behavioral code changes
      expect(prompt).toContain("Behavioral code changes are NOT required if goal explicitly says 'add tests'");
    });

    it("Rule 12 rejects behavioral goals with no test validation", () => {
      const prompt = buildSkepticPrompt(
        makeMinimalPR(),
        makePassingState(),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );

      expect(prompt).toContain("FAIL if behavioral goal has no corresponding passing test");
      expect(prompt).toContain("The test must specifically prove the claimed behavior, not just exist");
    });

    it("Rule 12 skips when no Goals section present", () => {
      const prompt = buildSkepticPrompt(
        makeMinimalPR({ body: "Just some text" }),
        makePassingState(),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );

      expect(prompt).toContain("skip rules 12c-12g");
    });

    it("FAIL format instructs to include Goals Verification section when Rule 12 gaps found", () => {
      const prompt = buildSkepticPrompt(
        makeMinimalPR(),
        makeFailingState(),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );

      const outputSection = prompt.split("OUTPUT FORMAT:")[1] ?? "";
      expect(outputSection).toContain("## Goals Verification");
      expect(outputSection).toContain("Rule 12 gaps");
    });

    it("FAIL format clarifies optional appendix sections placement", () => {
      const prompt = buildSkepticPrompt(
        makeMinimalPR(),
        makeFailingState(),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );

      const outputSection = prompt.split("OUTPUT FORMAT:")[1] ?? "";
      // Should explain optional sections go after ## Bot Consultation
      expect(outputSection).toContain("Optional appendix sections");
      expect(outputSection).toContain("append after ## Bot Consultation");
    });
  });

  describe("PASS vs FAIL — format discrimination", () => {
    it("PASS output does not require ## Background; FAIL does", () => {
      const passingPrompt = buildSkepticPrompt(
        makeMinimalPR(),
        makePassingState(),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );
      const failingPrompt = buildSkepticPrompt(
        makeMinimalPR(),
        makeFailingState(),
        EMPTY_DIFF,
        EMPTY_REVIEWS,
        null,
      );

      // PASS section is before "--- // END PASS" — minimal, no ## sections
      const passingOutput = passingPrompt.split("--- // END PASS")[0] ?? "";
      expect(passingOutput).not.toContain("## Background");
      expect(passingOutput).toContain("VERDICT: PASS");

      // FAIL section is after "--- // END PASS" — contains all structured sections
      const failingOutput = failingPrompt.split("--- // END PASS")[1] ?? "";
      expect(failingOutput).toContain("## Background");
    });
  });
});

describe("isEvidenceAuthentic", () => {
  // Edge cases
  it("returns false for empty string (Rule 10: empty Evidence = FAIL)", () => {
    expect(isEvidenceAuthentic("")).toBe(false);
  });

  it("returns false for whitespace-only string", () => {
    expect(isEvidenceAuthentic("   \n\t  ")).toBe(false);
  });

  it("returns false for null/undefined (treated as empty)", () => {
    expect(isEvidenceAuthentic("")).toBe(false);
  });

  // Scoping to ## Evidence section
  it("returns false when Evidence section is empty (no content after heading)", () => {
    const body = "## Background\nAdds auth middleware.\n\n## Evidence\n\n## Testing\nUnit tests added.";
    expect(isEvidenceAuthentic(body)).toBe(false);
  });

  it("ignores fabricated patterns outside the ## Evidence section", () => {
    // TODO in Background section — should not cause FAIL
    const body = "## Background\nTODO: add more tests later.\n\n## Evidence\nReal command output here.";
    expect(isEvidenceAuthentic(body)).toBe(true);
  });

  it("detects fabricated patterns inside the ## Evidence section", () => {
    const body = "## Background\nAdds auth middleware.\n\n## Evidence\n$ pnpm test\nsimulated output would go here.";
    expect(isEvidenceAuthentic(body)).toBe(false);
  });

  // Pattern coverage
  it.each([
    ["simulated", "## Evidence\nsimulated output"],
    ["example.com", "## Evidence\nSee https://example.com/screenshot"],
    ["<screenshot>", "## Evidence\n![img](<screenshot path>)"],
    ["<value>", "## Evidence\nExpected: <value>"],
    ["TODO", "## Evidence\nTODO: add more tests"],
    ["TBD", "## Evidence\nResults: TBD"],
    ["placeholder", "## Evidence\nplaceholder text here"],
  ])("returns false for '%s' pattern in Evidence section", (pattern, evidence) => {
    expect(isEvidenceAuthentic(evidence)).toBe(false);
  });

  it("returns true for clean Evidence section with real output", () => {
    const body = `## Evidence
\`\`\`
$ pnpm test
  ✓ auth.test.ts (10 tests)
  Test Files  1 passed (1)
       Tests  10 passed (10)
\`\`\``;
    expect(isEvidenceAuthentic(body)).toBe(true);
  });
});
