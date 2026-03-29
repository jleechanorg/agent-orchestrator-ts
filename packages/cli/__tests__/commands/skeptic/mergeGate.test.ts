import { describe, it, expect, vi, beforeEach } from "vitest";

// All three mocks at module scope, hoisted before vi.mock
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
    mockFetchReviews.mockReset();
    mockFetchReviews.mockResolvedValue([]);
  });

  /**
   * Mock call sequence when head.sha is present:
   * ghJson:
   *   #1 "repos/{owner}/{repo}/pulls/{prNumber}"
   *   #2 "repos/{owner}/{repo}/commits/{sha}/status"
   *   #3 GraphQL reviewThreads
   * ghJsonPaginate:
   *   #4 check-runs
   *   #5 issue comments  ← verdict lives here
   * fetchReviews: mocked separately (does not consume ghJson/ghJsonPaginate)
   */
  function setupGhJson(values: any[]) {
    mockGhJson.mockReset();
    mockGhJsonPaginate.mockReset();
    mockFetchReviews.mockReset();
    mockFetchReviews.mockResolvedValue([]);
    let idx = 0;
    mockGhJson.mockImplementation((endpoint: string) => {
      console.log(`  ghJson[${idx}] → ${String(endpoint).slice(0, 60)}`);
      idx++;
      return Promise.resolve(null);
    });
    values.forEach(v => mockGhJson.mockResolvedValueOnce(v));
  }

  function setupGhJsonPaginate(values: any[]) {
    values.forEach(v => mockGhJsonPaginate.mockResolvedValueOnce(v));
  }

  it("parses VERDICT: SKIPPED from skeptic bot issue comments", async () => {
    setupGhJson([
      { head: { ref: "main", sha: "abc123" }, mergeable: true },
      { state: "success" },
      { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }, // GraphQL
    ]);
    setupGhJsonPaginate([
      [], // check-runs
      [{ id: 99, body: "VERDICT: SKIPPED — ANTHROPIC_API_KEY not configured", user: { login: "jleechan-agent[bot]" } }], // issue comments
    ]);

    const state = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(state.skepticVerdict).toBe("SKIPPED");
    expect(state.skepticCommentId).toBe(99);
  });

  it("parses VERDICT: PASS from skeptic bot issue comments", async () => {
    setupGhJson([
      { head: { ref: "main", sha: "abc123" }, mergeable: true },
      { state: "success" },
      { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }, // GraphQL
    ]);
    setupGhJsonPaginate([
      [], // check-runs
      [{ id: 98, body: "<!-- skeptic-agent-verdict -->\nVERDICT: PASS", user: { login: "jleechan-agent[bot]" } }], // issue comments
    ]);

    const state = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(state.skepticVerdict).toBe("PASS");
    expect(state.skepticCommentId).toBe(98);
  });

  it("parses VERDICT: FAIL from skeptic bot issue comments", async () => {
    setupGhJson([
      { head: { ref: "main", sha: "abc123" }, mergeable: true },
      { state: "success" },
      { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }, // GraphQL
    ]);
    setupGhJsonPaginate([
      [], // check-runs
      [{ id: 97, body: "VERDICT: FAIL — evidence bundle missing", user: { login: "jleechan-agent[bot]" } }], // issue comments
    ]);

    const state = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(state.skepticVerdict).toBe("FAIL");
    expect(state.skepticCommentId).toBe(97);
  });

  it("returns null skepticVerdict when no skeptic bot comment exists", async () => {
    setupGhJson([
      { head: { ref: "main", sha: "abc123" }, mergeable: true },
      { state: "success" },
      { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }, // GraphQL
    ]);
    setupGhJsonPaginate([
      [], // check-runs
      [{ id: 1, body: "hello world", user: { login: "someone" } }], // no skeptic bot comments
    ]);

    const state = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(state.skepticVerdict).toBeNull();
    expect(state.skepticCommentId).toBeNull();
  });

  it("returns null skepticVerdict when issue comments ghJsonPaginate throws (non-fatal)", async () => {
    setupGhJson([
      { head: { ref: "main", sha: "abc123" }, mergeable: true },
      { state: "success" },
      { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }, // GraphQL
    ]);
    mockGhJsonPaginate
      .mockResolvedValueOnce([]) // check-runs OK
      .mockRejectedValueOnce(new Error("API error")); // issue comments throws

    const state = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    // Non-fatal — should still return state with null verdict
    expect(state.skepticVerdict).toBeNull();
  });

  it("includes SKIPPED in full MergeGateState with CI passing", async () => {
    setupGhJson([
      { head: { ref: "main", sha: "abc123" }, mergeable: true },
      { state: "success" },
      { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }, // GraphQL
    ]);
    setupGhJsonPaginate([
      [], // check-runs
      [{ id: 50, body: "VERDICT: SKIPPED", user: { login: "jleechan-agent[bot]" } }], // issue comments
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
