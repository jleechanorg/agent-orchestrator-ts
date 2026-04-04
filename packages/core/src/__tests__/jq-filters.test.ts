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
): string {
  const matching = comments.filter(
    (c) =>
      c.user.login === botAuthor &&
      /VERDICT:/i.test(c.body) &&
      new RegExp(`skeptic-cron-trigger-${triggerSha}`, "i").test(c.body),
  );
  if (matching.length === 0) return "";
  // Return the body of the last matching comment (most recent)
  const sorted = [...matching].sort((a, b) => b.id - a.id);
  return sorted[0].body;
}

describe("skeptic-cron.yml — verdict comment filter (SHA-scoped)", () => {
  const SHA_A = "abc1230000000000000000000000000000000000";
  const SHA_B = "def4560000000000000000000000000000000000";

  it("matches verdict comment with matching SHA marker", () => {
    const comments: IssueComment[] = [
      { id: 100, user: { login: "github-actions[bot]" }, body: `SKEPTIC_CRON_TRIGGER\n<!-- skeptic-cron-trigger-${SHA_A} -->\nVERDICT: PASS` },
      { id: 101, user: { login: "github-actions[bot]" }, body: "Thanks for the PR!" },
    ];
    expect(jqVerdictComment(comments, "github-actions[bot]", SHA_A)).toContain("VERDICT: PASS");
  });

  it("rejects verdict comment with wrong SHA marker", () => {
    const comments: IssueComment[] = [
      { id: 200, user: { login: "github-actions[bot]" }, body: `VERDICT: PASS\n<!-- skeptic-cron-trigger-${SHA_B} -->` },
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
      { id: 400, user: { login: "jleechan2015" }, body: `VERDICT: PASS\n<!-- skeptic-cron-trigger-${SHA_A} -->` },
    ];
    expect(jqVerdictComment(comments, "github-actions[bot]", SHA_A)).toBe("");
  });

  it("returns the most recent matching comment (highest ID)", () => {
    const comments: IssueComment[] = [
      { id: 500, user: { login: "github-actions[bot]" }, body: `VERDICT: FAIL\n<!-- skeptic-cron-trigger-${SHA_A} -->` },
      { id: 501, user: { login: "github-actions[bot]" }, body: `VERDICT: PASS\n<!-- skeptic-cron-trigger-${SHA_A} -->` },
    ];
    expect(jqVerdictComment(comments, "github-actions[bot]", SHA_A)).toContain("VERDICT: PASS");
  });

  it("is case-insensitive on VERDICT keyword", () => {
    const comments: IssueComment[] = [
      { id: 600, user: { login: "github-actions[bot]" }, body: `verdict: pass\n<!-- skeptic-cron-trigger-${SHA_A} -->` },
    ];
    expect(jqVerdictComment(comments, "github-actions[bot]", SHA_A)).not.toBe("");
  });

  it("accepts both github-actions[bot] and configured SKEPTIC_BOT_AUTHOR", () => {
    const comments: IssueComment[] = [
      { id: 700, user: { login: "jleechan2015" }, body: `VERDICT: PASS\n<!-- skeptic-cron-trigger-${SHA_A} -->` },
    ];
    expect(jqVerdictComment(comments, "jleechan2015", SHA_A)).toContain("VERDICT: PASS");
  });
});
