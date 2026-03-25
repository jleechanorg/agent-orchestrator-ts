import { describe, it, expect } from "vitest";
import {
  classifyComment,
  judgeCommentBatch,
  hasActionableComments,
  batchSeverityScore,
} from "../review-judgment-matrix.js";
import type { ReviewComment } from "../types.js";

function makeComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "1",
    body: "",
    author: "reviewer",
    isResolved: false,
    path: "src/foo.ts",
    line: 10,
    createdAt: new Date(),
    url: "https://github.com/owner/repo/pull/1/files#1",
    ...overrides,
  };
}

describe("classifyComment", () => {
  it("classifies security/vuln as blocking", () => {
    const c = makeComment({ body: "Security issue: SQL injection in this query" });
    const r = classifyComment(c);
    expect(r.class).toBe("blocking");
    expect(r.severityRank).toBe(1);
  });

  it("classifies 'is not working' as objective", () => {
    const c = makeComment({ body: "This function is not working as expected" });
    const r = classifyComment(c);
    expect(r.class).toBe("objective");
    expect(r.severityRank).toBe(2);
  });

  it("classifies test failure as objective", () => {
    const c = makeComment({ body: "fails the test: expect(got).toBe(expected)" });
    const r = classifyComment(c);
    expect(r.class).toBe("objective");
    expect(r.severityRank).toBe(2);
  });

  it("classifies NPE as objective", () => {
    const c = makeComment({ body: "NullPointerException here when input is null" });
    const r = classifyComment(c);
    expect(r.class).toBe("objective");
    expect(r.severityRank).toBe(2);
  });

  it("classifies memory leak as objective", () => {
    const c = makeComment({ body: "This loop causes a memory leak" });
    const r = classifyComment(c);
    expect(r.class).toBe("objective");
    expect(r.severityRank).toBe(2);
  });

  it("classifies 'nit:' as subjective", () => {
    const c = makeComment({ body: "nit: could use a const here" });
    const r = classifyComment(c);
    expect(r.class).toBe("subjective");
    expect(r.severityRank).toBe(3);
  });

  it("classifies 'nitpick' as subjective", () => {
    const c = makeComment({ body: "nitpick: prefer template literals" });
    const r = classifyComment(c);
    expect(r.class).toBe("subjective");
    expect(r.severityRank).toBe(3);
  });

  it("classifies 'suggestion' as subjective", () => {
    const c = makeComment({ body: "Suggestion: consider using a Set here" });
    const r = classifyComment(c);
    expect(r.class).toBe("subjective");
    expect(r.severityRank).toBe(3);
  });

  it("classifies 'prefer' as subjective", () => {
    const c = makeComment({ body: "I would prefer to see this as a const" });
    const r = classifyComment(c);
    expect(r.class).toBe("subjective");
    expect(r.severityRank).toBe(3);
  });

  it("classifies 'fyi' as subjective", () => {
    const c = makeComment({ body: "fyi: this is deprecated in the next version" });
    const r = classifyComment(c);
    expect(r.class).toBe("subjective");
    expect(r.severityRank).toBe(3);
  });

  it("returns unknown for generic comments", () => {
    const c = makeComment({ body: "Looks good overall, minor points" });
    const r = classifyComment(c);
    expect(r.class).toBe("unknown");
    expect(r.severityRank).toBe(4);
  });

  it("returns stable policyFingerprint", () => {
    const c = makeComment({ id: "2", body: "This is incorrect behaviour" });
    const r1 = classifyComment(c);
    const r2 = classifyComment(c);
    expect(r1.policyFingerprint).toBe(r2.policyFingerprint);
    expect(r1.policyFingerprint).toContain("objective:");
  });

  it("classifies secret/credential hardcoding as blocking", () => {
    const c = makeComment({ body: "Hardcoded API key found — credentials exposed" });
    const r = classifyComment(c);
    expect(r.class).toBe("blocking");
    expect(r.severityRank).toBe(1);
  });

  it("classifies breaking change as objective", () => {
    const c = makeComment({ body: "This is a breaking change to the public API" });
    const r = classifyComment(c);
    expect(r.class).toBe("objective");
    expect(r.severityRank).toBe(2);
  });

  it("is case-insensitive for pattern matching", () => {
    const c = makeComment({ body: "NPE when this is called with null" });
    const r = classifyComment(c);
    expect(r.class).toBe("objective");
  });
});

describe("judgeCommentBatch", () => {
  it("groups comments into correct buckets", () => {
    const comments: ReviewComment[] = [
      makeComment({ id: "1", body: "SQL injection vulnerability here" }),
      makeComment({ id: "2", body: "This is incorrect behaviour" }),
      makeComment({ id: "3", body: "nit: prefer const" }),
      makeComment({ id: "4", body: "Looks reasonable overall" }),
    ];
    const result = judgeCommentBatch(comments);
    expect(result.total).toBe(4);
    expect(result.blocking).toHaveLength(1);
    expect(result.objective).toHaveLength(1);
    expect(result.subjective).toHaveLength(1);
    expect(result.unknown).toHaveLength(1);
    expect(result.batchFingerprint).toContain("b:1");
    expect(result.batchFingerprint).toContain("o:2");
  });

  it("produces stable fingerprint regardless of input order", () => {
    const batch1 = judgeCommentBatch([
      makeComment({ id: "a", body: "This is incorrect" }),
      makeComment({ id: "b", body: "nit: change this" }),
    ]);
    const batch2 = judgeCommentBatch([
      makeComment({ id: "b", body: "nit: change this" }),
      makeComment({ id: "a", body: "This is incorrect" }),
    ]);
    expect(batch1.batchFingerprint).toBe(batch2.batchFingerprint);
  });

  it("handles empty comment list", () => {
    const result = judgeCommentBatch([]);
    expect(result.total).toBe(0);
    expect(result.blocking).toHaveLength(0);
    expect(result.batchFingerprint).toBe("");
  });
});

describe("hasActionableComments", () => {
  it("returns true when blocking comments present", () => {
    const batch = judgeCommentBatch([makeComment({ id: "1", body: "SQL injection here" })]);
    expect(hasActionableComments(batch)).toBe(true);
  });

  it("returns true when objective comments present", () => {
    const batch = judgeCommentBatch([makeComment({ id: "1", body: "This function does not work" })]);
    expect(hasActionableComments(batch)).toBe(true);
  });

  it("returns false when only subjective comments", () => {
    const batch = judgeCommentBatch([makeComment({ id: "1", body: "nit: change this" })]);
    expect(hasActionableComments(batch)).toBe(false);
  });

  it("returns false when only unknown comments", () => {
    const batch = judgeCommentBatch([makeComment({ id: "1", body: "Please review this" })]);
    expect(hasActionableComments(batch)).toBe(false);
  });
});

describe("batchSeverityScore", () => {
  it("weights blocking highest", () => {
    const batch = judgeCommentBatch([makeComment({ id: "1", body: "security vuln" })]);
    expect(batchSeverityScore(batch)).toBe(10); // 1 blocking × 10
  });

  it("weights objective second", () => {
    const batch = judgeCommentBatch([makeComment({ id: "1", body: "is not working" })]);
    expect(batchSeverityScore(batch)).toBe(5); // 1 objective × 5
  });

  it("weights subjective low", () => {
    const batch = judgeCommentBatch([makeComment({ id: "1", body: "nit: change this" })]);
    expect(batchSeverityScore(batch)).toBe(1); // 1 subjective × 1
  });

  it("accumulates across multiple comments", () => {
    const batch = judgeCommentBatch([
      makeComment({ id: "1", body: "security vuln" }),
      makeComment({ id: "2", body: "is incorrect" }),
      makeComment({ id: "3", body: "nit: style" }),
    ]);
    expect(batchSeverityScore(batch)).toBe(16); // 10 + 5 + 1
  });
});
