import { describe, it, expect } from "vitest";
import { buildSkepticPrompt } from "../../commands/skeptic/prompt.js";
import type { PRInfo, ReviewInfo } from "../../commands/skeptic/gh-client.js";
import type { MergeGateState } from "../../commands/skeptic/mergeGate.js";

function makeMinimalPR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 123,
    title: "feat: add authentication middleware",
    state: "open",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feat/auth",
    body: "## Summary\nAdds JWT auth middleware.\n\nCloses #122",
    url: "https://github.com/jleechanorg/agent-orchestrator/pull/123",
    owner: "jleechanorg",
    repo: "agent-orchestrator",
    branch: "feat/auth",
    baseBranch: "main",
    ...overrides,
  };
}

function makePassingState(overrides: Partial<MergeGateState> = {}): MergeGateState {
  return {
    ciPassing: true,
    noConflicts: true,
    crApproved: true,
    crState: "APPROVED",
    crDismissedWithoutApproval: false,
    bugbotErrors: 0,
    unresolvedBlockingComments: 0,
    evidenceRequired: false,
    evidenceApproved: false,
    skepticVerdict: null,
    ...overrides,
  };
}

function makeFailingState(overrides: Partial<MergeGateState> = {}): MergeGateState {
  return {
    ciPassing: false,
    noConflicts: true,
    crApproved: false,
    crState: "CHANGES_REQUESTED",
    crDismissedWithoutApproval: false,
    bugbotErrors: 0,
    unresolvedBlockingComments: 2,
    evidenceRequired: false,
    evidenceApproved: false,
    skepticVerdict: null,
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
