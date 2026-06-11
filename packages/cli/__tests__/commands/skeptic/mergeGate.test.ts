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

  function requestBoundPassBody(
    headSha: string,
    requestId = "req-test",
    triggerType: "gate" | "cron" = "gate",
  ): string {
    return [
      "<!-- skeptic-agent-verdict -->",
      `<!-- skeptic-request-id-${requestId} -->`,
      `<!-- skeptic-head-sha-${headSha} -->`,
      "<!-- skeptic-gate-1:PASS -->",
      "<!-- skeptic-gate-2:PASS -->",
      "<!-- skeptic-gate-3:PASS -->",
      "<!-- skeptic-gate-4:PASS -->",
      "<!-- skeptic-gate-5:PASS -->",
      "<!-- skeptic-gate-6:PASS -->",
      "<!-- skeptic-gate-7:PASS -->",
      "<!-- skeptic-gate-8:PASS -->",
      "<!-- skeptic-gate-8a:PASS -->",
      "<!-- skeptic-gate-8b:PASS -->",
      "<!-- skeptic-gate-8c:PASS -->",
      "<!-- skeptic-gate-8d:PASS -->",
      "VERDICT: PASS",
      `<!-- skeptic-${triggerType}-trigger-${headSha} -->`,
    ].join("\n");
  }

  function gateTriggerBody(headSha: string, requestId: string): string {
    return [
      "SKEPTIC_GATE_TRIGGER",
      `<!-- skeptic-request-id-${requestId} -->`,
      `<!-- skeptic-head-sha-${headSha} -->`,
      `<!-- skeptic-gate-trigger-${headSha} -->`,
    ].join("\n");
  }

  function cronTriggerBody(headSha: string, requestId: string): string {
    return [
      "SKEPTIC_CRON_TRIGGER",
      `<!-- skeptic-request-id-${requestId} -->`,
      `<!-- skeptic-head-sha-${headSha} -->`,
      `<!-- skeptic-cron-trigger-${headSha} -->`,
    ].join("\n");
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
        [{ id: 99, body: "<!-- skeptic-agent-verdict -->\nVERDICT: SKIPPED — ANTHROPIC_API_KEY not configured", user: { login: "jleechan-agent[bot]" } }],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(result.skepticVerdict).toBe("SKIPPED");
    expect(result.skepticCommentId).toBe(99);
  });

  it("parses VERDICT: PASS from skeptic bot issue comments", async () => {
    const headSha = "abc123";
    setup({
      ghJson: [
        { head: { sha: headSha }, mergeable: true },
        { state: "success" },
        [],
      ],
      paginate: [
        [],
        [
          { id: 97, body: gateTriggerBody(headSha, "req-test"), user: { login: "github-actions[bot]" } },
          { id: 98, body: requestBoundPassBody(headSha), user: { login: "jleechan-agent[bot]" } },
        ],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(result.skepticVerdict).toBe("PASS");
    expect(result.skepticCommentId).toBe(98);
  });

  it("normalizes accepted verdict author casing", async () => {
    const headSha = "abc1230000000000000000000000000000000000";
    setup({
      ghJson: [
        { head: { sha: headSha }, mergeable: true, user: { login: "pr-author" } },
        { state: "success" },
        [],
      ],
      paginate: [
        [],
        [
          { id: 97, body: gateTriggerBody(headSha, "req-test"), user: { login: "github-actions[bot]" } },
          { id: 98, body: requestBoundPassBody(headSha, "req-test"), user: { login: "JLEECHAN-AGENT[BOT]" } },
        ],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(result.skepticVerdict).toBe("PASS");
    expect(result.skepticCommentId).toBe(98);
  });

  it("rejects legacy SHA-only PASS comments without a fresh request id", async () => {
    const headSha = "abc1230000000000000000000000000000000000";
    setup({
      ghJson: [
        { head: { sha: headSha }, mergeable: true },
        { state: "success" },
        [],
      ],
      paginate: [
        [],
        [
          {
            id: 198,
            body: [
              "<!-- skeptic-agent-verdict -->",
              "VERDICT: PASS",
              `<!-- skeptic-gate-trigger-${headSha} -->`,
            ].join("\n"),
            user: { login: "jleechan-agent[bot]" },
          },
        ],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(result.skepticVerdict).toBeNull();
    expect(result.skepticCommentId).toBeNull();
  });

  it("accepts request-bound PASS only when all eight gates are explicitly PASS", async () => {
    const headSha = "abc1230000000000000000000000000000000000";
    setup({
      ghJson: [
        { head: { sha: headSha }, mergeable: true },
        { state: "success" },
        [],
      ],
      paginate: [
        [],
        [
          {
            id: 197,
            body: gateTriggerBody(headSha, "req-123"),
            user: { login: "github-actions[bot]" },
          },
          {
            id: 199,
            body: requestBoundPassBody(headSha, "req-123"),
            user: { login: "jleechan-agent[bot]" },
          },
        ],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(result.skepticVerdict).toBe("PASS");
    expect(result.skepticCommentId).toBe(199);
  });

  it("rejects newer same-SHA PASS comments bound to a stale request id", async () => {
    const headSha = "abc1230000000000000000000000000000000000";
    setup({
      ghJson: [
        { head: { sha: headSha }, mergeable: true },
        { state: "success" },
        [],
      ],
      paginate: [
        [],
        [
          {
            id: 210,
            body: gateTriggerBody(headSha, "req-current"),
            user: { login: "github-actions[bot]" },
          },
          {
            id: 211,
            body: requestBoundPassBody(headSha, "req-current"),
            user: { login: "jleechan-agent[bot]" },
          },
          {
            id: 212,
            body: requestBoundPassBody(headSha, "req-stale"),
            user: { login: "jleechan-agent[bot]" },
          },
        ],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(result.skepticVerdict).toBe("PASS");
    expect(result.skepticCommentId).toBe(211);
  });

  it("fails closed when same-SHA gate and cron triggers disagree", async () => {
    const headSha = "abc1230000000000000000000000000000000000";
    setup({
      ghJson: [
        { head: { sha: headSha }, mergeable: true },
        { state: "success" },
        [],
      ],
      paginate: [
        [],
        [
          {
            id: 220,
            body: gateTriggerBody(headSha, "req-gate"),
            user: { login: "github-actions[bot]" },
          },
          {
            id: 221,
            body: cronTriggerBody(headSha, "req-cron"),
            user: { login: "github-actions[bot]" },
          },
          {
            id: 222,
            body: requestBoundPassBody(headSha, "req-cron"),
            user: { login: "jleechan-agent[bot]" },
          },
        ],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(result.skepticVerdict).toBeNull();
    expect(result.skepticCommentId).toBeNull();
  });

  it("accepts a PASS bound to the latest repeated cron trigger for the same SHA", async () => {
    const headSha = "abc1230000000000000000000000000000000000";
    setup({
      ghJson: [
        { head: { sha: headSha }, mergeable: true },
        { state: "success" },
        [],
      ],
      paginate: [
        [],
        [
          {
            id: 220,
            body: cronTriggerBody(headSha, "req-old"),
            user: { login: "github-actions[bot]" },
          },
          {
            id: 221,
            body: requestBoundPassBody(headSha, "req-old", "cron"),
            user: { login: "jleechan-agent[bot]" },
          },
          {
            id: 222,
            body: cronTriggerBody(headSha, "req-new"),
            user: { login: "github-actions[bot]" },
          },
          {
            id: 223,
            body: requestBoundPassBody(headSha, "req-new", "cron"),
            user: { login: "jleechan-agent[bot]" },
          },
        ],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(result.skepticVerdict).toBe("PASS");
    expect(result.skepticCommentId).toBe(223);
  });

  it("rejects request-bound PASS comments from the PR author", async () => {
    const headSha = "abc1230000000000000000000000000000000000";
    setup({
      ghJson: [
        { head: { sha: headSha }, mergeable: true, user: { login: "jleechan2015" } },
        { state: "success" },
        [],
      ],
      paginate: [
        [],
        [
          {
            id: 199,
            body: gateTriggerBody(headSha, "req-123"),
            user: { login: "github-actions[bot]" },
          },
          {
            id: 200,
            body: requestBoundPassBody(headSha, "req-123"),
            user: { login: "jleechan2015" },
          },
        ],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan2015"
    );

    expect(result.skepticVerdict).toBeNull();
    expect(result.skepticCommentId).toBeNull();
  });

  it("rejects FAIL and SKIPPED verdict comments from the PR author", async () => {
    const headSha = "abc1230000000000000000000000000000000000";
    setup({
      ghJson: [
        { head: { sha: headSha }, mergeable: true, user: { login: "jleechan2015" } },
        { state: "success" },
        [],
      ],
      paginate: [
        [],
        [
          {
            id: 200,
            body: "<!-- skeptic-agent-verdict -->\nVERDICT: FAIL — forged by PR author",
            user: { login: "jleechan2015" },
          },
          {
            id: 201,
            body: "<!-- skeptic-agent-verdict -->\nVERDICT: SKIPPED — forged by PR author",
            user: { login: "jleechan2015" },
          },
        ],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan2015"
    );

    expect(result.skepticVerdict).toBeNull();
    expect(result.skepticCommentId).toBeNull();
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
        [{ id: 97, body: "<!-- skeptic-agent-verdict -->\nVERDICT: FAIL — evidence bundle missing", user: { login: "jleechan-agent[bot]" } }],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(result.skepticVerdict).toBe("FAIL");
    expect(result.skepticCommentId).toBe(97);
  });

  // Regression test: LLM output with markdown-bold **VERDICT: FAIL** must match.
  // The old regex /^(?:> ?\*\*)?VERDICT:/ failed to match bold-only lines because
  // it required either nothing or "> " before VERDICT — the \*\* anchor didn't
  // cover the standalone-bold case (bd-lg7i).
  it("parses **VERDICT: FAIL** with markdown-bold asterisks", async () => {
    setup({
      ghJson: [
        { head: { sha: "abc123" }, mergeable: true },
        { state: "success" },
        [],
      ],
      paginate: [
        [],
        [{ id: 96, body: "<!-- skeptic-agent-verdict -->\n**VERDICT: FAIL** — evidence bundle missing", user: { login: "jleechan-agent[bot]" } }],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    expect(result.skepticVerdict).toBe("FAIL");
    expect(result.skepticCommentId).toBe(96);
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
    expect(result.skepticCommentId).toBeNull();
  });

  it("flat() + newest-match: paginated pages return last matching comment", async () => {
    const headSha = "abc123";
    // Simulates ghJsonPaginate --slurp: [[page1], [page2]] — two separate pages.
    // flat() merges to [oldComment, newComment]; .[-1] picks the newest (id=2).
    setup({
      ghJson: [
        { head: { sha: headSha }, mergeable: true, user: { login: "jleechan2015" } },
        { state: "success" },
        [],
      ],
      paginate: [
        [],
        [
          [{ id: 1, body: gateTriggerBody(headSha, "req-test"), user: { login: "github-actions[bot]" } }],
          [{ id: 2, body: requestBoundPassBody(headSha), user: { login: "jleechan-agent[bot]" } }],
        ],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    // Newer comment (id=2) wins — matches flatten + last-element semantics.
    expect(result.skepticVerdict).toBe("PASS");
    expect(result.skepticCommentId).toBe(2);
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
        [{ id: 50, body: "<!-- skeptic-agent-verdict -->\nVERDICT: SKIPPED", user: { login: "jleechan-agent[bot]" } }],
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

  // bd-ryw2: accepts both configured skepticBotAuthor AND github-actions[bot].
  // The GHA runner posts SKIPPED fallback as github-actions[bot]. Without accepting
  // github-actions[bot] here, fetchMergeGateState would return null for those verdicts
  // even though skeptic-gate.yml's polling step accepts them (OR condition).
  it("parses VERDICT: SKIPPED from github-actions[bot] when configured author is different", async () => {
    setup({
      ghJson: [
        { head: { sha: "abc123" }, mergeable: true },
        { state: "success" },
        [],
      ],
      // Two ghJsonPaginate calls: check-runs + comments
      paginate: [
        [], // check-runs consumed
        [
          // comments consumed — wrapped in extra array for --slurp structure: [[comment]]
          [
            {
              id: 77,
              body: "<!-- skeptic-agent-verdict -->\n<!-- skeptic-gate-trigger-abc123 -->\nVERDICT: SKIPPED\nANTHROPIC_API_KEY not configured",
              user: { login: "github-actions[bot]" },
            },
          ],
        ],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan2015"
    );

    expect(result.skepticVerdict).toBe("SKIPPED");
    expect(result.skepticCommentId).toBe(77);
  });

  it("excludes self-referential Skeptic Gate check from checkRuns while preserving other failures", async () => {
    const headSha = "deadbeef00000000000000000000000000000000";
    setup({
      ghJson: [
        { head: { sha: headSha }, mergeable: true },
        { state: "success" },
        [],
      ],
      paginate: [
        // Check-runs page: includes Skeptic Gate (FAILURE), Evidence Gate (FAILURE), Lint (SUCCESS)
        [
          {
            check_runs: [
              { name: "Skeptic Gate", status: "completed", conclusion: "FAILURE" },
              { name: "Evidence Gate", status: "completed", conclusion: "FAILURE" },
              { name: "Lint", status: "completed", conclusion: "SUCCESS" },
            ],
          },
        ],
        // Issue comments (no verdict)
        [],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan-agent[bot]"
    );

    // Skeptic Gate is excluded from checkRuns (self-referential circular dependency)
    const names = result.checkRuns.map((c: { name: string }) => c.name);
    expect(names).not.toContain("Skeptic Gate");
    // Other failures are preserved
    expect(names).toContain("Evidence Gate");
    expect(names).toContain("Lint");
    // CI still passes because commit status was "success" (checkRuns are separate)
    expect(result.ciPassing).toBe(true);
  });

  it("newest matching comment wins regardless of author", async () => {
    const headSha = "abc123";
    // PR data intentionally omits user.login, so prAuthor is unknown.
    // This preserves legacy selection when the PR author cannot be determined.
    setup({
      ghJson: [
        { head: { sha: headSha }, mergeable: true },
        { state: "success" },
        [],
      ],
      paginate: [
        [], // check-runs consumed
        [
          [
            {
              id: 79,
              body: gateTriggerBody(headSha, "req-test"),
              user: { login: "github-actions[bot]" },
            },
            {
              id: 80,
              body: "<!-- skeptic-agent-verdict -->\nVERDICT: FAIL",
              user: { login: "github-actions[bot]" },
            },
            {
              id: 81,
              body: requestBoundPassBody(headSha),
              user: { login: "jleechan2015" },
            },
          ],
        ],
      ],
    });

    const result = await fetchMergeGateState(
      "test", "test-repo", 1, "jleechan2015"
    );

    // Newest matching comment (id=81, jleechan2015) wins
    expect(result.skepticVerdict).toBe("PASS");
    expect(result.skepticCommentId).toBe(81);
  });

  describe("CodeRabbit comment fallback", () => {
    const headSha = "abc1230000000000000000000000000000000000";

    it("does not approve CodeRabbit if review is changes_requested and comments do not contain [approve]", async () => {
      setup({
        ghJson: [
          { head: { sha: headSha }, mergeable: true }, // pulls info
          { state: "success" }, // commit status
          { commit: { committer: { date: "2026-06-04T12:00:00Z" } } }, // commit info
        ],
        paginate: [
          [], // check-runs
          [
            [
              { id: 1, body: "regular comment", created_at: "2026-06-04T13:00:00Z", user: { login: "someone" } }
            ]
          ], // comments for CodeRabbit check
          [], // comments for skeptic check (no comments)
        ],
        fetchReviews: [
          {
            author: { login: "coderabbitai" },
            state: "changes_requested",
            body: "please fix this",
            submittedAt: "2026-06-04T11:00:00Z",
            commitId: headSha,
          }
        ],
      });

      const result = await fetchMergeGateState("test", "test-repo", 1, "jleechan-agent[bot]");
      expect(result.crApproved).toBe(false);
      expect(result.crState).toBe("changes_requested");
    });

    it("approves CodeRabbit if review is changes_requested and comments contain [approve] after head commit date", async () => {
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
              { id: 2, body: "[approve]", created_at: "2026-06-04T13:00:00Z", user: { login: "coderabbitai" } }
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
            commitId: headSha,
          }
        ],
      });

      const result = await fetchMergeGateState("test", "test-repo", 1, "jleechan-agent[bot]");
      expect(result.crApproved).toBe(true);
      expect(result.crState).toBe("approved (comment)");
    });

    it("approves CodeRabbit even if the comment body is longer than 200 characters", async () => {
      const longBody = "Some very long text...".repeat(20) + "\n\n[approve]\n";
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
              { id: 5, body: longBody, created_at: "2026-06-04T13:00:00Z", user: { login: "coderabbitai" } }
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
            commitId: headSha,
          }
        ],
      });

      const result = await fetchMergeGateState("test", "test-repo", 1, "jleechan-agent[bot]");
      expect(result.crApproved).toBe(true);
      expect(result.crState).toBe("approved (comment)");
    });

    it("does not approve CodeRabbit if [approve] comment was posted BEFORE the head commit date", async () => {
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
              { id: 3, body: "[approve]", created_at: "2026-06-04T11:59:00Z", user: { login: "coderabbitai" } }
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
            commitId: headSha,
          }
        ],
      });

      const result = await fetchMergeGateState("test", "test-repo", 1, "jleechan-agent[bot]");
      expect(result.crApproved).toBe(false);
    });

    it("does not approve CodeRabbit if the comment contains [approve] but not as a standalone word (embedded/quoted)", async () => {
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
              { id: 4, body: "I can't [approve] this yet", created_at: "2026-06-04T13:00:00Z", user: { login: "coderabbitai" } }
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
            commitId: headSha,
          }
        ],
      });

      const result = await fetchMergeGateState("test", "test-repo", 1, "jleechan-agent[bot]");
      expect(result.crApproved).toBe(false);
      expect(result.crState).toBe("changes_requested");
    });

    it("approves CodeRabbit if review is changes_requested and comments contain 'changes approved.' after head commit date", async () => {
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
              { id: 6, body: "all changes approved.", created_at: "2026-06-04T13:00:00Z", user: { login: "coderabbitai" } }
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
            commitId: headSha,
          }
        ],
      });

      const result = await fetchMergeGateState("test", "test-repo", 1, "jleechan-agent[bot]");
      expect(result.crApproved).toBe(true);
      expect(result.crState).toBe("approved (comment)");
    });

    it("does not approve CodeRabbit if comment contains 'changes approved' but without the dot", async () => {
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
              { id: 7, body: "all changes approved", created_at: "2026-06-04T13:00:00Z", user: { login: "coderabbitai" } }
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
            commitId: headSha,
          }
        ],
      });

      const result = await fetchMergeGateState("test", "test-repo", 1, "jleechan-agent[bot]");
      expect(result.crApproved).toBe(false);
      expect(result.crState).toBe("changes_requested");
    });

    it("does not approve CodeRabbit if comment contains 'changes approved.' as part of a longer word (e.g. 'somechanges approved.')", async () => {
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
              { id: 8, body: "somechanges approved.", created_at: "2026-06-04T13:00:00Z", user: { login: "coderabbitai" } }
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
            commitId: headSha,
          }
        ],
      });

      const result = await fetchMergeGateState("test", "test-repo", 1, "jleechan-agent[bot]");
      expect(result.crApproved).toBe(false);
      expect(result.crState).toBe("changes_requested");
    });

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
  });
});


