/**
 * Unit tests for skeptic/posting.ts
 *
 * Covers: posting full LLM output in verdict comments so FAIL/SKIPPED bodies
 * always carry context. Tests the llmOutput parameter that was added to fix
 * the "empty FAIL comment" bug (bd-qw6 follow-up).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { postVerdict } from "../../../src/commands/skeptic/posting.js";

// Track calls to the mocked helpers — stored in a plain object so the mock
// factory (which runs at module-load time, before beforeEach) can reference it.
const state: {
  calls: Array<{ fn: "create" | "patch"; owner: string; repo: string; prNumber: number; commentId?: number; body: string }>;
  createMock: ReturnType<typeof vi.fn>;
  patchMock: ReturnType<typeof vi.fn>;
} = {
  calls: [],
  createMock: vi.fn(),
  patchMock: vi.fn(),
};

vi.mock("../../../src/commands/skeptic/gh-client.js", () => ({
  patchComment: (...args: unknown[]) => {
    const [owner, repo, commentId, body] = args as [string, string, number, string];
    state.calls.push({ fn: "patch", owner, repo, prNumber: 0, body, commentId });
    return state.patchMock(...args);
  },
  createComment: (...args: unknown[]) => {
    const [owner, repo, prNumber, body] = args as [string, string, number, string];
    state.calls.push({ fn: "create", owner, repo, prNumber, body });
    return state.createMock(...args);
  },
}));

describe("postVerdict", () => {
  beforeEach(() => {
    state.calls.length = 0;
  });

  it("posts full LLM output in FAIL comment body", async () => {
    // This was the bug: LLM outputs "VERDICT: FAIL\nMissing tests" but only
    // "VERDICT: FAIL" was posted, discarding the explanation.
    const llmOutput =
      "VERDICT: FAIL\n\nThe PR is missing unit tests for the new productivity-checker module.";
    await postVerdict(
      "owner",
      "repo",
      123,
      "VERDICT: FAIL",
      null,
      "jleechan2015",
      "abc1234",
      llmOutput,
    );

    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]!.fn).toBe("create");
    expect(state.calls[0]!.body).toContain("VERDICT: FAIL");
    expect(state.calls[0]!.body).toContain("The PR is missing unit tests");
  });

  it("includes full LLM output in SKIPPED comment body", async () => {
    const llmOutput = "VERDICT: SKIPPED — infra: Neither Claude nor Codex available.";
    await postVerdict(
      "owner",
      "repo",
      456,
      "VERDICT: SKIPPED",
      null,
      "jleechan2015",
      undefined,
      llmOutput,
    );

    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]!.fn).toBe("create");
    expect(state.calls[0]!.body).toContain("VERDICT: SKIPPED");
    expect(state.calls[0]!.body).toContain("Neither Claude nor Codex available");
  });

  it("does not duplicate output when llmOutput === verdict (no trailing text)", async () => {
    // When the LLM output IS just the verdict line (no trailing explanation),
    // the full output section should not be added as a duplicate.
    const verdictLine = "VERDICT: FAIL";
    await postVerdict("owner", "repo", 789, verdictLine, null, "jleechan2015", undefined, verdictLine);

    expect(state.calls).toHaveLength(1);
    // Body should contain verdict but NOT the separator twice
    expect(state.calls[0]!.body).toContain("VERDICT: FAIL");
    const occurrences = (state.calls[0]!.body.match(/VERDICT: FAIL/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it("updates existing comment when commentId is provided", async () => {
    await postVerdict(
      "owner",
      "repo",
      123,
      "VERDICT: PASS",
      99999,
      "jleechan2015",
      "deadbeef",
      "VERDICT: PASS",
    );

    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]!.fn).toBe("patch");
    expect(state.calls[0]!.commentId).toBe(99999);
  });

  it("includes trigger SHA marker when provided", async () => {
    await postVerdict(
      "owner",
      "repo",
      123,
      "VERDICT: PASS",
      null,
      "jleechan2015",
      "a1b2c3d4",
      "VERDICT: PASS",
    );

    expect(state.calls[0]!.body).toContain("<!-- skeptic-gate-trigger-a1b2c3d4 -->");
  });

  it("omits trigger SHA marker when triggerSha is undefined", async () => {
    await postVerdict(
      "owner",
      "repo",
      123,
      "VERDICT: PASS",
      null,
      "jleechan2015",
      undefined,
      "VERDICT: PASS",
    );

    expect(state.calls[0]!.body).not.toContain("skeptic-gate-trigger-");
  });

  it("includes HTML comment marker for idempotent lookup", async () => {
    await postVerdict(
      "owner",
      "repo",
      123,
      "VERDICT: FAIL",
      null,
      "jleechan2015",
      undefined,
      "VERDICT: FAIL",
    );

    expect(state.calls[0]!.body).toContain("<!-- skeptic-agent-verdict -->");
  });
});
