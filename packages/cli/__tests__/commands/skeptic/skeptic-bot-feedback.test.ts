/**
 * Unit tests for skeptic bot feedback loop — Phase 5.
 *
 * Verifies that FAIL verdicts include a ## Bot Consultation section with
 * @coderabbitai and @cursor[bot] @mentions so those bots get notified.
 * PASS verdicts must NOT include Bot Consultation (it's a FAIL-only feature).
 *
 * The @mentions appear in the LLM output body; posting.ts already includes
 * the full LLM output verbatim in the GitHub comment body, so GitHub will
 * notify the mentioned accounts.
 */

import { describe, it, expect } from "vitest";
import { buildSkepticPrompt } from "../../../src/commands/skeptic/prompt.js";

// ---------------------------------------------------------------------------
// Test fixtures — minimal PR / state / diff needed to exercise the prompt.
// ---------------------------------------------------------------------------

const minimalPR = {
  number: 1,
  title: "test: add feature",
  state: "open" as const,
  isDraft: false,
  baseRefName: "main",
  body: null,
};

const minimalState = {
  ciPassing: true,
  noConflicts: true,
  crApproved: true,
  crState: "approved",
  crDismissedWithoutApproval: false,
  bugbotErrors: 0,
  unresolvedBlockingComments: 0,
  evidenceRequired: false,
  evidenceApproved: false,
  skepticVerdict: null as string | null,
};

const emptyDiff = "--- no changes ---";
const emptyReviews: never[] = [];

describe("Bot Consultation — FAIL verdict @mention loop", () => {

  /**
   * Smoke test: build a FAIL-context prompt and verify the Bot Consultation
   * section appears with @coderabbitai and @cursor[bot] mentions.
   */
  it("FAIL prompt includes @coderabbitai mention in Bot Consultation section", () => {
    // FAIL context: CR is not approved, which drives a FAIL verdict.
    const failState = { ...minimalState, crApproved: false, crState: "changes_requested" };
    const prompt = buildSkepticPrompt(minimalPR, failState, emptyDiff, emptyReviews, null);

    expect(prompt).toContain("## Bot Consultation");
    expect(prompt).toContain("@coderabbitai");
  });

  it("FAIL prompt includes @cursor[bot] mention in Bot Consultation section", () => {
    const failState = { ...minimalState, crApproved: false, crState: "changes_requested" };
    const prompt = buildSkepticPrompt(minimalPR, failState, emptyDiff, emptyReviews, null);

    expect(prompt).toContain("@cursor[bot]");
  });

  it("FAIL prompt Bot Consultation section is adjacent to VERDICT: FAIL output format guidance", () => {
    const failState = { ...minimalState, crApproved: false, crState: "changes_requested" };
    const prompt = buildSkepticPrompt(minimalPR, failState, emptyDiff, emptyReviews, null);

    // The section should appear near the VERDICT format guidance, not buried in the diff.
    const botConsultIdx = prompt.indexOf("## Bot Consultation");
    const verdictIdx = prompt.indexOf("VERDICT: FAIL");
    expect(botConsultIdx).toBeGreaterThan(0);
    expect(verdictIdx).toBeGreaterThan(0);
    // Bot Consultation should appear within 500 chars of the VERDICT line (same output section).
    expect(Math.abs(botConsultIdx - verdictIdx)).toBeLessThan(500);
  });

  it("FAIL-only label is present in the Bot Consultation guidance (prevents spurious output)", () => {
    // The key negative guarantee: the guidance must clearly label Bot Consultation
    // as FAIL-only so the LLM doesn't emit it for PASS or SKIPPED verdicts.
    // The "(FAIL verdicts ONLY)" label achieves this — the LLM is instructed to
    // include the section only when issuing VERDICT: FAIL.
    const failState = { ...minimalState, crApproved: false, crState: "changes_requested" };
    const failPrompt = buildSkepticPrompt(minimalPR, failState, emptyDiff, emptyReviews, null);

    // The guidance must label Bot Consultation as FAIL-only.
    expect(failPrompt).toMatch(/BOT CONSULTATION.*FAIL.*ONLY|FAIL.*verdicts.*ONLY.*BOT CONSULTATION/s);

    // For PASS: the guidance exists (same prompt section) but is scoped to FAIL.
    // The LLM will only emit Bot Consultation when it issues VERDICT: FAIL.
    // Verify the FAIL-only label is present even in a PASS-context prompt.
    const passState = {
      ...minimalState,
      ciPassing: true,
      noConflicts: true,
      crApproved: true,
      crState: "approved",
      bugbotErrors: 0,
      unresolvedBlockingComments: 0,
    };
    const passPrompt = buildSkepticPrompt(minimalPR, passState, emptyDiff, emptyReviews, null);
    expect(passPrompt).toMatch(/FAIL.*verdicts.*ONLY/i);
  });

  it("FAIL prompt includes concrete consultation questions for @coderabbitai", () => {
    const failState = { ...minimalState, crApproved: false, crState: "changes_requested" };
    const prompt = buildSkepticPrompt(minimalPR, failState, emptyDiff, emptyReviews, null);

    // The prompt should guide the LLM to ask @coderabbitai a specific question.
    const botSection = prompt.substring(prompt.indexOf("## Bot Consultation"));
    expect(botSection).toMatch(/@coderabbitai.*\?/s); // @coderabbitai followed by a question
  });

  it("FAIL prompt includes concrete consultation question for @cursor[bot]", () => {
    const failState = { ...minimalState, crApproved: false, crState: "changes_requested" };
    const prompt = buildSkepticPrompt(minimalPR, failState, emptyDiff, emptyReviews, null);

    const botSection = prompt.substring(prompt.indexOf("## Bot Consultation"));
    expect(botSection).toContain("@cursor[bot]");
    // @cursor[bot] should be asked about bugbot / root cause confirmation.
    expect(botSection).toMatch(/bugbot|root cause|confirm|same failure/i);
  });
});
