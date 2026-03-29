import { describe, it, expect, vi, beforeEach } from "vitest";

// All mocks at module scope, hoisted before vi.mock
const mockGhJson = vi.hoisted(() => vi.fn());
const mockGhJsonPaginate = vi.hoisted(() => vi.fn());
const mockFetchReviews = vi.hoisted(() => vi.fn());
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

describe("fetchMergeGateState — skeptic verdict parsing", () => {
  beforeEach(() => {
    // Reset mocks before each test.
    mockGhJson.mockReset();
    mockFetchReviews.mockReset();
    mockFetchReviews.mockResolvedValue([]);
    mockGhJsonPaginate.mockReset();
    mockGhJsonPaginate.mockResolvedValue([]); // safe default
    realFetchIssueComments.mockReset();
    realFetchIssueComments.mockImplementation(() => mockGhJsonPaginate());
  });

  // Review threads response — empty threads so the GraphQL loop exits after 1 page
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
    mockGhJson
      .mockResolvedValueOnce({ head: { sha: "abc" }, mergeable: true })
      .mockResolvedValueOnce({ state: "success" })
      .mockResolvedValueOnce(emptyThreadsResponse);
    realFetchIssueComments.mockResolvedValueOnce([
      { id: 99, body: "VERDICT: SKIPPED — ANTHROPIC_API_KEY not configured", user: { login: "jleechan-agent[bot]" } },
    ]);

    const state = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(state.skepticVerdict).toBe("SKIPPED");
    expect(state.skepticCommentId).toBe(99);
  });

  it("parses VERDICT: PASS from skeptic bot issue comments", async () => {
    mockGhJson
      .mockResolvedValueOnce({ head: { sha: "abc" }, mergeable: true })
      .mockResolvedValueOnce({ state: "success" })
      .mockResolvedValueOnce(emptyThreadsResponse);
    realFetchIssueComments.mockResolvedValueOnce([
      { id: 98, body: "<!-- skeptic-agent-verdict -->\nVERDICT: PASS", user: { login: "jleechan-agent[bot]" } },
    ]);

    const state = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(state.skepticVerdict).toBe("PASS");
    expect(state.skepticCommentId).toBe(98);
  });

  it("parses VERDICT: FAIL from skeptic bot issue comments", async () => {
    mockGhJson
      .mockResolvedValueOnce({ head: { sha: "abc" }, mergeable: true })
      .mockResolvedValueOnce({ state: "success" })
      .mockResolvedValueOnce(emptyThreadsResponse);
    realFetchIssueComments.mockResolvedValueOnce([
      { id: 97, body: "VERDICT: FAIL — evidence bundle missing", user: { login: "jleechan-agent[bot]" } },
    ]);

    const state = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(state.skepticVerdict).toBe("FAIL");
    expect(state.skepticCommentId).toBe(97);
  });

  it("returns null skepticVerdict when no skeptic bot comment exists", async () => {
    mockGhJson
      .mockResolvedValueOnce({ head: { sha: "abc" }, mergeable: true })
      .mockResolvedValueOnce({ state: "success" })
      .mockResolvedValueOnce(emptyThreadsResponse);
    realFetchIssueComments.mockResolvedValueOnce([
      { id: 1, body: "hello world", user: { login: "someone" } },
    ]);

    const state = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(state.skepticVerdict).toBeNull();
    expect(state.skepticCommentId).toBeNull();
  });

  it("returns null skepticVerdict when issue comments fetch throws (non-fatal)", async () => {
    mockGhJson
      .mockResolvedValueOnce({ head: { sha: "abc" }, mergeable: true })
      .mockResolvedValueOnce({ state: "success" })
      .mockResolvedValueOnce(emptyThreadsResponse);
    realFetchIssueComments.mockRejectedValueOnce(new Error("API error"));

    const state = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    // Non-fatal — should still return state with null verdict
    expect(state.skepticVerdict).toBeNull();
    expect(state.skepticCommentId).toBeNull();
  });

  it("includes SKIPPED in full MergeGateState with CI passing", async () => {
    mockGhJson
      .mockResolvedValueOnce({ head: { sha: "abc" }, mergeable: true })
      .mockResolvedValueOnce({ state: "success" })
      .mockResolvedValueOnce(emptyThreadsResponse);
    realFetchIssueComments.mockResolvedValueOnce([
      { id: 50, body: "VERDICT: SKIPPED", user: { login: "jleechan-agent[bot]" } },
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
