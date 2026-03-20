import { describe, it, expect, vi, type Mock } from "vitest";
import { checkMergeGate } from "../merge-gate.js";
import type { PRInfo, MergeGateConfig, SCM } from "../types.js";

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
  number: 1,
  url: "https://github.com/test/repo/pull/1",
  title: "Test PR",
  owner: "test",
  repo: "repo",
  branch: "feat/test",
  baseBranch: "main",
  isDraft: false,
};

const config: MergeGateConfig = { enabled: true };

describe("checkMergeGate", () => {
  it("passes when all 6 checks pass", async () => {
    const scm = makePassingScm();
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    expect(result.passed).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.checks).toHaveLength(6);
    for (const check of result.checks) {
      expect(check.passed).toBe(true);
    }
  });

  it("fails when CI is not passing", async () => {
    const scm = makePassingScm();
    scm.getCISummary.mockResolvedValue("failing");
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("CI green");
  });

  it("fails when there are merge conflicts", async () => {
    const scm = makePassingScm();
    scm.getMergeability.mockResolvedValue({ noConflicts: false, mergeable: false, ciPassing: true, approved: true, blockers: ["conflicts"] });
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("Mergeable");
  });

  it("fails when no CodeRabbit review exists", async () => {
    const scm = makePassingScm();
    scm.getReviews.mockResolvedValue([]);
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("CodeRabbit approved");
  });

  it("fails when CodeRabbit review is changes_requested", async () => {
    const scm = makePassingScm();
    scm.getReviews.mockResolvedValue([{ author: "coderabbitai[bot]", state: "changes_requested", submittedAt: new Date() }]);
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("CodeRabbit approved");
  });

  it("fails when newer CodeRabbit rejection overrides older approval", async () => {
    const scm = makePassingScm();
    scm.getReviews.mockResolvedValue([
      { author: "coderabbitai[bot]", state: "approved", submittedAt: new Date("2024-01-01T00:00:00Z") },
      { author: "coderabbitai[bot]", state: "changes_requested", submittedAt: new Date("2024-01-02T00:00:00Z") },
    ]);
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("CodeRabbit approved");
    const crCheck = result.checks.find((c) => c.name === "CodeRabbit approved");
    expect(crCheck?.detail).toContain("requested changes");
  });

  it("passes when newer CodeRabbit approval overrides older rejection", async () => {
    const scm = makePassingScm();
    scm.getReviews.mockResolvedValue([
      { author: "coderabbitai[bot]", state: "changes_requested", submittedAt: new Date("2024-01-01T00:00:00Z") },
      { author: "coderabbitai[bot]", state: "approved", submittedAt: new Date("2024-01-02T00:00:00Z") },
    ]);
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    const crCheck = result.checks.find((c) => c.name === "CodeRabbit approved");
    expect(crCheck?.passed).toBe(true);
  });

  it("ignores commented review state from CodeRabbit", async () => {
    const scm = makePassingScm();
    scm.getReviews.mockResolvedValue([
      { author: "coderabbitai[bot]", state: "approved", submittedAt: new Date("2024-01-01T00:00:00Z") },
      { author: "coderabbitai[bot]", state: "commented", submittedAt: new Date("2024-01-02T00:00:00Z") },
    ]);
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    const crCheck = result.checks.find((c) => c.name === "CodeRabbit approved");
    expect(crCheck?.passed).toBe(true);
  });

  it("fails when Cursor Bugbot has error-severity comment", async () => {
    const scm = makePassingScm();
    scm.getAutomatedComments.mockResolvedValue([
      { id: "1", botName: "cursor[bot]", body: "error found", severity: "error", createdAt: new Date(), url: "https://example.com" },
    ]);
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("Bugbot clean");
  });

  it("fails when there are unresolved non-nitpick comments", async () => {
    const scm = makePassingScm();
    scm.getPendingComments.mockResolvedValue([
      { id: "1", author: "reviewer", body: "This needs fixing", isResolved: false, createdAt: new Date(), url: "https://example.com" },
    ]);
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("Inline comments resolved");
  });

  it("fails when evidence-review is required but no approval exists", async () => {
    const scm = makePassingScm();
    const cfgWithEvidence: MergeGateConfig = { enabled: true, requiredChecks: ["evidence-review"] };
    const result = await checkMergeGate(pr, cfgWithEvidence, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("Evidence review pass");
  });

  it("reports multiple blockers when multiple checks fail", async () => {
    const scm = makePassingScm();
    scm.getCISummary.mockResolvedValue("failing");
    scm.getMergeability.mockResolvedValue({ noConflicts: false, mergeable: false, ciPassing: false, approved: true, blockers: ["ci", "conflicts"] });
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("CI green");
    expect(result.blockers).toContain("Mergeable");
  });

  it("passes Bugbot check when no automated comments exist", async () => {
    const scm = makePassingScm();
    scm.getAutomatedComments.mockResolvedValue([]);
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    const bugbotCheck = result.checks.find((c) => c.name === "Bugbot clean");
    expect(bugbotCheck?.passed).toBe(true);
  });

  it("passes comments check when all comments are resolved", async () => {
    const scm = makePassingScm();
    scm.getPendingComments.mockResolvedValue([
      { id: "1", author: "reviewer", body: "This needs fixing", isResolved: true, createdAt: new Date(), url: "https://example.com" },
    ]);
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    const commentsCheck = result.checks.find((c) => c.name === "Inline comments resolved");
    expect(commentsCheck?.passed).toBe(true);
  });

  it("returns passed with no checks when config.enabled is false", async () => {
    const scm = makePassingScm();
    const disabledConfig: MergeGateConfig = { enabled: false };
    const result = await checkMergeGate(pr, disabledConfig, scm as unknown as SCM);
    expect(result.passed).toBe(true);
    expect(result.checks).toEqual([]);
    expect(result.blockers).toEqual([]);
    expect(scm.getCISummary).not.toHaveBeenCalled();
  });

  it("returns structured failure when SCM query throws", async () => {
    const scm = makePassingScm();
    scm.getCISummary.mockRejectedValue(new Error("network timeout"));
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("SCM query");
    expect(result.checks[0].detail).toContain("network timeout");
  });

  it("ignores nit comments with leading whitespace", async () => {
    const scm = makePassingScm();
    scm.getPendingComments.mockResolvedValue([
      { id: "1", author: "reviewer", body: "  nit: minor style", isResolved: false, createdAt: new Date(), url: "https://example.com" },
    ]);
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    const commentsCheck = result.checks.find((c) => c.name === "Inline comments resolved");
    expect(commentsCheck?.passed).toBe(true);
  });
});
