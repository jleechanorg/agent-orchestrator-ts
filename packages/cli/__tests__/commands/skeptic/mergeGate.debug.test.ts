import { describe, it, expect, vi, beforeEach } from "vitest";

// All mocks hoisted so vi.mock factory can reference them
const mockGhJson = vi.hoisted(() => vi.fn());
const mockFetchReviews = vi.hoisted(() => vi.fn());
const mockGhJsonPaginate = vi.hoisted(() => vi.fn());

vi.mock("../../../src/commands/skeptic/gh-client.js", () => ({
  ghJson: mockGhJson,
  fetchReviews: mockFetchReviews,
  ghJsonPaginate: mockGhJsonPaginate,
}));

const { fetchMergeGateState } = await import("../../../src/commands/skeptic/mergeGate.js");

function setupGhJson(values: any[]) {
  mockGhJson.mockReset();
  mockFetchReviews.mockReset();
  mockGhJsonPaginate.mockReset();
  mockFetchReviews.mockResolvedValue([]);
  mockGhJsonPaginate.mockResolvedValue([]);
  values.forEach(v => mockGhJson.mockResolvedValueOnce(v));
}

describe("fetchMergeGateState — skeptic verdict parsing", () => {
  beforeEach(() => {
    mockGhJson.mockReset();
    mockFetchReviews.mockReset();
    mockGhJsonPaginate.mockReset();
    mockFetchReviews.mockResolvedValue([]);
    mockGhJsonPaginate.mockResolvedValue([]);
  });

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
    mockGhJson
      .mockResolvedValueOnce({ head: { ref: "main" }, mergeable: true })
      .mockResolvedValueOnce({ state: "success" })
      .mockResolvedValueOnce([]) // reviewThreads
      .mockRejectedValueOnce(new Error("API error")); // verdict comments throws

    const state = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

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
