import { describe, expect, it, vi, beforeEach } from "vitest";

const mockFetchIssueComments = vi.hoisted(() => vi.fn());

vi.mock("../../../src/commands/skeptic/gh-client.js", () => ({
  fetchIssueComments: mockFetchIssueComments,
}));

const { findTriggerRequestId } = await import("../../../src/commands/skeptic/request-binding.js");

describe("findTriggerRequestId", () => {
  beforeEach(() => {
    mockFetchIssueComments.mockReset();
  });

  it("scopes request lookup to the requested trigger type", async () => {
    const sha = "abc1230000000000000000000000000000000000";
    mockFetchIssueComments.mockResolvedValue([
      {
        id: 1,
        body: [
          "SKEPTIC_CRON_TRIGGER",
          "<!-- skeptic-request-id-req-cron -->",
          `<!-- skeptic-head-sha-${sha} -->`,
          `<!-- skeptic-cron-trigger-${sha} -->`,
        ].join("\n"),
        user: { login: "github-actions[bot]" },
      },
      {
        id: 2,
        body: [
          "SKEPTIC_GATE_TRIGGER",
          "<!-- skeptic-request-id-req-gate -->",
          `<!-- skeptic-head-sha-${sha} -->`,
          `<!-- skeptic-gate-trigger-${sha} -->`,
        ].join("\n"),
        user: { login: "github-actions[bot]" },
      },
    ]);

    await expect(findTriggerRequestId("owner", "repo", 1, sha, "gate")).resolves.toBe("req-gate");
    await expect(findTriggerRequestId("owner", "repo", 1, sha, "cron")).resolves.toBe("req-cron");
  });

  it("fails closed instead of choosing between ambiguous gate and cron triggers", async () => {
    const sha = "abc1230000000000000000000000000000000000";
    mockFetchIssueComments.mockResolvedValue([
      {
        id: 1,
        body: `SKEPTIC_CRON_TRIGGER\n<!-- skeptic-request-id-req-cron -->\n<!-- skeptic-head-sha-${sha} -->\n<!-- skeptic-cron-trigger-${sha} -->`,
        user: { login: "github-actions[bot]" },
      },
      {
        id: 2,
        body: `SKEPTIC_GATE_TRIGGER\n<!-- skeptic-request-id-req-gate -->\n<!-- skeptic-head-sha-${sha} -->\n<!-- skeptic-gate-trigger-${sha} -->`,
        user: { login: "github-actions[bot]" },
      },
    ]);

    await expect(findTriggerRequestId("owner", "repo", 1, sha)).resolves.toBeUndefined();
  });

  it("fails closed when the requested trigger type has multiple request ids", async () => {
    const sha = "abc1230000000000000000000000000000000000";
    mockFetchIssueComments.mockResolvedValue([
      {
        id: 1,
        body: `SKEPTIC_GATE_TRIGGER\n<!-- skeptic-request-id-req-gate-old -->\n<!-- skeptic-head-sha-${sha} -->\n<!-- skeptic-gate-trigger-${sha} -->`,
        user: { login: "github-actions[bot]" },
      },
      {
        id: 2,
        body: `SKEPTIC_GATE_TRIGGER\n<!-- skeptic-request-id-req-gate-new -->\n<!-- skeptic-head-sha-${sha} -->\n<!-- skeptic-gate-trigger-${sha} -->`,
        user: { login: "github-actions[bot]" },
      },
    ]);

    await expect(findTriggerRequestId("owner", "repo", 1, sha, "gate")).resolves.toBeUndefined();
  });

  it("ignores forged trigger comments from non-workflow authors", async () => {
    const sha = "abc1230000000000000000000000000000000000";
    mockFetchIssueComments.mockResolvedValue([
      {
        id: 1,
        body: `SKEPTIC_GATE_TRIGGER\n<!-- skeptic-request-id-forged -->\n<!-- skeptic-head-sha-${sha} -->\n<!-- skeptic-gate-trigger-${sha} -->`,
        user: { login: "pr-author" },
      },
      {
        id: 2,
        body: `SKEPTIC_GATE_TRIGGER\n<!-- skeptic-request-id-req-real -->\n<!-- skeptic-head-sha-${sha} -->\n<!-- skeptic-gate-trigger-${sha} -->`,
        user: { login: "github-actions[bot]" },
      },
    ]);

    await expect(findTriggerRequestId("owner", "repo", 1, sha, "gate")).resolves.toBe("req-real");
  });

  it("requires the paired head-sha marker before trusting a trigger comment", async () => {
    const sha = "abc1230000000000000000000000000000000000";
    mockFetchIssueComments.mockResolvedValue([
      {
        id: 1,
        body: `SKEPTIC_GATE_TRIGGER\n<!-- skeptic-request-id-missing-head -->\n<!-- skeptic-gate-trigger-${sha} -->`,
        user: { login: "github-actions[bot]" },
      },
    ]);

    await expect(findTriggerRequestId("owner", "repo", 1, sha, "gate")).resolves.toBeUndefined();
  });
});
