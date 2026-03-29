import { describe, it, expect, vi, beforeEach } from "vitest";

// Mutable state shared between mock factory (once) and test setup (per-test).
const mockState = {
  ghJsonValues: [] as unknown[],
  ghJsonPaginateValues: [] as unknown[],
  fetchReviewsResult: [] as unknown[],
};

// Stable mock functions created once at module scope.
const mockGhJson = vi.hoisted(() =>
  vi.fn((_endpoint: string) => {
    if (mockState.ghJsonValues.length === 0) return Promise.resolve({});
    return Promise.resolve(mockState.ghJsonValues.shift());
  }),
);

const mockGhJsonPaginate = vi.hoisted(() =>
  vi.fn((_endpoint: string) => {
    if (mockState.ghJsonPaginateValues.length === 0) return Promise.resolve([]);
    const val = mockState.ghJsonPaginateValues.shift();
    if (val instanceof Promise) return val as Promise<never>;
    return Promise.resolve(val);
  }),
);

const mockFetchReviews = vi.hoisted(() =>
  vi.fn(() => Promise.resolve(mockState.fetchReviewsResult)),
);

vi.mock("../../../src/commands/skeptic/gh-client.js", () => ({
  ghJson: mockGhJson,
  ghJsonPaginate: mockGhJsonPaginate,
  fetchReviews: mockFetchReviews,
}));

const { fetchMergeGateState } = await import(
  "../../../src/commands/skeptic/mergeGate.js"
);

describe("fetchMergeGateState — skeptic verdict parsing", () => {
  beforeEach(() => {
    mockState.ghJsonValues = [];
    mockState.ghJsonPaginateValues = [];
    mockState.fetchReviewsResult = [];
  });

  /**
   * Actual call order in fetchMergeGateState:
   *
   * ghJson:
   *  #1 ghJson("repos/{o}/{r}/pulls/{n}") → prData
   *  #2 ghJson("repos/{o}/{r}/commits/{sha}/status") → commitStatus
   *  #3 ghJson("graphql", ...) → review threads (non-fatal try-catch)
   *
   * ghJsonPaginate:
   *  #A ghJsonPaginate(".../commits/{sha}/check-runs?per_page=100", {targetKey:"check_runs"})
   *                                                     → checkRuns (non-fatal try-catch)
   *  #B ghJsonPaginate(".../issues/{n}/comments?per_page=100")
   *                                                     → VERDICT comments ← main test target
   */
  function setup(opts: {
    ghJson?: unknown[];
    paginate?: unknown[];
    fetchReviews?: unknown[];
  }) {
    mockState.ghJsonValues = opts.ghJson ?? [];
    mockState.ghJsonPaginateValues = opts.paginate ?? [];
    mockState.fetchReviewsResult = opts.fetchReviews ?? [];
  }

  it("parses VERDICT: SKIPPED from skeptic bot issue comments", async () => {
    setup({
      ghJson: [
        { head: { sha: "abc123" }, mergeable: true },
        { state: "success" },
        [],
      ],
      paginate: [
        [],
        [{ id: 99, body: "VERDICT: SKIPPED — ANTHROPIC_API_KEY not configured", user: { login: "jleechan-agent[bot]" } }],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(result.skepticVerdict).toBe("SKIPPED");
    expect(result.skepticCommentId).toBe(99);
  });

  it("parses VERDICT: PASS from skeptic bot issue comments", async () => {
    setup({
      ghJson: [
        { head: { sha: "abc123" }, mergeable: true },
        { state: "success" },
        [],
      ],
      paginate: [
        [],
        [{ id: 98, body: "<!-- skeptic-agent-verdict -->\nVERDICT: PASS", user: { login: "jleechan-agent[bot]" } }],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(result.skepticVerdict).toBe("PASS");
    expect(result.skepticCommentId).toBe(98);
  });

  it("parses VERDICT: FAIL from skeptic bot issue comments", async () => {
    setup({
      ghJson: [
        { head: { sha: "abc123" }, mergeable: true },
        { state: "success" },
        [],
      ],
      paginate: [
        [],
        [{ id: 97, body: "VERDICT: FAIL — evidence bundle missing", user: { login: "jleechan-agent[bot]" } }],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(result.skepticVerdict).toBe("FAIL");
    expect(result.skepticCommentId).toBe(97);
  });

  it("returns null skepticVerdict when no skeptic bot comment exists", async () => {
    setup({
      ghJson: [
        { head: { sha: "abc123" }, mergeable: true },
        { state: "success" },
        [],
      ],
      paginate: [
        [],
        [{ id: 1, body: "hello world", user: { login: "someone" } }],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(result.skepticVerdict).toBeNull();
    expect(result.skepticCommentId).toBeNull();
  });

  it("returns null skepticVerdict when issue comments ghJsonPaginate throws (non-fatal)", async () => {
    setup({
      ghJson: [
        { head: { sha: "abc123" }, mergeable: true },
        { state: "success" },
        [],
      ],
      paginate: [
        [],
        Promise.reject(new Error("API error")),
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(result.skepticVerdict).toBeNull();
  });

  it("includes SKIPPED in full MergeGateState with CI passing", async () => {
    setup({
      ghJson: [
        { head: { sha: "abc123" }, mergeable: true },
        { state: "success" },
        [],
      ],
      paginate: [
        [],
        [{ id: 50, body: "VERDICT: SKIPPED", user: { login: "jleechan-agent[bot]" } }],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(result.skepticVerdict).toBe("SKIPPED");
    expect(result.skepticCommentId).toBe(50);
    expect(result.ciPassing).toBe(true);
    expect(result.noConflicts).toBe(true);
  });
});
