import { describe, it, expect, vi, beforeEach } from "vitest";
// All mocks are hoisted before vi.mock runs.
const mockGhJsonPaginate = vi.hoisted(() => vi.fn(() => Promise.resolve(null)));
const mockGhJson = vi.hoisted(() => vi.fn(() => Promise.resolve(null)));
const mockFetchReviews = vi.hoisted(() => vi.fn(() => Promise.resolve([])));
// fetchIssueComments must be re-exported from the mock so mergeGate.ts gets a
// defined (not undefined) function when it imports from gh-client.js.
const realFetchIssueComments = vi.hoisted(() => vi.fn());

vi.mock("../../../src/commands/skeptic/gh-client.js", () => ({
  ghJson: mockGhJson,
  ghJsonPaginate: mockGhJsonPaginate,
  fetchReviews: mockFetchReviews,
  fetchIssueComments: realFetchIssueComments,
}));

const { fetchMergeGateState } = await import("../../../src/commands/skeptic/mergeGate.js");

describe("fetchMergeGateState -- skeptic verdict parsing", () => {
  beforeEach(() => {
    // Reset mocks before each test.
    // Do NOT reset mockGhJsonPaginate in the global beforeEach —
    // individual tests call setupGhJsonPaginate to set up queues.
    mockGhJson.mockReset();
    mockFetchReviews.mockReset();
    mockFetchReviews.mockResolvedValue([]);
    mockGhJsonPaginate.mockReset();
    mockGhJsonPaginate.mockResolvedValue([]); // safe default
    realFetchIssueComments.mockReset();
    realFetchIssueComments.mockImplementation(() => mockGhJsonPaginate());
  });

  function setupGhJson(values) {
    mockGhJson.mockReset();
    mockFetchReviews.mockReset();
    mockFetchReviews.mockResolvedValue([]);
    mockGhJson.mockImplementation(() => Promise.resolve(null));
    values.forEach(v => mockGhJson.mockResolvedValueOnce(v));
  }

  function setupGhJsonPaginate(values) {
    mockGhJsonPaginate.mockReset();
    values.forEach(v => mockGhJsonPaginate.mockResolvedValueOnce(v));
    realFetchIssueComments.mockReset();
    realFetchIssueComments.mockImplementation(() => mockGhJsonPaginate());
  }

  it("parses VERDICT: SKIPPED from skeptic bot issue comments", async () => {
    setupGhJson([
      { head: { ref: "main", sha: "abc123" }, mergeable: true },
      { state: "success" },
      { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } },
    ]);
    setupGhJsonPaginate([
      [], // check-runs
      [{ id: 99, body: "VERDICT: SKIPPED \u2014 ANTHROPIC_API_KEY not configured", user: { login: "jleechan-agent[bot]" } }],
    ]);

    const state = await fetchMergeGateState("test", "test-repo", 1, "jleechan-agent[bot]");

    expect(state.skepticVerdict).toBe("SKIPPED");
    expect(state.skepticCommentId).toBe(99);
  });

  it("parses VERDICT: PASS from skeptic bot issue comments", async () => {
    setupGhJson([
      { head: { ref: "main", sha: "abc123" }, mergeable: true },
      { state: "success" },
      { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } },
    ]);
    setupGhJsonPaginate([
      [], // check-runs
      [{ id: 98, body: "<!-- skeptic-agent-verdict -->\nVERDICT: PASS", user: { login: "jleechan-agent[bot]" } }],
    ]);

    const state = await fetchMergeGateState("test", "test-repo", 1, "jleechan-agent[bot]");

    expect(state.skepticVerdict).toBe("PASS");
    expect(state.skepticCommentId).toBe(98);
  });

  it("parses VERDICT: FAIL from skeptic bot issue comments", async () => {
    setupGhJson([
      { head: { ref: "main", sha: "abc123" }, mergeable: true },
      { state: "success" },
      { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } },
    ]);
    setupGhJsonPaginate([
      [], // check-runs
      [{ id: 97, body: "VERDICT: FAIL \u2014 evidence bundle missing", user: { login: "jleechan-agent[bot]" } }],
    ]);

    const state = await fetchMergeGateState("test", "test-repo", 1, "jleechan-agent[bot]");

    expect(state.skepticVerdict).toBe("FAIL");
    expect(state.skepticCommentId).toBe(97);
  });

  it("returns null skepticVerdict when no skeptic bot comment exists", async () => {
    setupGhJson([
      { head: { ref: "main", sha: "abc123" }, mergeable: true },
      { state: "success" },
      { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } },
    ]);
    setupGhJsonPaginate([
      [], // check-runs
      [{ id: 1, body: "hello world", user: { login: "someone" } }],
    ]);

    const state = await fetchMergeGateState("test", "test-repo", 1, "jleechan-agent[bot]");

    expect(state.skepticVerdict).toBeNull();
    expect(state.skepticCommentId).toBeNull();
  });

  it("returns null skepticVerdict when issue comments ghJsonPaginate throws (non-fatal)", async () => {
    setupGhJson([
      { head: { ref: "main", sha: "abc123" }, mergeable: true },
      { state: "success" },
      { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } },
    ]);
    mockGhJsonPaginate.mockReset();
    mockGhJsonPaginate
      .mockResolvedValueOnce([]) // check-runs OK
      .mockRejectedValueOnce(new Error("API error")); // issue comments throws
    realFetchIssueComments.mockReset();
    realFetchIssueComments.mockImplementation(() => mockGhJsonPaginate());

    const state = await fetchMergeGateState("test", "test-repo", 1, "jleechan-agent[bot]");

    expect(state.skepticVerdict).toBeNull();
  });

  it("includes SKIPPED in full MergeGateState with CI passing", async () => {
    setupGhJson([
      { head: { ref: "main", sha: "abc123" }, mergeable: true },
      { state: "success" },
      { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } },
    ]);
    setupGhJsonPaginate([
      [], // check-runs
      [{ id: 50, body: "VERDICT: SKIPPED", user: { login: "jleechan-agent[bot]" } }],
    ]);

    const state = await fetchMergeGateState("test", "test-repo", 1, "jleechan-agent[bot]");

    expect(state.skepticVerdict).toBe("SKIPPED");
    expect(state.skepticCommentId).toBe(50);
    expect(state.ciPassing).toBe(true);
    expect(state.noConflicts).toBe(true);
  });
});
