import { describe, it, expect, vi, beforeEach } from "vitest";

// All mocks hoisted so vi.mock factory can reference them
const mockGhJson = vi.hoisted(() => vi.fn());
const mockFetchReviews = vi.hoisted(() => vi.fn());
const mockGhJsonPaginate = vi.hoisted(() => vi.fn());

// Use arrow returning object to avoid calling mocks in factory
vi.mock("../../../src/commands/skeptic/gh-client.js", () => ({
  ghJson: mockGhJson,
  fetchReviews: mockFetchReviews,
  ghJsonPaginate: mockGhJsonPaginate,
}));

const { fetchMergeGateState } = await import("../../../src/commands/skeptic/mergeGate.js");

describe("fetchMergeGateState — skeptic verdict parsing", () => {
  beforeEach(() => {
    mockGhJson.mockReset();
    mockFetchReviews.mockReset();
    mockGhJsonPaginate.mockReset();
    // Default resolved values for non-verdict calls
    mockFetchReviews.mockResolvedValue([]);
    mockGhJsonPaginate.mockResolvedValue([]);
  });

  /**
   * Mock queue setup (ghJson) — matches fetchMergeGateState call sequence.
   *
   * fetchReviews() is mocked separately via mockResolvedValue([]) and does NOT
   * consume ghJson values (vi.mock intercepts the import so the real fn body
   * that calls ghJson never runs — only the mock return value is used).
   *
   * Call sequence when head.sha is provided:
   * #1 ghJson("repos/{owner}/{repo}/pulls/{prNumber}")       ← PR data
   * #2 ghJson("repos/{owner}/{repo}/commits/{sha}/status")   ← commit status
   * #3 ghJson("graphql" — reviewThreads pagination, first page)
   * #4 ghJson("repos/.../issues/.../comments")               ← verdict comments
   *
   * [ghJsonPaginate mocked separately — does not consume ghJson]
   */
  function setupGhJson(values: any[]) {
    mockGhJson.mockReset();
    values.forEach(v => mockGhJson.mockResolvedValueOnce(v));
  }

  it("parses VERDICT: SKIPPED from skeptic bot issue comments", async () => {
    setupGhJson([
      { head: { ref: "main", sha: "abc123" }, mergeable: true },
      { state: "success" },
      [], // reviewThreads
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
      { head: { ref: "main", sha: "abc123" }, mergeable: true },
      { state: "success" },
      [], // reviewThreads
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
      { head: { ref: "main", sha: "abc123" }, mergeable: true },
      { state: "success" },
      [], // reviewThreads
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
      { head: { ref: "main", sha: "abc123" }, mergeable: true },
      { state: "success" },
      [], // reviewThreads
      [{ id: 1, body: "hello world", user: { login: "someone" } }],
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
    mockGhJsonPaginate.mockReset();
    mockFetchReviews.mockResolvedValue([]);
    mockGhJsonPaginate.mockResolvedValue([]);
    // ghJson call sequence: #1 PR → #2 commit status → #3 reviewThreads → #4 verdict (throws)
    mockGhJson
      .mockResolvedValueOnce({ head: { ref: "main" }, mergeable: true })
      .mockResolvedValueOnce({ state: "success" })
      .mockResolvedValueOnce([]) // reviewThreads
      .mockRejectedValueOnce(new Error("API error")); // verdict comments throws

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
      [], // reviewThreads
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
