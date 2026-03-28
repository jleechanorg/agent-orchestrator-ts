/**
 * verify6Green — unit tests (bd-mjtn)
 *
 * Tests the six core PR readiness gates enforced by lifecycle-manager.verify6Green():
 *   Gate 1: CI green
 *   Gate 2: No merge conflicts
 *   Gate 3: CodeRabbit APPROVED
 *   Gate 4: Bugbot clean
 *   Gate 5: All inline comments resolved
 *
 * verify6Green is a thin wrapper over checkMergeGate; these tests verify the
 * gate-logic outcomes rather than re-testing checkMergeGate internals.
 */

import { describe, it, expect, vi, type Mock } from "vitest";
import { verify6Green } from "../lifecycle-manager.js";
import type { PRInfo, SCM } from "../types.js";

interface MockSCM {
  name: string;
  getCISummary: Mock;
  getMergeability: Mock;
  getReviews: Mock;
  getAutomatedComments: Mock;
  getPendingComments: Mock;
  getReviewDecision: Mock;
}

function makePassingScm(): MockSCM {
  return {
    name: "mock",
    getCISummary: vi.fn().mockResolvedValue("passing"),
    getMergeability: vi.fn().mockResolvedValue({ noConflicts: true, mergeable: true, ciPassing: true, approved: true, blockers: [] }),
    getReviews: vi.fn().mockResolvedValue([{ author: "coderabbitai[bot]", state: "approved", submittedAt: new Date() }]),
    getAutomatedComments: vi.fn().mockResolvedValue([]),
    getPendingComments: vi.fn().mockResolvedValue([]),
    getReviewDecision: vi.fn().mockResolvedValue("approved"),
  };
}

const pr: PRInfo = {
  number: 42,
  url: "https://github.com/test/repo/pull/42",
  title: "Test PR",
  owner: "test",
  repo: "repo",
  branch: "feat/test",
  baseBranch: "main",
  isDraft: false,
  author: "testauthor",
};

describe("verify6Green", () => {
  // ── Gate 1: CI green ────────────────────────────────────────────────────────

  it("blocks when CI is failing", async () => {
    const scm = makePassingScm();
    scm.getCISummary.mockResolvedValue("failing");
    const result = await verify6Green(pr, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("CI green");
  });

  it("blocks when CI is pending", async () => {
    const scm = makePassingScm();
    scm.getCISummary.mockResolvedValue("pending");
    const result = await verify6Green(pr, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("CI green");
  });

  it("passes when CI is passing", async () => {
    const scm = makePassingScm();
    const result = await verify6Green(pr, scm as unknown as SCM);
    const gate1 = result.checks.find((c) => c.name === "CI green");
    expect(gate1?.passed).toBe(true);
  });

  // ── Gate 2: No merge conflicts ─────────────────────────────────────────────

  it("blocks when there are merge conflicts", async () => {
    const scm = makePassingScm();
    scm.getMergeability.mockResolvedValue({ noConflicts: false, mergeable: false, ciPassing: true, approved: true, blockers: ["conflicts"] });
    const result = await verify6Green(pr, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("Mergeable");
  });

  it("passes when no conflicts", async () => {
    const scm = makePassingScm();
    const result = await verify6Green(pr, scm as unknown as SCM);
    const gate2 = result.checks.find((c) => c.name === "Mergeable");
    expect(gate2?.passed).toBe(true);
  });

  // ── Gate 3: CodeRabbit APPROVED ─────────────────────────────────────────────

  it("blocks when no CodeRabbit review exists", async () => {
    const scm = makePassingScm();
    scm.getReviews.mockResolvedValue([]);
    const result = await verify6Green(pr, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("CodeRabbit approved");
  });

  it("blocks when CodeRabbit review is CHANGES_REQUESTED", async () => {
    const scm = makePassingScm();
    scm.getReviews.mockResolvedValue([{ author: "coderabbitai[bot]", state: "changes_requested", submittedAt: new Date() }]);
    const result = await verify6Green(pr, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("CodeRabbit approved");
    const gate3 = result.checks.find((c) => c.name === "CodeRabbit approved");
    expect(gate3?.detail).toContain("requested changes");
  });

  it("ignores COMMENTED state (not actionable)", async () => {
    const scm = makePassingScm();
    scm.getReviews.mockResolvedValue([{ author: "coderabbitai[bot]", state: "commented", submittedAt: new Date() }]);
    const result = await verify6Green(pr, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    // COMMENTED is not decisive — latest decisive review is absent → blocks
    expect(result.blockers).toContain("CodeRabbit approved");
  });

  it("passes when latest CodeRabbit review is APPROVED", async () => {
    const scm = makePassingScm();
    scm.getReviews.mockResolvedValue([{ author: "coderabbitai[bot]", state: "approved", submittedAt: new Date() }]);
    const result = await verify6Green(pr, scm as unknown as SCM);
    const gate3 = result.checks.find((c) => c.name === "CodeRabbit approved");
    expect(gate3?.passed).toBe(true);
  });

  it("blocks when dismissed CR review has no subsequent real approval", async () => {
    const scm = makePassingScm();
    scm.getReviews.mockResolvedValue([{ author: "coderabbitai[bot]", state: "dismissed", submittedAt: new Date() }]);
    const result = await verify6Green(pr, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("CodeRabbit approved");
    const gate3 = result.checks.find((c) => c.name === "CodeRabbit approved");
    expect(gate3?.detail).toContain("dismissed");
  });

  // ── Gate 4: Bugbot clean ────────────────────────────────────────────────────

  it("blocks when Cursor Bugbot has error-severity comment", async () => {
    const scm = makePassingScm();
    scm.getAutomatedComments.mockResolvedValue([
      { id: "1", botName: "cursor[bot]", body: "Error: type mismatch", severity: "error", createdAt: new Date(), url: "https://example.com" },
    ]);
    const result = await verify6Green(pr, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("Bugbot clean");
  });

  it("passes when Bugbot has no error-severity comments", async () => {
    const scm = makePassingScm();
    scm.getAutomatedComments.mockResolvedValue([]);
    const result = await verify6Green(pr, scm as unknown as SCM);
    const gate4 = result.checks.find((c) => c.name === "Bugbot clean");
    expect(gate4?.passed).toBe(true);
  });

  it("ignores warning-severity Bugbot comments", async () => {
    const scm = makePassingScm();
    scm.getAutomatedComments.mockResolvedValue([
      { id: "1", botName: "cursor[bot]", body: "Warning: unused import", severity: "warning", createdAt: new Date(), url: "https://example.com" },
    ]);
    const result = await verify6Green(pr, scm as unknown as SCM);
    const gate4 = result.checks.find((c) => c.name === "Bugbot clean");
    expect(gate4?.passed).toBe(true);
  });

  // ── Gate 5: Inline comments resolved ───────────────────────────────────────

  it("blocks when there are unresolved non-nit comments", async () => {
    const scm = makePassingScm();
    scm.getPendingComments.mockResolvedValue([
      { id: "1", author: "reviewer", body: "This function needs a return type", isResolved: false, createdAt: new Date(), url: "https://example.com" },
    ]);
    const result = await verify6Green(pr, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("Inline comments resolved");
  });

  it("passes when all comments are resolved", async () => {
    const scm = makePassingScm();
    scm.getPendingComments.mockResolvedValue([
      { id: "1", author: "reviewer", body: "This needs fixing", isResolved: true, createdAt: new Date(), url: "https://example.com" },
    ]);
    const result = await verify6Green(pr, scm as unknown as SCM);
    const gate5 = result.checks.find((c) => c.name === "Inline comments resolved");
    expect(gate5?.passed).toBe(true);
  });

  it("ignores nit comments even when unresolved", async () => {
    const scm = makePassingScm();
    scm.getPendingComments.mockResolvedValue([
      { id: "1", author: "reviewer", body: "nit: minor style", isResolved: false, createdAt: new Date(), url: "https://example.com" },
    ]);
    const result = await verify6Green(pr, scm as unknown as SCM);
    const gate5 = result.checks.find((c) => c.name === "Inline comments resolved");
    expect(gate5?.passed).toBe(true);
  });

  it("ignores PR author comments even when unresolved", async () => {
    const scm = makePassingScm();
    scm.getPendingComments.mockResolvedValue([
      { id: "1", author: "testauthor", body: "TODO: add tests", isResolved: false, createdAt: new Date(), url: "https://example.com" },
    ]);
    const result = await verify6Green(pr, scm as unknown as SCM);
    const gate5 = result.checks.find((c) => c.name === "Inline comments resolved");
    expect(gate5?.passed).toBe(true);
  });

  // Gate 5 REST fallback: when getPendingComments falls back to REST (e.g. GraphQL
  // rate-limited), isResolved=false for all threads.  This is fail-closed by design —
  // the gate blocks rather than incorrectly passing.
  it("blocks when REST fallback returns isResolved=false for all threads (fail-closed)", async () => {
    const scm = makePassingScm();
    // REST fallback sets isResolved=false; no way to distinguish resolved from unresolved
    scm.getPendingComments.mockResolvedValue([
      { id: "1", author: "reviewer", body: "Consider renaming this variable", isResolved: false, createdAt: new Date(), url: "https://example.com" },
    ]);
    const result = await verify6Green(pr, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("Inline comments resolved");
  });

  // ── All gates pass ──────────────────────────────────────────────────────────

  it("passes when all six gates pass", async () => {
    const scm = makePassingScm();
    const result = await verify6Green(pr, scm as unknown as SCM);
    expect(result.passed).toBe(true);
    expect(result.blockers).toEqual([]);
    // verify6Green does not add skeptic check (skepticRequired=false)
    const skepticCheck = result.checks.find((c) => c.name === "Skeptic approved");
    expect(skepticCheck).toBeUndefined();
  });

  // ── SCM error handling ──────────────────────────────────────────────────────

  it("blocks when SCM query throws", async () => {
    const scm = makePassingScm();
    scm.getCISummary.mockRejectedValue(new Error("network timeout"));
    const result = await verify6Green(pr, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("SCM query");
  });

  // ── Multiple blockers ────────────────────────────────────────────────────────

  it("reports all blockers when multiple gates fail", async () => {
    const scm = makePassingScm();
    scm.getCISummary.mockResolvedValue("failing");
    scm.getMergeability.mockResolvedValue({ noConflicts: false, mergeable: false, ciPassing: false, approved: false, blockers: ["ci", "conflicts"] });
    scm.getReviews.mockResolvedValue([{ author: "coderabbitai[bot]", state: "changes_requested", submittedAt: new Date() }]);
    scm.getPendingComments.mockResolvedValue([
      { id: "1", author: "reviewer", body: "Fix this", isResolved: false, createdAt: new Date(), url: "https://example.com" },
    ]);
    const result = await verify6Green(pr, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("CI green");
    expect(result.blockers).toContain("Mergeable");
    expect(result.blockers).toContain("CodeRabbit approved");
    expect(result.blockers).toContain("Inline comments resolved");
  });
});
