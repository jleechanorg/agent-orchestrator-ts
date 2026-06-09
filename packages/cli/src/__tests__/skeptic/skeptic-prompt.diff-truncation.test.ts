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

  it("correctly identifies changed files with renames, deletions, and modifications without duplication or /dev/null", () => {
    const diff = [
      "diff --git a/src/old-name.ts b/src/new-name.ts",
      "similarity index 85%",
      "rename from src/old-name.ts",
      "rename to src/new-name.ts",
      "index 1234567..89abcdef 100644",
      "--- a/src/old-name.ts",
      "+++ b/src/new-name.ts",
      "@@ -1,1 +1,2 @@",
      "-content",
      "+content changed",
      "diff --git a/src/deleted.ts b/src/deleted.ts",
      "deleted file mode 100644",
      "index abc1234..0000000 100644",
      "--- a/src/deleted.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-deleted content",
      "diff --git a/src/modified.ts b/src/modified.ts",
      "index 1111111..2222222 100644",
      "--- a/src/modified.ts",
      "+++ b/src/modified.ts",
      "@@ -1,1 +1,1 @@",
      "-foo",
      "+bar"
    ].join("\n");

    const prompt = buildSkepticPrompt(
      makeMinimalPR(),
      makePassingState(),
      diff,
      EMPTY_REVIEWS,
      null,
    );

    expect(prompt).toContain("--- ALL CHANGED FILES IN PR (3 files) ---");
    expect(prompt).toContain("- src/new-name.ts");
    expect(prompt).toContain("- src/deleted.ts");
    expect(prompt).toContain("- src/modified.ts");
    expect(prompt).not.toContain("- src/old-name.ts");
    expect(prompt).not.toContain("- /dev/null");
  });
});

