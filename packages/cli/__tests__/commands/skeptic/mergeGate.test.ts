import { describe, it, expect, vi, beforeEach } from "vitest";

// Both mocks are at module scope, hoisted before vi.mock
const mockGhJson = vi.hoisted(() => vi.fn());
const mockGhJsonPaginate = vi.hoisted(() => vi.fn());
const mockFetchReviews = vi.hoisted(() => vi.fn());

vi.mock("../../../src/commands/skeptic/gh-client.js", () => ({
  ghJson: mockGhJson,
  ghJsonPaginate: mockGhJsonPaginate,
  fetchReviews: mockFetchReviews,
}));

const { fetchMergeGateState } = await import("../../../src/commands/skeptic/mergeGate.js");

describe("fetchMergeGateState — skeptic verdict parsing", () => {
  beforeEach(() => {
    mockGhJson.mockReset();
    mockGhJsonPaginate.mockReset();
    mockGhJsonPaginate.mockResolvedValue({ check_runs: [] });
    mockFetchReviews.mockReset();
    mockFetchReviews.mockResolvedValue([]);
  });

  /**
   * Mock queue setup (mergeGate.ts now makes 5 ghJson calls before verdict block):
   * #1 ghJson("repos/{owner}/{repo}/pulls/{prNumber}")
   * #2 ghJson("repos/{owner}/{repo}/commits/{ref}/status")
   * #3 ghJson("graphql" — reviewThreads, first page)
   * [fetchReviews mocked — does not consume ghJson]
   * #4 ghJson("repos/{owner}/{repo}/issues/{prNumber}/comments")
   */
  function setupGhJson(values: any[]) {
    mockGhJson.mockReset();
    values.forEach(v => mockGhJson.mockResolvedValueOnce(v));
  }

  // Review threads response for #3 — empty threads so the loop exits after 1 page
  const emptyThreadsResponse = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false },
            nodes: [],
          },
        },
      },
    },
  };

  it("parses VERDICT: SKIPPED from skeptic bot issue comments", async () => {
    setupGhJson([
      { head: { sha: "abc" }, mergeable: true },
      { state: "success" },
      emptyThreadsResponse,
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
      { head: { sha: "abc" }, mergeable: true },
      { state: "success" },
      emptyThreadsResponse,
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
      { head: { sha: "abc" }, mergeable: true },
      { state: "success" },
      emptyThreadsResponse,
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
      { head: { sha: "abc" }, mergeable: true },
      { state: "success" },
      emptyThreadsResponse,
      [],
    ]);

    const state = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(state.skepticVerdict).toBeNull();
    expect(state.skepticCommentId).toBeNull();
  });

  it("returns null skepticVerdict when issue comments ghJson throws (non-fatal)", async () => {
    mockGhJson.mockReset();
    mockFetchReviews.mockReset();
    mockFetchReviews.mockResolvedValue([]);
    mockGhJson
      .mockResolvedValueOnce({ head: { sha: "abc" }, mergeable: true })
      .mockResolvedValueOnce({ state: "success" })
      .mockResolvedValueOnce(emptyThreadsResponse)
      .mockRejectedValueOnce(new Error("API error")); // #4 throws

    const state = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    // Non-fatal — should still return state with null verdict
    expect(state.skepticVerdict).toBeNull();
  });

  it("includes SKIPPED in full MergeGateState with CI passing", async () => {
    setupGhJson([
      { head: { sha: "abc" }, mergeable: true },
      { state: "success" },
      emptyThreadsResponse,
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
