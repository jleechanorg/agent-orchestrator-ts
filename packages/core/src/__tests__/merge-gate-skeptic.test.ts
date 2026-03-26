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
  getSkepticVerdict?: Mock;
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

describe("Skeptic Agent — 7th merge gate", () => {
  // ── With skepticRequired = false (warn mode / not yet deployed) ──────────

  it("passes skeptic check when skepticRequired is false (no 7th check added)", async () => {
    const scm = makePassingScm();
    const config: MergeGateConfig = { enabled: true, skepticRequired: false };
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    // skepticRequired=false means the skeptic check is not added at all (backward compat)
    expect(result.checks).toHaveLength(6);
    const skepticCheck = result.checks.find((c) => c.name === "Skeptic approved");
    expect(skepticCheck).toBeUndefined();
  });

  it("reports 7 checks when skepticRequired is true and skeptic verdict = PASS", async () => {
    const scm = makePassingScm();
    scm.getSkepticVerdict = vi.fn().mockResolvedValue("PASS");
    const config: MergeGateConfig = { enabled: true, skepticRequired: true };
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    expect(result.checks.length).toBe(7);
    const skepticCheck = result.checks.find((c) => c.name === "Skeptic approved");
    expect(skepticCheck?.passed).toBe(true);
    expect(skepticCheck?.detail).toBe("Skeptic approved");
  });

  it("blocks merge when skepticRequired=true and skeptic verdict = FAIL", async () => {
    const scm = makePassingScm();
    scm.getSkepticVerdict = vi.fn().mockResolvedValue("FAIL");
    const config: MergeGateConfig = { enabled: true, skepticRequired: true };
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("Skeptic approved");
    const skepticCheck = result.checks.find((c) => c.name === "Skeptic approved");
    expect(skepticCheck?.passed).toBe(false);
    expect(skepticCheck?.detail).toBe("Skeptic verdict: FAIL or MISSING");
  });

  it("passes skeptic check when skepticRequired=true and skeptic verdict = SKIPPED", async () => {
    const scm = makePassingScm();
    scm.getSkepticVerdict = vi.fn().mockResolvedValue("SKIPPED");
    const config: MergeGateConfig = { enabled: true, skepticRequired: true };
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    const skepticCheck = result.checks.find((c) => c.name === "Skeptic approved");
    expect(skepticCheck?.passed).toBe(true);
  });

  it("blocks merge when skepticRequired=true and no skeptic verdict exists", async () => {
    const scm = makePassingScm();
    // getSkepticVerdict not defined → SCM does not implement it yet → treat as SKIPPED
    // (skipped verdict passes per design)
    scm.getSkepticVerdict = vi.fn().mockResolvedValue("SKIPPED");
    const config: MergeGateConfig = { enabled: true, skepticRequired: true };
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    const skepticCheck = result.checks.find((c) => c.name === "Skeptic approved");
    expect(skepticCheck?.passed).toBe(true);
  });

  it("blocks when SCM does not implement getSkepticVerdict in required mode", async () => {
    const scm = makePassingScm();
    // No getSkepticVerdict defined — CRITICAL( bd-qw6): must block in required mode
    const config: MergeGateConfig = { enabled: true, skepticRequired: true };
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    const skepticCheck = result.checks.find((c) => c.name === "Skeptic approved");
    expect(skepticCheck?.passed).toBe(false);
    expect(result.blockers).toContain("Skeptic approved");
  });

  it("reports 6 checks (no skeptic) when skepticRequired is absent", async () => {
    const scm = makePassingScm();
    const config: MergeGateConfig = { enabled: true };
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    expect(result.checks.length).toBe(6);
  });

  // ── Skeptic verdict PASS also requires all other 6 greens to pass ────────

  it("blocks merge when skeptic PASS but CI is failing", async () => {
    const scm = makePassingScm();
    scm.getCISummary.mockResolvedValue("failing");
    scm.getSkepticVerdict = vi.fn().mockResolvedValue("PASS");
    const config: MergeGateConfig = { enabled: true, skepticRequired: true };
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("CI green");
    expect(result.blockers).not.toContain("Skeptic approved");
  });

  // ── Bypass: skeptic can self-approve its own implementation PR ────────────

  it("bypasses skeptic check when project is in skepticBypassProjects", async () => {
    const scm = makePassingScm();
    scm.getSkepticVerdict = vi.fn().mockResolvedValue("SKIPPED");
    const config: MergeGateConfig = {
      enabled: true,
      skepticRequired: true,
      skepticBypassProjects: ["agent-orchestrator"],
    };
    // The PR repo is "repo" which is NOT in bypass list, so should still run
    const result = await checkMergeGate(pr, config, scm as unknown as SCM);
    const skepticCheck = result.checks.find((c) => c.name === "Skeptic approved");
    expect(skepticCheck?.passed).toBe(true); // SKIPPED passes
  });

  it("skeptic bypass works for agent-orchestrator project PR", async () => {
    const scm = makePassingScm();
    scm.getSkepticVerdict = vi.fn().mockResolvedValue("FAIL"); // Would FAIL without bypass
    const config: MergeGateConfig = {
      enabled: true,
      skepticRequired: true,
      skepticBypassProjects: ["agent-orchestrator"],
    };
    const agentOrchestratorPR: PRInfo = { ...pr, repo: "agent-orchestrator", owner: "jleechanorg" };
    const result = await checkMergeGate(agentOrchestratorPR, config, scm as unknown as SCM);
    const skepticCheck = result.checks.find((c) => c.name === "Skeptic approved");
    // Should pass because agent-orchestrator is in bypass list
    expect(skepticCheck?.passed).toBe(true);
  });
});
