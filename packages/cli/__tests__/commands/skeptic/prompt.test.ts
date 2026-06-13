import { describe, it, expect } from "vitest";
import { buildSkepticPrompt } from "../../../src/commands/skeptic/prompt.js";
import type { PRInfo, ReviewInfo } from "../../../src/commands/skeptic/gh-client.js";
import type { MergeGateState } from "../../../src/commands/skeptic/mergeGate.js";

const EMPTY_REVIEWS: ReviewInfo[] = [];

function makeMinimalPR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 679,
    title: "[agento] fix(skeptic): filter CR reviews",
    state: "open",
    isDraft: false,
    baseRefName: "main",
    headRefOid: "21c1bafcd37b3b0fc1d41d0321a46b8187530c6a",
    body: "## Summary\nFixes skeptic head SHA filtering.\n\n## Goals\n- Surface head SHA and none-on-head state.\n",
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
    crApproved: false,
    crState: "none-on-head",
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

describe("buildSkepticPrompt", () => {
  it("surfaces the head SHA and none-on-head state in the evaluation prompt", () => {
    const pr = makeMinimalPR();
    const state = makePassingState();
    const prompt = buildSkepticPrompt(pr, state, "diff --git a/file b/file", EMPTY_REVIEWS, null);

    expect(prompt).toContain("Head SHA: 21c1bafcd37b3b0fc1d41d0321a46b8187530c6a");
    expect(prompt).toContain("state: none-on-head");
  });
});
