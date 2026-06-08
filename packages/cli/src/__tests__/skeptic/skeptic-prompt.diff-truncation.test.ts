import { describe, it, expect } from "vitest";
import { buildSkepticPrompt } from "../../commands/skeptic/prompt.js";
import type { PRInfo, ReviewInfo } from "../../commands/skeptic/gh-client.js";
import type { MergeGateState } from "../../commands/skeptic/mergeGate.js";

const EMPTY_REVIEWS: ReviewInfo[] = [];

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

describe("diff truncation and changed files listing", () => {
  it("includes all changed files list and truncates diff when it exceeds MAX_DIFF_CHARS", () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const fileHeaders = files.map(f => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1,1 +1,1 @@\n-old\n+new`).join("\n");
    const filler = "x".repeat(500050);
    const largeDiff = `${fileHeaders}\n${filler}`;

    const prompt = buildSkepticPrompt(
      makeMinimalPR(),
      makePassingState(),
      largeDiff,
      EMPTY_REVIEWS,
      null,
    );

    expect(prompt).toContain("--- ALL CHANGED FILES IN PR (3 files) ---");
    expect(prompt).toContain("- src/a.ts");
    expect(prompt).toContain("- src/b.ts");
    expect(prompt).toContain("- src/c.ts");

    expect(prompt).toContain("--- DIFF (first 500000 chars; all files included if diff fits) ---");
    expect(prompt).toContain("[DIFF TRUNCATED - TOO LARGE]");

    const diffMarker = "--- DIFF (first 500000 chars; all files included if diff fits) ---\n";
    const diffStartIndex = prompt.indexOf(diffMarker) + diffMarker.length;
    const remainingText = prompt.slice(diffStartIndex);
    const diffContent = remainingText.split("\n\n[DIFF TRUNCATED - TOO LARGE]")[0] ?? "";
    expect(diffContent).toBe(largeDiff.slice(0, 500000) + "\n");
  });
});
