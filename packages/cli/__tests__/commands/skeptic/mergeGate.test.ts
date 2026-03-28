import { describe, it, expect, vi, beforeEach } from "vitest";

// Both mocks are at module scope, hoisted before vi.mock
const mockGhJson = vi.hoisted(() => vi.fn());
const mockFetchReviews = vi.hoisted(() => vi.fn());

vi.mock("../../../src/commands/skeptic/gh-client.js", () => ({
  ghJson: mockGhJson,
  fetchReviews: mockFetchReviews,
}));

const { fetchMergeGateState } = await import("../../../src/commands/skeptic/mergeGate.js");

describe("fetchMergeGateState — skeptic verdict parsing", () => {
  beforeEach(() => {
    // mockGhJson queue is reset in setupGhJson() per-test
    // only reset fetchReviews here
    mockFetchReviews.mockResolvedValue([]);
  });

  /**
   * Mock queue setup:
   * #1 ghJson("repos/{owner}/{repo}/pulls/{prNumber}")
   * #2 ghJson("repos/{owner}/{repo}/commits/{ref}/status")
   * [fetchReviews mocked — does not consume ghJson]
   * #3 ghJson("repos/{owner}/{repo}/pulls/{prNumber}/comments")
   * #4 ghJson("repos/{owner}/{repo}/issues/{prNumber}/comments")
   */
  function setupGhJson(inlineComments: unknown[] = []) {
    mockGhJson.mockReset(); // clear previous queue
    mockGhJson
      .mockResolvedValueOnce({ head: { ref: "main" }, mergeable: true }) // #1 PR
      .mockResolvedValueOnce({ state: "success" }) // #2 CI
      .mockResolvedValueOnce(inlineComments); // #3 inline comments
    // #4 set per-test
  }

  it("parses VERDICT: SKIPPED from skeptic bot issue comments", async () => {
    const comments = [
      { id: 99, body: "VERDICT: SKIPPED — ANTHROPIC_API_KEY not configured", user: { login: "jleechan-agent[bot]" } },
    ];
    setupGhJson([]);
    mockGhJson.mockResolvedValueOnce(comments); // #4

    const state = await fetchMergeGateState({
      owner: "test",
      repo: "test-repo",
      prNumber: 1,
      skepticBotAuthor: "jleechan-agent[bot]",
    });

    expect(state.skepticVerdict).toBe("SKIPPED");
    expect(state.skepticCommentId).toBe(99);
  });

  it("parses VERDICT: PASS from skeptic bot issue comments", async () => {
    const comments = [
      { id: 98, body: "<!-- skeptic-agent-verdict -->\nVERDICT: PASS", user: { login: "jleechan-agent[bot]" } },
    ];
    setupGhJson([]);
    mockGhJson.mockResolvedValueOnce(comments);

    const state = await fetchMergeGateState({
      owner: "test",
      repo: "test-repo",
      prNumber: 1,
      skepticBotAuthor: "jleechan-agent[bot]",
    });

    expect(state.skepticVerdict).toBe("PASS");
    expect(state.skepticCommentId).toBe(98);
  });

  it("parses VERDICT: FAIL from skeptic bot issue comments", async () => {
    const comments = [
      { id: 97, body: "VERDICT: FAIL — evidence bundle missing", user: { login: "jleechan-agent[bot]" } },
    ];
    setupGhJson([]);
    mockGhJson.mockResolvedValueOnce(comments);

    const state = await fetchMergeGateState({
      owner: "test",
      repo: "test-repo",
      prNumber: 1,
      skepticBotAuthor: "jleechan-agent[bot]",
    });

    expect(state.skepticVerdict).toBe("FAIL");
    expect(state.skepticCommentId).toBe(97);
  });

  it("returns null skepticVerdict when no skeptic bot comment exists", async () => {
    setupGhJson([{ id: 1, body: "hello world", user: { login: "someone" } }]);
    // #4 not set — returns undefined → caught by try/catch → verdict stays null

    const state = await fetchMergeGateState({
      owner: "test",
      repo: "test-repo",
      prNumber: 1,
      skepticBotAuthor: "jleechan-agent[bot]",
    });

    expect(state.skepticVerdict).toBeNull();
    expect(state.skepticCommentId).toBeNull();
  });

  it("returns null skepticVerdict when issue comments ghJson throws (non-fatal)", async () => {
    setupGhJson([]);
    mockGhJson.mockRejectedValueOnce(new Error("API error")); // #4 throws

    const state = await fetchMergeGateState({
      owner: "test",
      repo: "test-repo",
      prNumber: 1,
      skepticBotAuthor: "jleechan-agent[bot]",
    });

    // Non-fatal — should still return state with null verdict
    expect(state.skepticVerdict).toBeNull();
  });

  it("includes SKIPPED in full MergeGateState with CI passing", async () => {
    const comments = [
      { id: 50, body: "VERDICT: SKIPPED", user: { login: "jleechan-agent[bot]" } },
    ];
    setupGhJson([]);
    mockGhJson.mockResolvedValueOnce(comments);

    const state = await fetchMergeGateState({
      owner: "test",
      repo: "test-repo",
      prNumber: 1,
      skepticBotAuthor: "jleechan-agent[bot]",
    });

    expect(state.skepticVerdict).toBe("SKIPPED");
    expect(state.skepticCommentId).toBe(50);
    expect(state.ciPassing).toBe(true);
    expect(state.noConflicts).toBe(true);
  });
});
