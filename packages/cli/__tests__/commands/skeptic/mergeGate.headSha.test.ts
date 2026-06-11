import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReviewInfo } from "../../../src/commands/skeptic/gh-client.js";

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
  isCodeRabbitReview: (r: ReviewInfo) =>
    r.author?.login === "coderabbitai" || r.author?.login === "coderabbitai[bot]",
}));

const { fetchMergeGateState } = await import(
  "../../../src/commands/skeptic/mergeGate.js"
);

describe("head SHA filtering and fallback", () => {
  beforeEach(() => {
    mockState.ghJsonValues = [];
    mockState.ghJsonPaginateValues = [];
    mockState.fetchReviewsResult = [];
  });

  function setup(opts: {
    ghJson?: unknown[];
    paginate?: unknown[];
    fetchReviews?: unknown[];
  }) {
    mockState.ghJsonValues = opts.ghJson ?? [];
    mockState.ghJsonPaginateValues = opts.paginate ?? [];
    mockState.fetchReviewsResult = opts.fetchReviews ?? [];
  }

  const headSha = "abc1230000000000000000000000000000000000";

  it("does not approve CodeRabbit and sets crState to none-on-head if review is changes_requested but on an old commit SHA", async () => {
    setup({
      ghJson: [
        { head: { sha: headSha }, mergeable: true },
        { state: "success" },
        { commit: { committer: { date: "2026-06-04T12:00:00Z" } } },
      ],
      paginate: [
        [],
        [
          [
            { id: 9, body: "regular comment", created_at: "2026-06-04T13:00:00Z", user: { login: "someone" } }
          ]
        ],
        [],
      ],
      fetchReviews: [
        {
          author: { login: "coderabbitai" },
          state: "changes_requested",
          body: "please fix this",
          submittedAt: "2026-06-04T11:00:00Z",
          commitId: "old-sha-1234567890",
        }
      ],
    });

    const result = await fetchMergeGateState("test", "test-repo", 1, "jleechan-agent[bot]");
    expect(result.crApproved).toBe(false);
    expect(result.crState).toBe("none-on-head");
  });

  it("sets crDismissedWithoutApproval to false if review is dismissed on an old commit SHA", async () => {
    setup({
      ghJson: [
        { head: { sha: headSha }, mergeable: true },
        { state: "success" },
        { commit: { committer: { date: "2026-06-04T12:00:00Z" } } },
      ],
      paginate: [
        [],
        [
          [
            { id: 9, body: "regular comment", created_at: "2026-06-04T13:00:00Z", user: { login: "someone" } }
          ]
        ],
        [],
      ],
      fetchReviews: [
        {
          author: { login: "coderabbitai" },
          state: "dismissed",
          body: "dismissed review",
          submittedAt: "2026-06-04T11:00:00Z",
          commitId: "old-sha-1234567890",
        }
      ],
    });

    const result = await fetchMergeGateState("test", "test-repo", 1, "jleechan-agent[bot]");
    expect(result.crDismissedWithoutApproval).toBe(false);
  });

  it("sets crDismissedWithoutApproval to true if review is dismissed on the current head SHA", async () => {
    setup({
      ghJson: [
        { head: { sha: headSha }, mergeable: true },
        { state: "success" },
        { commit: { committer: { date: "2026-06-04T12:00:00Z" } } },
      ],
      paginate: [
        [],
        [
          [
            { id: 9, body: "regular comment", created_at: "2026-06-04T13:00:00Z", user: { login: "someone" } }
          ]
        ],
        [],
      ],
      fetchReviews: [
        {
          author: { login: "coderabbitai" },
          state: "dismissed",
          body: "dismissed review",
          submittedAt: "2026-06-04T11:00:00Z",
          commitId: headSha,
        }
      ],
    });

    const result = await fetchMergeGateState("test", "test-repo", 1, "jleechan-agent[bot]");
    expect(result.crDismissedWithoutApproval).toBe(true);
  });

  it("uses head.sha from prData to fetch commit status and check runs", async () => {
    setup({
      ghJson: [
        { head: { sha: headSha }, mergeable: true },
        { state: "success" },
        [],
      ],
      paginate: [
        [],
        [],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );
    expect(result.noConflicts).toBe(true);
  });

  it("throws an error if head.sha is missing", async () => {
    setup({
      ghJson: [
        { head: {}, mergeable: true },
      ],
      paginate: [
        [],
        [],
      ],
    });

    await expect(
      fetchMergeGateState("test", "test-repo", 1, "jleechan-agent[bot]")
    ).rejects.toThrow("Could not determine head SHA for PR #1");
  });
});
