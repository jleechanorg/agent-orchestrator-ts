import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted() MUST come BEFORE vi.mock() in source order
const mockGhJson = vi.hoisted(() => vi.fn());
const mockFetchReviews = vi.hoisted(() => vi.fn());

vi.mock("../../../src/commands/skeptic/gh-client.js", () => ({
  ghJson: mockGhJson,
  fetchReviews: mockFetchReviews,
}));

const { fetchMergeGateState } = await import("../../../src/commands/skeptic/mergeGate.js");

function setupGhJson(values: unknown[]) {
  mockGhJson.mockReset();
  mockFetchReviews.mockReset();
  mockFetchReviews.mockResolvedValue([]);
  values.forEach(v => mockGhJson.mockResolvedValueOnce(v as any));
}

describe("fetchMergeGateState — skeptic verdict parsing", () => {
  beforeEach(() => {
    mockGhJson.mockReset();
    mockFetchReviews.mockReset();
    mockFetchReviews.mockResolvedValue([]);
  });

  it("parses VERDICT: SKIPPED from skeptic bot issue comments", async () => {
    setupGhJson([
      { head: { ref: "main" }, mergeable: true },
      { state: "success" },
      [],
      [{ id: 99, body: "VERDICT: SKIPPED — ANTHROPIC_API_KEY not configured", user: { login: "jleechan-agent[bot]" } }],
    ]);

    const state = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(state.skepticVerdict).toBe("SKIPPED");
    expect(state.skepticCommentId).toBe(99);
  });

  it("parses VERDICT: PASS from skeptic bot issue comments", async () => {
    setupGhJson([
      { head: { ref: "main" }, mergeable: true },
      { state: "success" },
      [],
      [{ id: 98, body: "<!-- skeptic-agent-verdict -->\nVERDICT: PASS", user: { login: "jleechan-agent[bot]" } }],
    ]);

    const state = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(state.skepticVerdict).toBe("PASS");
    expect(state.skepticCommentId).toBe(98);
  });

  it("parses VERDICT: FAIL from skeptic bot issue comments", async () => {
    setupGhJson([
      { head: { ref: "main" }, mergeable: true },
      { state: "success" },
      [],
      [{ id: 97, body: "VERDICT: FAIL — evidence bundle missing", user: { login: "jleechan-agent[bot]" } }],
    ]);

    const state = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(state.skepticVerdict).toBe("FAIL");
    expect(state.skepticCommentId).toBe(97);
  });

  it("returns null skepticVerdict when no skeptic bot comment exists", async () => {
    setupGhJson([
      { head: { ref: "main" }, mergeable: true },
      { state: "success" },
      [{ id: 1, body: "hello world", user: { login: "someone" } }],
      [],
    ]);

    const state = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(state.skepticVerdict).toBeNull();
    expect(state.skepticCommentId).toBeNull();
  });

  it("returns null skepticVerdict when issue comments ghJson throws (non-fatal)", async () => {
    let idx = 0;
    mockGhJson.mockImplementation((..._args: unknown[]) => {
      idx++;
      if (idx === 4) throw new Error("API error");
      const vals = [
        { head: { ref: "main" }, mergeable: true },
        { state: "success" },
        [],
      ];
      return Promise.resolve(vals[idx - 1] ?? null);
    });

    const state = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(state.skepticVerdict).toBeNull();
  });

  it("includes SKIPPED in full MergeGateState with CI passing", async () => {
    setupGhJson([
      { head: { ref: "main" }, mergeable: true },
      { state: "success" },
      [],
      [{ id: 50, body: "VERDICT: SKIPPED", user: { login: "jleechan-agent[bot]" } }],
    ]);

    const state = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(state.skepticVerdict).toBe("SKIPPED");
    expect(state.skepticCommentId).toBe(50);
    expect(state.ciPassing).toBe(true);
    expect(state.noConflicts).toBe(true);
  });
});
