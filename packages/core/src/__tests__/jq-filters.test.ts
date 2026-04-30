/**
 * Tests for jq filters used in skeptic-gate.yml and skeptic-cron.yml.
 *
 * Strategy: Re-implement each `gh api --jq '...'` filter in TypeScript using
 * the same jq semantics (group_by, sort_by, select, etc.) against real API
 * output shapes. This validates the filter logic without needing a real gh
 * binary or GitHub API.
 *
 * Scope:
 * - skeptic-gate.yml: check-run deduplication (Lint/Typecheck/Test/Test Web),
 *   CR review state, Bugbot check-run conclusion, prior-result comment cleanup.
 * - skeptic-cron.yml: non-draft PR list, evidence check-run filtering,
 *   verdict comment filter with SHA scoping.
 *
 * References:
 * - skeptic-gate.yml lines ~93-124 (check-run filters), ~173-175 (CR),
 *   ~194-196 (Bugbot), ~377-379 (prior-result cleanup).
 * - skeptic-cron.yml lines ~41 (PR list), ~362-369 (evidence checks),
 *   ~384-398 (verdict filter).
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Shared helper: TypeScript re-implementation of jq group_by + sort_by + select
// matching skeptic-gate.yml check-run deduplication.
// jq: [.check_runs | group_by(.name) | .[] | sort_by(.started_at) | reverse | .[0] | select(COND)] | length
// ---------------------------------------------------------------------------

const CORE_CHECK_NAMES = ["Lint", "Typecheck", "Test", "Test (Web)"];

interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string;
}

/**
 * Returns the most-recent CheckRun per unique name across all paginated pages.
 * Re-implements jq's: group_by(.name) | .[] | sort_by(.started_at) | reverse | .[0]
 */
function mostRecentPerName(pages: Array<{ check_runs: CheckRun[] }>): CheckRun[] {
  const all = pages.flatMap((p) => p.check_runs);
  const groups: Record<string, CheckRun[]> = {};
  for (const run of all) {
    if (!groups[run.name]) groups[run.name] = [];
    groups[run.name].push(run);
  }
  return Object.values(groups).map((runs) =>
    [...runs].sort((a, b) => b.started_at.localeCompare(a.started_at))[0],
  );
}

function jqCheckRunsFailed(
  checkRunsPages: Array<{ check_runs: CheckRun[] }>,
): number {
  const mostRecent = mostRecentPerName(checkRunsPages);
  // Match jq's denylist: exclude specific non-failure conclusions.
  // jq: select(.conclusion != null and .conclusion != "success" and
  //           .conclusion != "skipped" and .conclusion != "neutral" and
  //           .conclusion != "cancelled")
  // Runs with conclusion=null are NOT failures — jqCheckRunsPending handles those.
  const nonFailureConclusions: Array<string | null> = [
    null,
    "success",
    "skipped",
    "neutral",
    "cancelled",
  ];
  return mostRecent.filter(
    (r) =>
      CORE_CHECK_NAMES.includes(r.name) &&
      !nonFailureConclusions.includes(r.conclusion),
  ).length;
}

function jqCheckRunsPending(
  checkRunsPages: Array<{ check_runs: CheckRun[] }>,
): number {
  const mostRecent = mostRecentPerName(checkRunsPages);
  // jq: `.status != "completed"` — true for "in_progress", "queued", "pending".
  return mostRecent.filter(
    (r) => CORE_CHECK_NAMES.includes(r.name) && r.status !== "completed",
  ).length;
}

function jqCheckRunsTotal(
  checkRunsPages: Array<{ check_runs: CheckRun[] }>,
): number {
  const mostRecent = mostRecentPerName(checkRunsPages);
  return mostRecent.filter((r) => CORE_CHECK_NAMES.includes(r.name)).length;
}

describe("skeptic-gate.yml — check-run deduplication filters", () => {
  it("counts zero failed checks when all core checks passed", () => {
    const pages = [
      {
        check_runs: [
          { name: "Lint", status: "completed", conclusion: "success", started_at: "2026-04-03T10:00:00Z" },
          { name: "Typecheck", status: "completed", conclusion: "success", started_at: "2026-04-03T10:01:00Z" },
          { name: "Test", status: "completed", conclusion: "success", started_at: "2026-04-03T10:05:00Z" },
          { name: "Test (Web)", status: "completed", conclusion: "success", started_at: "2026-04-03T10:06:00Z" },
        ],
      },
    ];
    expect(jqCheckRunsFailed(pages)).toBe(0);
    expect(jqCheckRunsPending(pages)).toBe(0);
    expect(jqCheckRunsTotal(pages)).toBe(4);
  });

  it("counts one failed check when Test fails", () => {
    const pages = [
      {
        check_runs: [
          { name: "Lint", status: "completed", conclusion: "success", started_at: "2026-04-03T10:00:00Z" },
          { name: "Typecheck", status: "completed", conclusion: "success", started_at: "2026-04-03T10:01:00Z" },
          { name: "Test", status: "completed", conclusion: "failure", started_at: "2026-04-03T10:05:00Z" },
          { name: "Test (Web)", status: "completed", conclusion: "success", started_at: "2026-04-03T10:06:00Z" },
        ],
      },
    ];
    expect(jqCheckRunsFailed(pages)).toBe(1);
    expect(jqCheckRunsTotal(pages)).toBe(4);
  });

  it("deduplicates by name: older run wins only for non-core checks", () => {
    // Two Lint runs — most recent is "completed/failure" (the one that counts)
    // Two Test runs — most recent is "pending" (not yet completed, so pending count > 0)
    const pages = [
      {
        check_runs: [
          // Old Lint (first, passed) — superseded by newer failed Lint
          { name: "Lint", status: "completed", conclusion: "success", started_at: "2026-04-03T09:00:00Z" },
          { name: "Lint", status: "completed", conclusion: "failure", started_at: "2026-04-03T10:00:00Z" },
          // Old Test (passed) — superseded by newer pending Test
          { name: "Test", status: "completed", conclusion: "success", started_at: "2026-04-03T09:05:00Z" },
          { name: "Test", status: "in_progress", conclusion: null, started_at: "2026-04-03T10:05:00Z" },
          { name: "Typecheck", status: "completed", conclusion: "success", started_at: "2026-04-03T10:01:00Z" },
          { name: "Test (Web)", status: "completed", conclusion: "success", started_at: "2026-04-03T10:06:00Z" },
        ],
      },
    ];
    // Most recent Lint is failure → counts as 1 failed
    expect(jqCheckRunsFailed(pages)).toBe(1);
    // Most recent Test is pending → counts as 1 pending
    expect(jqCheckRunsPending(pages)).toBe(1);
    expect(jqCheckRunsTotal(pages)).toBe(4);
  });

  it("excludes conclusion=null from failure count (null ≠ failure in actual jq filter)", () => {
    // The jq filter has `.conclusion != null` as an explicit guard — null is NOT
    // a concrete failure. status="completed"+conclusion=null is neither pending nor
    // failed; it is a completed run with no conclusion (e.g. cancelled mid-run).
    const pages = [
      {
        check_runs: [
          { name: "Lint", status: "completed", conclusion: null, started_at: "2026-04-03T10:00:00Z" },
          { name: "Typecheck", status: "completed", conclusion: "success", started_at: "2026-04-03T10:01:00Z" },
        ],
      },
    ];
    expect(jqCheckRunsFailed(pages)).toBe(0); // null is NOT a failure
    expect(jqCheckRunsPending(pages)).toBe(0); // status=completed, not pending
  });

  it("ignores skipped, neutral, cancelled conclusions as failures", () => {
    const pages = [
      {
        check_runs: [
          { name: "Lint", status: "completed", conclusion: "skipped", started_at: "2026-04-03T10:00:00Z" },
          { name: "Typecheck", status: "completed", conclusion: "neutral", started_at: "2026-04-03T10:01:00Z" },
          { name: "Test", status: "completed", conclusion: "cancelled", started_at: "2026-04-03T10:05:00Z" },
          { name: "Test (Web)", status: "completed", conclusion: "success", started_at: "2026-04-03T10:06:00Z" },
        ],
      },
    ];
    expect(jqCheckRunsFailed(pages)).toBe(0);
  });

  it("handles paginated results (multiple pages)", () => {
    // Two pages — Lint appears on both pages, latest run is on page 2
    const pages = [
      {
        check_runs: [
          { name: "Lint", status: "completed", conclusion: "success", started_at: "2026-04-03T09:00:00Z" },
          { name: "Typecheck", status: "completed", conclusion: "success", started_at: "2026-04-03T10:01:00Z" },
        ],
      },
      {
        check_runs: [
          // Lint re-run on page 2 (most recent) — failed
          { name: "Lint", status: "completed", conclusion: "failure", started_at: "2026-04-03T11:00:00Z" },
          { name: "Test", status: "completed", conclusion: "success", started_at: "2026-04-03T10:05:00Z" },
          { name: "Test (Web)", status: "completed", conclusion: "success", started_at: "2026-04-03T10:06:00Z" },
        ],
      },
    ];
    expect(jqCheckRunsFailed(pages)).toBe(1); // Lint from page 2
    expect(jqCheckRunsTotal(pages)).toBe(4); // Lint, Typecheck, Test, Test (Web)
  });

  it("ignores non-core check runs entirely", () => {
    const pages = [
      {
        check_runs: [
          { name: "Lint", status: "completed", conclusion: "success", started_at: "2026-04-03T10:00:00Z" },
          { name: "Build", status: "completed", conclusion: "failure", started_at: "2026-04-03T10:05:00Z" },
          { name: "Deploy", status: "completed", conclusion: "failure", started_at: "2026-04-03T10:06:00Z" },
          { name: "Test (Web)", status: "completed", conclusion: "success", started_at: "2026-04-03T10:06:00Z" },
        ],
      },
    ];
    expect(jqCheckRunsFailed(pages)).toBe(0); // Build/Deploy are not core checks
    expect(jqCheckRunsTotal(pages)).toBe(2); // Lint + Test (Web)
  });
});

// ---------------------------------------------------------------------------
// Helper: CR review state filter
// jq: [.[] | select(.user.login == "coderabbitai[bot]" and (.state == "APPROVED" or .state == "CHANGES_REQUESTED"))] | sort_by(.submitted_at) | reverse | .[0].state // "none"
// ---------------------------------------------------------------------------

interface Review {
  user: { login: string };
  state: string;
  submitted_at: string;
}

function jqLatestCRReview(reviews: Review[]): string {
  const filtered = reviews.filter(
    (r) =>
      r.user.login === "coderabbitai[bot]" &&
      (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED"),
  );
  if (filtered.length === 0) return "none";
  const sorted = [...filtered].sort((a, b) =>
    b.submitted_at.localeCompare(a.submitted_at),
  );
  return sorted[0].state;
}

describe("skeptic-gate.yml — CR review state filter", () => {
  it("returns APPROVED when latest CR review is APPROVED", () => {
    const reviews: Review[] = [
      { user: { login: "coderabbitai[bot]" }, state: "CHANGES_REQUESTED", submitted_at: "2026-04-01T10:00:00Z" },
      { user: { login: "coderabbitai[bot]" }, state: "APPROVED", submitted_at: "2026-04-02T10:00:00Z" },
      { user: { login: "human-reviewer" }, state: "APPROVED", submitted_at: "2026-04-03T10:00:00Z" },
    ];
    expect(jqLatestCRReview(reviews)).toBe("APPROVED");
  });

  it("returns CHANGES_REQUESTED when latest CR review is CHANGES_REQUESTED", () => {
    const reviews: Review[] = [
      { user: { login: "coderabbitai[bot]" }, state: "APPROVED", submitted_at: "2026-04-01T10:00:00Z" },
      { user: { login: "coderabbitai[bot]" }, state: "CHANGES_REQUESTED", submitted_at: "2026-04-02T10:00:00Z" },
    ];
    expect(jqLatestCRReview(reviews)).toBe("CHANGES_REQUESTED");
  });

  it("returns none when no CR reviews exist", () => {
    const reviews: Review[] = [
      { user: { login: "human-reviewer" }, state: "APPROVED", submitted_at: "2026-04-01T10:00:00Z" },
    ];
    expect(jqLatestCRReview(reviews)).toBe("none");
  });

  it("ignores COMMENTED state (only APPROVED/CHANGES_REQUESTED pass filter)", () => {
    const reviews: Review[] = [
      { user: { login: "coderabbitai[bot]" }, state: "COMMENTED", submitted_at: "2026-04-02T10:00:00Z" },
      { user: { login: "coderabbitai[bot]" }, state: "APPROVED", submitted_at: "2026-04-01T10:00:00Z" },
    ];
    // Latest non-CHANGES_REQUESTED is APPROVED
    expect(jqLatestCRReview(reviews)).toBe("APPROVED");
  });

  it("ignores reviews from other bots", () => {
    const reviews: Review[] = [
      { user: { login: "some-other-bot" }, state: "APPROVED", submitted_at: "2026-04-03T10:00:00Z" },
      { user: { login: "coderabbitai[bot]" }, state: "APPROVED", submitted_at: "2026-04-01T10:00:00Z" },
    ];
    expect(jqLatestCRReview(reviews)).toBe("APPROVED");
  });
});

// ---------------------------------------------------------------------------
// Helper: Bugbot check-run conclusion
// jq: [.check_runs[] | select(.name == "Cursor Bugbot")] | sort_by(.started_at) | reverse | .[0].conclusion // "none"
// ---------------------------------------------------------------------------

function jqBugbotConclusion(checkRuns: CheckRun[]): string {
  const filtered = checkRuns.filter((r) => r.name === "Cursor Bugbot");
  if (filtered.length === 0) return "none";
  const sorted = [...filtered].sort((a, b) =>
    b.started_at.localeCompare(a.started_at),
  );
  return sorted[0].conclusion ?? "none";
}

describe("skeptic-gate.yml — Bugbot check-run conclusion filter", () => {
  it("returns failure conclusion when Bugbot check failed", () => {
    const runs: CheckRun[] = [
      { name: "Lint", status: "completed", conclusion: "success", started_at: "2026-04-03T10:00:00Z" },
      { name: "Cursor Bugbot", status: "completed", conclusion: "failure", started_at: "2026-04-03T10:05:00Z" },
    ];
    expect(jqBugbotConclusion(runs)).toBe("failure");
  });

  it("returns success conclusion when Bugbot check passed", () => {
    const runs: CheckRun[] = [
      { name: "Cursor Bugbot", status: "completed", conclusion: "success", started_at: "2026-04-03T10:05:00Z" },
    ];
    expect(jqBugbotConclusion(runs)).toBe("success");
  });

  it("returns none when no Bugbot check exists", () => {
    const runs: CheckRun[] = [
      { name: "Lint", status: "completed", conclusion: "success", started_at: "2026-04-03T10:00:00Z" },
    ];
    expect(jqBugbotConclusion(runs)).toBe("none");
  });

  it("uses most recent Bugbot run when multiple exist", () => {
    const runs: CheckRun[] = [
      { name: "Cursor Bugbot", status: "completed", conclusion: "success", started_at: "2026-04-03T09:00:00Z" },
      { name: "Cursor Bugbot", status: "completed", conclusion: "failure", started_at: "2026-04-03T11:00:00Z" },
    ];
    expect(jqBugbotConclusion(runs)).toBe("failure"); // most recent wins
  });
});

// ---------------------------------------------------------------------------
// Helper: Prior skeptic-gate-result comment cleanup
// jq: [.[] | select(.user.login == "github-actions[bot]" and (.body | test("skeptic-gate-result-"))) | .id]
// ---------------------------------------------------------------------------

interface IssueComment {
  id: number;
  user: { login: string };
  body: string;
  created_at?: string;
  updated_at?: string;
}

function jqPriorResultCommentIds(comments: IssueComment[]): number[] {
  return comments
    .filter(
      (c) =>
        c.user.login === "github-actions[bot]" &&
        /skeptic-gate-result-/.test(c.body),
    )
    .map((c) => c.id);
}

describe("skeptic-gate.yml — prior-result comment cleanup filter", () => {
  it("returns IDs of prior result comments", () => {
    const comments: IssueComment[] = [
      { id: 100, user: { login: "github-actions[bot]" }, body: "## Skeptic Gate\nVERDICT: FAIL\n<!-- skeptic-gate-result-abc123 -->" },
      { id: 101, user: { login: "github-actions[bot]" }, body: "## Skeptic Gate\nVERDICT: PASS\n<!-- skeptic-gate-result-abc123 -->" },
      { id: 102, user: { login: "human-reviewer" }, body: "<!-- skeptic-gate-result-abc123 -->LGTM" },
      { id: 103, user: { login: "github-actions[bot]" }, body: "Thanks for the PR!" },
    ];
    const ids = jqPriorResultCommentIds(comments);
    expect(ids).toEqual([100, 101]); // both github-actions[bot] with marker
  });

  it("returns empty array when no prior result comments exist", () => {
    const comments: IssueComment[] = [
      { id: 200, user: { login: "github-actions[bot]" }, body: "Thanks for the PR!" },
    ];
    expect(jqPriorResultCommentIds(comments)).toEqual([]);
  });

  it("matches the marker regardless of marker position in body", () => {
    const comments: IssueComment[] = [
      { id: 300, user: { login: "github-actions[bot]" }, body: "<!-- skeptic-gate-result-abc123 -->" },
      { id: 301, user: { login: "github-actions[bot]" }, body: "VERDICT: PASS\n<!-- skeptic-gate-result-def456 -->" },
    ];
    expect(jqPriorResultCommentIds(comments)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// skeptic-cron.yml — Non-draft PR list filter
// jq: [.[] | select(.draft == false) | {number, title, head: {ref: .head.ref, sha: .head.sha}, base: {ref: .base.ref}, mergeable}]
// ---------------------------------------------------------------------------

interface GhPr {
  number: number;
  title: string;
  draft: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
  mergeable: boolean;
}

function jqNonDraftPRs(prs: GhPr[]): Array<{
  number: number;
  title: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  mergeable: boolean;
}> {
  return prs
    .filter((p) => !p.draft)
    .map((p) => ({
      number: p.number,
      title: p.title,
      head: { ref: p.head.ref, sha: p.head.sha },
      base: { ref: p.base.ref },
      mergeable: p.mergeable,
    }));
}

describe("skeptic-cron.yml — non-draft PR list filter", () => {
  it("filters out draft PRs and projects only the required fields", () => {
    const prs: GhPr[] = [
      { number: 1, title: "Draft PR", draft: true, head: { ref: "feat/x", sha: "aaa" }, base: { ref: "main" }, mergeable: true },
      { number: 2, title: "Open PR", draft: false, head: { ref: "feat/y", sha: "bbb" }, base: { ref: "main" }, mergeable: true },
      { number: 3, title: "Another Draft", draft: true, head: { ref: "feat/z", sha: "ccc" }, base: { ref: "main" }, mergeable: false },
      { number: 4, title: "Real PR", draft: false, head: { ref: "feat/w", sha: "ddd" }, base: { ref: "develop" }, mergeable: true },
    ];
    const result = jqNonDraftPRs(prs);
    expect(result).toHaveLength(2);
    expect(result[0].number).toBe(2);
    expect(result[0].title).toBe("Open PR");
    expect(result[1].number).toBe(4);
    expect(result[1].title).toBe("Real PR");
    // Only selected fields are present
    expect(result[0]).not.toHaveProperty("draft");
    expect(result[0]).not.toHaveProperty("body");
    expect(result[1].head.ref).toBe("feat/w");
    expect(result[1].base.ref).toBe("develop");
  });

  it("returns empty array when all PRs are drafts", () => {
    const prs: GhPr[] = [
      { number: 1, title: "Draft", draft: true, head: { ref: "x", sha: "aaa" }, base: { ref: "main" }, mergeable: true },
    ];
    expect(jqNonDraftPRs(prs)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// skeptic-cron.yml — Evidence check-run filtering
// jq: [.[] | .check_runs[]? | select((.name | ascii_downcase) | test("^evidence([ -]?gate| review)$"))] | length
// ---------------------------------------------------------------------------

function jqEvidenceCheckCount(
  checkRunsPages: Array<{ check_runs: CheckRun[] }>,
): number {
  const all = checkRunsPages.flatMap((p) => p.check_runs ?? []);
  const re = /^evidence([ -]?gate| review)$/i;
  return all.filter((r) => re.test(r.name.toLowerCase())).length;
}

function jqEvidenceCheckPassCount(
  checkRunsPages: Array<{ check_runs: CheckRun[] }>,
): number {
  const all = checkRunsPages.flatMap((p) => p.check_runs ?? []);
  const re = /^evidence([ -]?gate| review)$/i;
  return all.filter(
    (r) => re.test(r.name.toLowerCase()) && r.conclusion === "success",
  ).length;
}

describe("skeptic-cron.yml — evidence check-run filters", () => {
  it("matches evidence-gate check-run name variants", () => {
    // The jq filter applies ascii_downcase to the INPUT (check name), not the pattern.
    // .name.toLowerCase() lowercases before matching against lowercase literals.
    // "Evidence Gate" becomes "evidence gate" → matches ^evidence gate$.
    // The pattern [ -]? matches zero-or-one space-or-hyphen (NOT underscore).
    // "evidence-gate" (hyphen): matches — "evidence-gate" matches ^evidence(-)?gate$
    // "Evidence Gate" (space): matches — "evidence gate" matches ^evidence( )?gate$
    // "evidence_review" (underscore): does NOT match — "_" ≠ " " or "-" or ""
    // "EvidenceGate" (no separator): does NOT match — pattern requires "gate" immediately after "evidence"
    const pages = [
      {
        check_runs: [
          { name: "evidence-gate", status: "completed", conclusion: "success", started_at: "2026-04-03T10:00:00Z" },
          { name: "Evidence Gate", status: "completed", conclusion: "success", started_at: "2026-04-03T10:01:00Z" },
          { name: "evidence_review", status: "completed", conclusion: "success", started_at: "2026-04-03T10:02:00Z" },
        ],
      },
    ];
    expect(jqEvidenceCheckCount(pages)).toBe(2); // evidence-gate + Evidence Gate (underscore excluded)
    expect(jqEvidenceCheckPassCount(pages)).toBe(2);
  });

  it("rejects non-evidence check runs", () => {
    const pages = [
      {
        check_runs: [
          { name: "Lint", status: "completed", conclusion: "success", started_at: "2026-04-03T10:00:00Z" },
          { name: "evidence-gate", status: "completed", conclusion: "success", started_at: "2026-04-03T10:01:00Z" },
          { name: "Build", status: "completed", conclusion: "success", started_at: "2026-04-03T10:02:00Z" },
        ],
      },
    ];
    expect(jqEvidenceCheckCount(pages)).toBe(1);
  });

  it("counts only passing evidence checks in pass-count filter", () => {
    const pages = [
      {
        check_runs: [
          { name: "evidence-gate", status: "completed", conclusion: "success", started_at: "2026-04-03T10:00:00Z" },
          { name: "evidence-gate", status: "completed", conclusion: "failure", started_at: "2026-04-03T10:05:00Z" },
          { name: "Evidence Review", status: "completed", conclusion: "success", started_at: "2026-04-03T10:06:00Z" },
        ],
      },
    ];
    expect(jqEvidenceCheckCount(pages)).toBe(3);
    expect(jqEvidenceCheckPassCount(pages)).toBe(2); // 2 success, 1 failure
  });

  it("handles paginated evidence check runs across pages", () => {
    const pages = [
      { check_runs: [{ name: "evidence-gate", status: "completed", conclusion: "success", started_at: "2026-04-03T10:00:00Z" }] },
      { check_runs: [{ name: "Evidence Gate", status: "completed", conclusion: "success", started_at: "2026-04-03T10:01:00Z" }] },
    ];
    expect(jqEvidenceCheckCount(pages)).toBe(2);
    expect(jqEvidenceCheckPassCount(pages)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// skeptic-cron.yml — Verdict comment filter with SHA scoping
// jq: [.[] | select(.user.login == BOT and (.body | test("VERDICT:"; "i")) and (.body | test("skeptic-cron-trigger-" + PR_SHA; "i"))) | .body] | last // empty
// ---------------------------------------------------------------------------

function jqVerdictComment(
  comments: IssueComment[],
  botAuthor: string,
  triggerSha: string,
  requestId = "req-1",
  prAuthor = "pr-author",
): string {
  const hasEightPassingGates = (body: string): boolean => {
    for (let gate = 1; gate <= 8; gate += 1) {
      if (!new RegExp(`<!--\\s*skeptic-gate-${gate}\\s*:\\s*PASS\\s*-->`, "i").test(body)) {
        return false;
      }
    }
    return true;
  };
  const matching = comments.filter(
    (c) => {
      const userLogin = c.user.login.toLowerCase();
      const botLogin = botAuthor.toLowerCase();
      const prLogin = prAuthor.toLowerCase();
      const verdictMatch = c.body.match(/^[ \t]*(?:> ?)?(?:#{1,6}[ \t]*)?(?:\*{1,2})?VERDICT:[ \t]*(PASS|FAIL|SKIPPED)(?:\*{1,2})?[ \t]*(?:[-—:].*)?$/im);
      const verdictType = verdictMatch?.[1]?.toUpperCase();
      return (
        (userLogin === botLogin ||
          (userLogin === "github-actions[bot]" && userLogin !== prLogin)) &&
        /<!--\s*skeptic-agent-verdict\s*-->/i.test(c.body) &&
        Boolean(verdictType) &&
        new RegExp(`<!--\\s*skeptic-cron-trigger-${triggerSha}\\s*-->`, "i").test(c.body) &&
        new RegExp(`<!--\\s*skeptic-request-id-${requestId}\\s*-->`, "i").test(c.body) &&
        new RegExp(`<!--\\s*skeptic-head-sha-${triggerSha}\\s*-->`, "i").test(c.body) &&
        (verdictType !== "PASS" || hasEightPassingGates(c.body))
      );
    },
  );
  if (matching.length === 0) return "";
  // Return the body of the last matching comment in the array.
  // GitHub REST API returns comments in ascending ID order, so the last
  // element is the most recent — matching jq's `| last // empty` semantics.
  return matching[matching.length - 1].body;
}

describe("skeptic-cron.yml — verdict comment filter (SHA-scoped)", () => {
  const SHA_A = "abc1230000000000000000000000000000000000";
  const SHA_B = "def4560000000000000000000000000000000000";
  const boundPassBody = (sha: string, requestId = "req-1") => [
    "<!-- skeptic-agent-verdict -->",
    `<!-- skeptic-request-id-${requestId} -->`,
    `<!-- skeptic-head-sha-${sha} -->`,
    "<!-- skeptic-gate-1:PASS -->",
    "<!-- skeptic-gate-2:PASS -->",
    "<!-- skeptic-gate-3:PASS -->",
    "<!-- skeptic-gate-4:PASS -->",
    "<!-- skeptic-gate-5:PASS -->",
    "<!-- skeptic-gate-6:PASS -->",
    "<!-- skeptic-gate-7:PASS -->",
    "<!-- skeptic-gate-8:PASS -->",
    "VERDICT: PASS",
    `<!-- skeptic-cron-trigger-${sha} -->`,
  ].join("\n");

  it("matches verdict comment with matching SHA marker", () => {
    const comments: IssueComment[] = [
      { id: 100, user: { login: "github-actions[bot]" }, body: boundPassBody(SHA_A) },
      { id: 101, user: { login: "github-actions[bot]" }, body: "Thanks for the PR!" },
    ];
    expect(jqVerdictComment(comments, "github-actions[bot]", SHA_A)).toContain("VERDICT: PASS");
  });

  it("does not match gate-triggered verdicts in the cron path", () => {
    const comments: IssueComment[] = [
      {
        id: 110,
        user: { login: "github-actions[bot]" },
        body: boundPassBody(SHA_A).replace(`<!-- skeptic-cron-trigger-${SHA_A} -->`, `<!-- skeptic-gate-trigger-${SHA_A} -->`),
      },
    ];

    expect(jqVerdictComment(comments, "github-actions[bot]", SHA_A)).toBe("");
  });

  it("rejects legacy SHA-only PASS comments without request binding and gate markers", () => {
    const comments: IssueComment[] = [
      { id: 150, user: { login: "github-actions[bot]" }, body: `<!-- skeptic-agent-verdict -->\nVERDICT: PASS\n<!-- skeptic-cron-trigger-${SHA_A} -->` },
    ];
    expect(jqVerdictComment(comments, "github-actions[bot]", SHA_A)).toBe("");
  });

  it("rejects verdict comment with wrong SHA marker", () => {
    const comments: IssueComment[] = [
      { id: 200, user: { login: "github-actions[bot]" }, body: boundPassBody(SHA_B) },
    ];
    expect(jqVerdictComment(comments, "github-actions[bot]", SHA_A)).toBe("");
  });

  it("rejects comments without VERDICT keyword", () => {
    const comments: IssueComment[] = [
      { id: 300, user: { login: "github-actions[bot]" }, body: `<!-- skeptic-cron-trigger-${SHA_A} -->\nAll good!` },
    ];
    expect(jqVerdictComment(comments, "github-actions[bot]", SHA_A)).toBe("");
  });

  it("rejects comments from wrong author", () => {
    const comments: IssueComment[] = [
      { id: 400, user: { login: "jleechan2015" }, body: boundPassBody(SHA_A) },
    ];
    expect(jqVerdictComment(comments, "github-actions[bot]", SHA_A)).toBe("");
  });

  it("accepts verdict from SKEPTIC_BOT_AUTHOR even when they are the PR author", () => {
    const comments: IssueComment[] = [
      { id: 450, user: { login: "jleechan2015" }, body: boundPassBody(SHA_A) },
    ];
    // SKEPTIC_BOT_AUTHOR is trusted unconditionally — pr_author check only applies to github-actions[bot]
    expect(jqVerdictComment(comments, "jleechan2015", SHA_A, "req-1", "jleechan2015")).toContain("VERDICT: PASS");
  });

  it("rejects github-actions[bot] comments from the PR author when configured bot is DIFFERENT", () => {
    const comments: IssueComment[] = [
      { id: 460, user: { login: "github-actions[bot]" }, body: boundPassBody(SHA_A) },
    ];
    // When configured bot is different from github-actions[bot], the latter is subject to pr_author check
    expect(jqVerdictComment(comments, "jleechan2015", SHA_A, "req-1", "github-actions[bot]")).toBe("");
  });

  it("returns the most recent matching comment (highest ID)", () => {
    const comments: IssueComment[] = [
      { id: 500, user: { login: "github-actions[bot]" }, body: `<!-- skeptic-agent-verdict -->\nVERDICT: FAIL\n<!-- skeptic-cron-trigger-${SHA_A} -->` },
      { id: 501, user: { login: "github-actions[bot]" }, body: boundPassBody(SHA_A, "req-2") },
    ];
    expect(jqVerdictComment(comments, "github-actions[bot]", SHA_A, "req-2")).toContain("VERDICT: PASS");
  });

  it("matches the current request id when same-SHA PASS comments exist", () => {
    const comments: IssueComment[] = [
      { id: 510, user: { login: "github-actions[bot]" }, body: boundPassBody(SHA_A, "req-old") },
      { id: 511, user: { login: "github-actions[bot]" }, body: boundPassBody(SHA_A, "req-current") },
    ];

    expect(jqVerdictComment(comments, "github-actions[bot]", SHA_A, "req-current")).toContain("req-current");
  });

  it("allows explicit FAIL verdicts through without eight PASS gates", () => {
    const comments: IssueComment[] = [
      {
        id: 520,
        user: { login: "github-actions[bot]" },
        body: [
          "<!-- skeptic-agent-verdict -->",
          "<!-- skeptic-request-id-req-1 -->",
          `<!-- skeptic-head-sha-${SHA_A} -->`,
          "VERDICT: FAIL",
          `<!-- skeptic-cron-trigger-${SHA_A} -->`,
        ].join("\n"),
      },
    ];

    expect(jqVerdictComment(comments, "github-actions[bot]", SHA_A)).toContain("VERDICT: FAIL");
  });

  it("allows explicit SKIPPED verdicts through without eight PASS gates", () => {
    const comments: IssueComment[] = [
      {
        id: 530,
        user: { login: "github-actions[bot]" },
        body: [
          "<!-- skeptic-agent-verdict -->",
          "<!-- skeptic-request-id-req-1 -->",
          `<!-- skeptic-head-sha-${SHA_A} -->`,
          "VERDICT: SKIPPED",
          `<!-- skeptic-cron-trigger-${SHA_A} -->`,
        ].join("\n"),
      },
    ];

    expect(jqVerdictComment(comments, "github-actions[bot]", SHA_A)).toContain("VERDICT: SKIPPED");
  });

  it("uses the anchored verdict line instead of PASS text in reasoning", () => {
    const comments: IssueComment[] = [
      {
        id: 540,
        user: { login: "github-actions[bot]" },
        body: [
          "<!-- skeptic-agent-verdict -->",
          "<!-- skeptic-request-id-req-1 -->",
          `<!-- skeptic-head-sha-${SHA_A} -->`,
          "The criteria for VERDICT: PASS are not met.",
          "VERDICT: FAIL",
          `<!-- skeptic-cron-trigger-${SHA_A} -->`,
        ].join("\n"),
      },
    ];

    expect(jqVerdictComment(comments, "github-actions[bot]", SHA_A)).toContain("VERDICT: FAIL");
  });

  it("normalizes author casing when matching the bot author", () => {
    const comments: IssueComment[] = [
      { id: 550, user: { login: "JLeeChan2015" }, body: boundPassBody(SHA_A) },
    ];

    expect(jqVerdictComment(comments, "jleechan2015", SHA_A)).toContain("VERDICT: PASS");
  });

  it("accepts verdict from SKEPTIC_BOT_AUTHOR regardless of PR author (case-normalized)", () => {
    const comments: IssueComment[] = [
      { id: 560, user: { login: "JLeeChan2015" }, body: boundPassBody(SHA_A) },
    ];
    // SKEPTIC_BOT_AUTHOR is trusted unconditionally even when they are the PR author
    expect(jqVerdictComment(comments, "jleechan2015", SHA_A, "req-1", "jleechan2015")).toContain("VERDICT: PASS");
  });

  it("is case-insensitive on VERDICT keyword", () => {
    const comments: IssueComment[] = [
      { id: 600, user: { login: "github-actions[bot]" }, body: boundPassBody(SHA_A).replace("VERDICT: PASS", "verdict: pass") },
    ];
    expect(jqVerdictComment(comments, "github-actions[bot]", SHA_A)).not.toBe("");
  });

  it("accepts both github-actions[bot] and configured SKEPTIC_BOT_AUTHOR", () => {
    const comments: IssueComment[] = [
      { id: 700, user: { login: "jleechan2015" }, body: boundPassBody(SHA_A) },
    ];
    expect(jqVerdictComment(comments, "jleechan2015", SHA_A)).toContain("VERDICT: PASS");
  });
});

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
