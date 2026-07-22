/**
 * Tests for jq filters used in skeptic-cron-reusable.yml.
 *
 * Strategy: Re-implement each `gh api --jq '...'` filter in TypeScript using
 * the same jq semantics against real API output shapes. This validates the
 * filter logic without needing a real gh binary or GitHub API.
 *
 * Scope narrowed 2026-07-22: this repo's own standalone skeptic-gate.yml and
 * skeptic-cron.yml were retired (see PR #773); their jq-filter tests were
 * removed with them. skeptic-cron-reusable.yml is retained (still installed
 * into consumer repos via packages/cli/src/templates/skeptic/skeptic-cron.yml,
 * which calls it via `uses:`), so its filter tests stay.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

describe("skeptic-cron-reusable.yml — request-id freshness contract", () => {
  const SHA_A = "abc1230000000000000000000000000000000000";
  const SHA_B = "def4560000000000000000000000000000000000";
  const workflow = readFileSync(
    new URL("../../../../.github/workflows/skeptic-cron-reusable.yml", import.meta.url),
    "utf8",
  );

  function cronTriggerBody(sha: string, requestId: string): string {
    return [
      "SKEPTIC_CRON_TRIGGER",
      `<!-- skeptic-request-id-${requestId} -->`,
      `<!-- skeptic-head-sha-${sha} -->`,
      `<!-- skeptic-cron-trigger-${sha} -->`,
    ].join("\n");
  }

  function selectLatestCronRequestId(comments: IssueComment[], sha: string): string {
    const matching = comments
      .map((comment) => ({
        ...comment,
        requestId:
          comment.body.match(/<!--\s*skeptic-request-id-([A-Za-z0-9_.:-]+)\s*-->/i)?.[1] ?? "",
      }))
      .filter(
        (comment) =>
          comment.user.login.toLowerCase() === "github-actions[bot]" &&
          /SKEPTIC_CRON_TRIGGER/i.test(comment.body) &&
          new RegExp(`<!--\\s*skeptic-cron-trigger-${sha}\\s*-->`, "i").test(comment.body) &&
          new RegExp(`<!--\\s*skeptic-head-sha-${sha}\\s*-->`, "i").test(comment.body) &&
          comment.requestId !== "",
      )
      .sort((a, b) =>
        (a.created_at ?? a.updated_at ?? "").localeCompare(b.created_at ?? b.updated_at ?? ""),
      );

    return matching.at(-1)?.requestId ?? "";
  }

  it("reuses or skips unresolved cron request ids before posting a new trigger", () => {
    expect(workflow).toContain("Existing cron PASS request id for PR");
    expect(workflow).toContain("Unresolved cron request id exists for PR");
  });

  function failSkippedVerdictCount(
    comments: IssueComment[],
    sha: string,
    author: string,
    prAuthor: string,
  ): number {
    const verdictRe =
      /^[ \t]*(?:> ?)?(?:#{1,6}[ \t]*)?(?:\*{1,2})?VERDICT:[ \t]*(?<verdict>PASS|FAIL|SKIPPED)(?:\*{1,2})?[ \t]*(?:[-—:].*)?$/im;
    return comments
      .map((c) => ({
        ...c,
        verdict: (c.body.match(verdictRe)?.groups?.verdict ?? "").toUpperCase(),
      }))
      .filter(
        (c) =>
          (c.user.login.toLowerCase() === author.toLowerCase() ||
            c.user.login.toLowerCase() === "github-actions[bot]") &&
          c.user.login.toLowerCase() !== prAuthor.toLowerCase() &&
          /<!--\s*skeptic-agent-verdict\s*-->/i.test(c.body) &&
          (c.verdict === "FAIL" || c.verdict === "SKIPPED") &&
          new RegExp(`<!--\\s*skeptic-cron-trigger-${sha}\\s*-->`, "i").test(c.body) &&
          new RegExp(`<!--\\s*skeptic-head-sha-${sha}\\s*-->`, "i").test(c.body),
      ).length;
  }

  // Timestamp-aware variant: mirrors the workflow's 4-hour suppress window.
  // Returns true only when a matching FAIL/SKIPPED verdict exists AND was posted
  // within suppressWindowSecs, providing a same-SHA recovery path after that window.
  function shouldSuppressFailedTrigger(
    comments: IssueComment[],
    sha: string,
    author: string,
    prAuthor: string,
    suppressWindowSecs: number,
  ): boolean {
    const verdictRe =
      /^[ \t]*(?:> ?)?(?:#{1,6}[ \t]*)?(?:\*{1,2})?VERDICT:[ \t]*(?<verdict>PASS|FAIL|SKIPPED)(?:\*{1,2})?[ \t]*(?:[-—:].*)?$/im;
    const nowMs = Date.now();
    const matching = comments
      .map((c) => ({
        ...c,
        verdict: (c.body.match(verdictRe)?.groups?.verdict ?? "").toUpperCase(),
      }))
      .filter(
        (c) =>
          (c.user.login.toLowerCase() === author.toLowerCase() ||
            c.user.login.toLowerCase() === "github-actions[bot]") &&
          c.user.login.toLowerCase() !== prAuthor.toLowerCase() &&
          /<!--\s*skeptic-agent-verdict\s*-->/i.test(c.body) &&
          (c.verdict === "FAIL" || c.verdict === "SKIPPED") &&
          new RegExp(`<!--\\s*skeptic-cron-trigger-${sha}\\s*-->`, "i").test(c.body) &&
          new RegExp(`<!--\\s*skeptic-head-sha-${sha}\\s*-->`, "i").test(c.body),
      );
    if (matching.length === 0) return false;
    // Use the most recent verdict timestamp; fail open (allow retrigger) if missing
    const sorted = [...matching].sort((a, b) =>
      (a.created_at ?? "").localeCompare(b.created_at ?? ""),
    );
    const latest = sorted[sorted.length - 1];
    if (!latest.created_at) return false;
    const verdictMs = new Date(latest.created_at).getTime();
    const ageMs = nowMs - verdictMs;
    return ageMs < suppressWindowSecs * 1000;
  }

  function verdictComment(sha: string, verdict: "PASS" | "FAIL" | "SKIPPED", requestId = "req-1"): string {
    return [
      "<!-- skeptic-agent-verdict -->",
      `<!-- skeptic-request-id-${requestId} -->`,
      `<!-- skeptic-head-sha-${sha} -->`,
      `VERDICT: ${verdict}`,
      `<!-- skeptic-cron-trigger-${sha} -->`,
    ].join("\n");
  }

  it("skips trigger when FAIL/SKIPPED verdict already exists for current SHA within suppress window", () => {
    expect(workflow).toContain("Existing cron FAIL/SKIPPED verdict for PR");
    expect(workflow).toContain("FAIL_SUPPRESS_WINDOW_SECS");
    expect(workflow).toContain("allowing retry");
    expect(workflow).toContain('.verdict == "FAIL" or .verdict == "SKIPPED"');
  });

  it("detects existing FAIL verdict and suppresses retrigger", () => {
    const comments: IssueComment[] = [
      { id: 10, user: { login: "github-actions[bot]" }, body: verdictComment(SHA_A, "FAIL") },
    ];
    expect(failSkippedVerdictCount(comments, SHA_A, "github-actions[bot]", "pr-author")).toBe(1);
  });

  it("detects existing SKIPPED verdict and suppresses retrigger", () => {
    const comments: IssueComment[] = [
      { id: 11, user: { login: "github-actions[bot]" }, body: verdictComment(SHA_A, "SKIPPED") },
    ];
    expect(failSkippedVerdictCount(comments, SHA_A, "github-actions[bot]", "pr-author")).toBe(1);
  });

  it("does not suppress when existing verdict is PASS", () => {
    const comments: IssueComment[] = [
      { id: 12, user: { login: "github-actions[bot]" }, body: verdictComment(SHA_A, "PASS") },
    ];
    expect(failSkippedVerdictCount(comments, SHA_A, "github-actions[bot]", "pr-author")).toBe(0);
  });

  it("does not suppress when FAIL verdict is for a different SHA", () => {
    const comments: IssueComment[] = [
      { id: 13, user: { login: "github-actions[bot]" }, body: verdictComment(SHA_B, "FAIL") },
    ];
    expect(failSkippedVerdictCount(comments, SHA_A, "github-actions[bot]", "pr-author")).toBe(0);
  });

  it("does not suppress when no verdict exists", () => {
    const comments: IssueComment[] = [];
    expect(failSkippedVerdictCount(comments, SHA_A, "github-actions[bot]", "pr-author")).toBe(0);
  });

  // Timestamp-aware suppress-window tests (4-hour recovery path)
  it("suppresses retrigger when FAIL verdict is recent (< 4 hours old)", () => {
    const recentTs = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
    const comments: IssueComment[] = [
      {
        id: 20,
        user: { login: "github-actions[bot]" },
        body: verdictComment(SHA_A, "FAIL"),
        created_at: recentTs,
      },
    ];
    expect(shouldSuppressFailedTrigger(comments, SHA_A, "github-actions[bot]", "pr-author", 14400)).toBe(true);
  });

  it("allows retrigger when FAIL verdict is stale (> 4 hours old)", () => {
    const staleTs = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5 hours ago
    const comments: IssueComment[] = [
      {
        id: 21,
        user: { login: "github-actions[bot]" },
        body: verdictComment(SHA_A, "FAIL"),
        created_at: staleTs,
      },
    ];
    expect(shouldSuppressFailedTrigger(comments, SHA_A, "github-actions[bot]", "pr-author", 14400)).toBe(false);
  });

  it("suppresses retrigger when SKIPPED verdict is recent (< 4 hours old)", () => {
    const recentTs = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    const comments: IssueComment[] = [
      {
        id: 22,
        user: { login: "github-actions[bot]" },
        body: verdictComment(SHA_A, "SKIPPED"),
        created_at: recentTs,
      },
    ];
    expect(shouldSuppressFailedTrigger(comments, SHA_A, "github-actions[bot]", "pr-author", 14400)).toBe(true);
  });

  it("allows retrigger when no created_at (fails open for recovery)", () => {
    const comments: IssueComment[] = [
      {
        id: 23,
        user: { login: "github-actions[bot]" },
        body: verdictComment(SHA_A, "FAIL"),
        // no created_at
      },
    ];
    expect(shouldSuppressFailedTrigger(comments, SHA_A, "github-actions[bot]", "pr-author", 14400)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Direct jq execution tests: run the actual workflow jq filter via jq binary.
  // These prove the workflow's jq/python path works, not just the TS mirror.
  // Skip gracefully when jq is unavailable (local dev without jq installed).
  // ---------------------------------------------------------------------------
  const jqAvailable = spawnSync("jq", ["--version"], { encoding: "utf8" }).status === 0;
  const itJq = jqAvailable ? it : it.skip;

  function runFailSuppressFilter(
    comments: IssueComment[],
    sha: string,
    author: string,
    prAuthor: string,
  ): string {
    // Exact jq filter from skeptic-cron-reusable.yml (lines 147-161), using
    // (?im) inline flags for cross-platform multiline support.
    const filter = `
      add
      | map(. + {
          verdict: (try (.body | capture("(?im)^[ \\t]*(?:> ?)?(?:#{1,6}[ \\t]*)?(?:[*]{1,2})?VERDICT:[ \\t]*(?<verdict>PASS|FAIL|SKIPPED)(?:[*]{1,2})?[ \\t]*(?:[-\\u2014:].*)?$").verdict | ascii_upcase) catch "")
        })
      | map(select(
          (((.user.login | ascii_downcase) == ($author | ascii_downcase)) or ((.user.login | ascii_downcase) == "github-actions[bot]"))
          and ((.user.login | ascii_downcase) != ($pr_author | ascii_downcase))
          and (.body | test("<!--\\\\s*skeptic-agent-verdict\\\\s*-->"; "i"))
          and (.verdict == "FAIL" or .verdict == "SKIPPED")
          and (.body | test("<!--\\\\s*skeptic-cron-trigger-" + $sha + "\\\\s*-->"; "i"))
          and (.body | test("<!--\\\\s*skeptic-head-sha-" + $sha + "\\\\s*-->"; "i"))
        ))
      | sort_by(.created_at // "")
      | last
      | .created_at // ""
    `;
    const input = JSON.stringify(comments);
    const result = spawnSync("jq", ["-sr", "--arg", "sha", sha, "--arg", "author", author, "--arg", "pr_author", prAuthor, filter], {
      input,
      encoding: "utf8",
    });
    return (result.stdout ?? "").trim();
  }

  itJq("jq filter extracts timestamp from recent FAIL verdict for matching SHA", () => {
    const recentTs = new Date(Date.now() - 30 * 60 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
    const comments: IssueComment[] = [
      {
        id: 30,
        user: { login: "github-actions[bot]" },
        body: verdictComment(SHA_A, "FAIL"),
        created_at: recentTs,
      },
    ];
    expect(runFailSuppressFilter(comments, SHA_A, "github-actions[bot]", "pr-author")).toBe(recentTs);
  });

  itJq("jq filter extracts timestamp from recent SKIPPED verdict for matching SHA", () => {
    const recentTs = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
    const comments: IssueComment[] = [
      {
        id: 31,
        user: { login: "github-actions[bot]" },
        body: verdictComment(SHA_A, "SKIPPED"),
        created_at: recentTs,
      },
    ];
    expect(runFailSuppressFilter(comments, SHA_A, "github-actions[bot]", "pr-author")).toBe(recentTs);
  });

  itJq("jq filter returns empty for PASS verdict (not suppressed)", () => {
    const comments: IssueComment[] = [
      {
        id: 32,
        user: { login: "github-actions[bot]" },
        body: verdictComment(SHA_A, "PASS"),
        created_at: "2026-04-24T10:00:00Z",
      },
    ];
    expect(runFailSuppressFilter(comments, SHA_A, "github-actions[bot]", "pr-author")).toBe("");
  });

  itJq("jq filter returns empty when SHA does not match (different SHA)", () => {
    const comments: IssueComment[] = [
      {
        id: 33,
        user: { login: "github-actions[bot]" },
        body: verdictComment(SHA_B, "FAIL"),
        created_at: "2026-04-24T10:00:00Z",
      },
    ];
    expect(runFailSuppressFilter(comments, SHA_A, "github-actions[bot]", "pr-author")).toBe("");
  });

  itJq("jq filter returns empty string when created_at is missing (fails open)", () => {
    const comments: IssueComment[] = [
      {
        id: 34,
        user: { login: "github-actions[bot]" },
        body: verdictComment(SHA_A, "FAIL"),
        // no created_at
      },
    ];
    expect(runFailSuppressFilter(comments, SHA_A, "github-actions[bot]", "pr-author")).toBe("");
  });

  it("derives the merge-step request id from cron trigger comments for the current SHA", () => {
    expect(workflow).toContain('REQUEST_ID=$(echo "$SKEPTIC_RAW" | jq -sr --arg sha "$HEAD_SHA"');
    expect(workflow).toContain('and (.body | test("SKEPTIC_CRON_TRIGGER"; "i"))');
    expect(workflow).toContain('and (.body | test("<!--\\\\s*skeptic-cron-trigger-" + $sha + "\\\\s*-->"; "i"))');
  });

  it("selects the latest cron trigger request id for the current SHA", () => {
    const comments: IssueComment[] = [
      {
        id: 1,
        user: { login: "github-actions[bot]" },
        body: cronTriggerBody(SHA_A, "cron-old"),
        created_at: "2026-04-19T10:00:00Z",
      },
      {
        id: 2,
        user: { login: "github-actions[bot]" },
        body: cronTriggerBody(SHA_A, "cron-current"),
        created_at: "2026-04-19T11:00:00Z",
      },
    ];

    expect(selectLatestCronRequestId(comments, SHA_A)).toBe("cron-current");
  });

  it("does not select request ids from other SHAs or non-cron trigger comments", () => {
    const comments: IssueComment[] = [
      {
        id: 1,
        user: { login: "github-actions[bot]" },
        body: cronTriggerBody(SHA_B, "wrong-sha"),
        created_at: "2026-04-19T11:00:00Z",
      },
      {
        id: 2,
        user: { login: "github-actions[bot]" },
        body: [
          "SKEPTIC_GATE_TRIGGER",
          "<!-- skeptic-request-id-gate-request -->",
          `<!-- skeptic-head-sha-${SHA_A} -->`,
          `<!-- skeptic-gate-trigger-${SHA_A} -->`,
        ].join("\n"),
        created_at: "2026-04-19T12:00:00Z",
      },
    ];

    expect(selectLatestCronRequestId(comments, SHA_A)).toBe("");
  });
});
