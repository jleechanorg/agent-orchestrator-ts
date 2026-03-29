/**
 * Merge gate state — fetches PR state matching the actual checkMergeGate logic.
 * Aligned with packages/core/src/merge-gate.ts and merge-gate-coderabbit.ts.
 *
 * Key alignments:
 * - Nitpick comments are filtered out (same as checkMergeGate nitPattern)
 * - Merged PRs are treated as mergeable (no conflicts)
 * - CR review dismissed detection mirrors hasUnresolvedDismissedReview
 * - Evidence review state is included
 */

import { ghJson, ghJsonPaginate, fetchReviews, type ReviewInfo } from "./gh-client.js";
import { VERDICT_LINE_RE } from "./verdict-utils.js";

const NIT_PATTERN = /^(nit:|nitpick)/i;
const CR_BOT = "coderabbitai[bot]";
const EVIDENCE_BOT = "evidence-review-bot";
/** Matches the HTML comment marker that marks skeptic agent comments. */
const SKEPTIC_MARKER_RE = /<!--\s*skeptic-agent-verdict\s*-->/i;

export interface CheckRunSummary {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface MergeGateState {
  ciPassing: boolean;
  /** Raw commit status state from GitHub API (e.g. "success", "failure", "pending") */
  ciRawState: string;
  /** Individual CI check run results for independent verification */
  checkRuns: CheckRunSummary[];
  noConflicts: boolean;
  /** Raw mergeable boolean from GitHub API: true = MERGEABLE, false/null = not yet determined or conflicting */
  mergeableRaw: boolean | null;
  crApproved: boolean;
  crState: string;
  crDismissedWithoutApproval: boolean;
  bugbotErrors: number;
  unresolvedBlockingComments: number;
  evidenceApproved: boolean;
  evidenceRequired: boolean;
  skepticVerdict: "PASS" | "FAIL" | "SKIPPED" | null;
  skepticCommentId: number | null;
}

/** Sort reviews newest-first, tolerating missing timestamps. */
function sortReviewsNewestFirst(a: ReviewInfo, b: ReviewInfo): number {
  return (new Date(b.submittedAt).getTime() || 0) - (new Date(a.submittedAt).getTime() || 0);
}

/**
 * Detect if a CR review was dismissed without a subsequent real APPROVED.
 * Mirrors hasUnresolvedDismissedReview in merge-gate-coderabbit.ts.
 */
function hasUnresolvedDismissedReview(reviews: ReviewInfo[]): boolean {
  const crReviews = reviews.filter((r) => r.author?.login === CR_BOT);
  if (crReviews.length === 0) return false;
  const sorted = [...crReviews].sort(sortReviewsNewestFirst);
  for (const review of sorted) {
    if ((review.state ?? "").toUpperCase() === "DISMISSED") return true;
    if (review.state === "approved") return false;
  }
  return false;
}

/**
 * Get the latest decisive CR review (approved or changes_requested, newest first).
 */
function getLatestDecisiveReview(reviews: ReviewInfo[]): ReviewInfo | null {
  return (
    reviews
      .filter(
        (r) =>
          r.author?.login === CR_BOT &&
          (r.state === "approved" || r.state === "changes_requested"),
      )
      .sort(sortReviewsNewestFirst)[0] ?? null
  );
}

export async function fetchMergeGateState(
  owner: string,
  repo: string,
  prNumber: number,
  skepticBotAuthor: string,
): Promise<MergeGateState> {
  // 1. CI status + mergeability — single call to /pulls/{prNumber}, extract both
  let ciPassing = false;
  let ciRawState = "unknown";
  let noConflicts = false;
  let mergeableRaw: boolean | null = null;
  let checkRuns: CheckRunSummary[] = [];
  try {
    const prData = await ghJson(
      "repos/" + owner + "/" + repo + "/pulls/" + prNumber,
    ) as { head?: { ref?: string; sha?: string }; mergeable?: boolean; merged?: boolean };
    mergeableRaw = prData?.mergeable ?? null;
    noConflicts = prData?.mergeable === true || prData?.merged === true;
    const headSha = prData?.head?.sha;
    // Use headSha (immutable commit SHA) to avoid TOCTOU races
    // where the branch moves between status check and merge.
    if (headSha) {
      const commitStatus = await ghJson(
        "repos/" + owner + "/" + repo + "/commits/" + headSha + "/status",
      ) as { state?: string };
      ciRawState = commitStatus?.state ?? "unknown";
      ciPassing = commitStatus?.state === "success";
    }
    // Fetch individual check runs for independent verification (paginated to capture all pages)
    if (headSha) {
      try {
        // ghJsonPaginate returns an array of pages (--slurp), each with {total_count, check_runs: [...]}
        const checkRunPages = await ghJsonPaginate(
          "repos/" + owner + "/" + repo + "/commits/" + headSha + "/check-runs?per_page=100",
        ) as Array<{ check_runs?: Array<{ name: string; status: string; conclusion: string | null }> }>;
        const checkRunData = checkRunPages.flatMap(p => p.check_runs ?? []);
        // Deduplicate by name, keeping latest conclusion
        const seen = new Map<string, CheckRunSummary>();
        for (const run of checkRunData) {
          const existing = seen.get(run.name);
          // Prefer completed runs over in-progress
          if (!existing || (run.status === "completed" && existing.status !== "completed")) {
            seen.set(run.name, { name: run.name, status: run.status, conclusion: run.conclusion });
          }
        }
        checkRuns = [...seen.values()];
      } catch {
        // non-fatal — check runs stay empty
      }
    }
  } catch {
    // ciPassing stays false; noConflicts stays false (already initialized)
  }

  // 2. CR review state — mirrors checkMergeGate + merge-gate-coderabbit.ts
  const reviews = await fetchReviews(owner, repo, prNumber);
  const latestCR = getLatestDecisiveReview(reviews);
  const crDismissedWithoutApproval = hasUnresolvedDismissedReview(reviews);

  let crApproved = false;
  let crState = "none";
  if (latestCR) {
    crState = latestCR.state;
    crApproved = latestCR.state === "approved" && !crDismissedWithoutApproval;
  }

  // 3. Review threads — nit-filtered unresolved counts (matches checkMergeGate)
  // Uses GraphQL reviewThreads.isResolved (REST /pulls/{n}/comments has no state field).
  let bugbotErrors = 0;
  let unresolvedBlockingComments = 0;
  try {
    // Paginate through all review threads (100 per page)
    const allNodes: Array<{
      isResolved: boolean;
      isOutdated: boolean;
      comments?: { nodes?: Array<{ body: string; author?: { login: string } }> };
    }> = [];
    let cursor: string | null = null;
    let hasNextPage = true;
    while (hasNextPage) {
      // Escape control chars (\n \r \t \f) for GraphQL single-line string literals.
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
      const safeOwner = esc(owner);
      const safeRepo = esc(repo);
      const safeCursor = esc(cursor ?? "");
      const afterArg = safeCursor ? `, after:"${safeCursor}"` : "";
      const threadQuery = `{
  repository(owner:"${safeOwner}", name:"${safeRepo}") {
    pullRequest(number:${prNumber}) {
      reviewThreads(first:100${afterArg}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          comments(first:1) {
            nodes { body author { login } }
          }
        }
      }
    }
  }
}`;
      const threadData = await ghJson("graphql", ["-f", "query=" + threadQuery]) as {
        data?: {
          repository?: {
            pullRequest?: {
              reviewThreads?: {
                pageInfo?: { hasNextPage?: boolean; endCursor?: string };
                nodes?: Array<{
                  isResolved: boolean;
                  isOutdated: boolean;
                  comments?: { nodes?: Array<{ body: string; author?: { login: string } }> };
                }>;
              };
            };
          };
        };
      };
      const page = threadData?.data?.repository?.pullRequest?.reviewThreads;
      if (page?.nodes) allNodes.push(...page.nodes);
      hasNextPage = page?.pageInfo?.hasNextPage ?? false;
      cursor = page?.pageInfo?.endCursor ?? null;
    }
    const threads = allNodes;
    for (const t of threads) {
      if (t.isResolved || t.isOutdated) continue;
      const firstComment = t.comments?.nodes?.[0];
      const body = firstComment?.body ?? "";
      const author = firstComment?.author?.login ?? "";
      const isNit = NIT_PATTERN.test(body.trimStart());
      const isBugbot =
        /cursor\[bot]/i.test(author) &&
        /error/i.test(body);

      if (isBugbot) bugbotErrors++;
      if (!isNit) unresolvedBlockingComments++;
    }
  } catch (e) {
    // Fail-closed: if we cannot determine thread state, treat as blocking.
    // This prevents false negatives where a broken API returns no threads,
    // causing merge gate to pass despite unresolved comments being present.
    console.error("[mergeGate] Review thread fetch failed:", e);
    unresolvedBlockingComments = 9999; // sentinel: fetch failed, fail-closed — treat as blocking
  }

  // 4. Evidence review
  const evidenceReviews = reviews.filter((r) => r.author?.login === EVIDENCE_BOT);
  const latestEvidence = evidenceReviews.sort(sortReviewsNewestFirst)[0];
  const evidenceApproved = latestEvidence?.state === "approved";
  const evidenceRequired = false; // controlled via config; default false for skeptic CLI

  // 5. Existing skeptic verdict — use paginated fetch to capture all pages of comments
  let skepticVerdict: "PASS" | "FAIL" | "SKIPPED" | null = null;
  let skepticCommentId: number | null = null;
  try {
    // ghJsonPaginate uses --paginate --slurp: each page is a separate array element.
    // Flatten to a single array of comments before iterating.
    const commentPages = (await ghJsonPaginate(
      "repos/" + owner + "/" + repo + "/issues/" + prNumber + "/comments?per_page=100",
    )) as Array<Array<{ id: number; body: string; user?: { login: string } }>>;
    const comments = commentPages.flat();
    // Accept both the configured bot author and github-actions[bot].
    // The GHA runner posts SKIPPED fallback verdicts as github-actions[bot] when
    // ao skeptic verify cannot post (e.g., no API keys in GHA). Matching only
    // skepticBotAuthor would miss those fallback verdicts and cause incorrect
    // null results on subsequent fetchMergeGateState calls.
    const ACCEPTED_AUTHORS = new Set([skepticBotAuthor, "github-actions[bot]"]);
    for (const c of comments) {
      if (c.user?.login && ACCEPTED_AUTHORS.has(c.user.login)) {
        // Only parse verdicts from comments that carry the skeptic marker — this
        // prevents unrelated github-actions[bot] comments from being misidentified.
        if (!SKEPTIC_MARKER_RE.test(c.body)) continue;
        // Use the shared VERDICT_LINE_RE from verdict-utils.ts — it accepts both plain
        // VERDICT: PASS and markdown-bold **VERDICT: PASS** variants.
        const m = c.body.match(VERDICT_LINE_RE);
        if (m) {
          skepticVerdict = m[1].toUpperCase() as "PASS" | "FAIL" | "SKIPPED";
          skepticCommentId = c.id;
          // Do NOT break — keep iterating so the last match reflects the newest verdict
        }
      }
    }
  } catch {
    // non-fatal
  }

  return {
    ciPassing,
    ciRawState,
    checkRuns,
    noConflicts,
    mergeableRaw,
    crApproved,
    crState,
    crDismissedWithoutApproval,
    bugbotErrors,
    unresolvedBlockingComments,
    evidenceApproved,
    evidenceRequired,
    skepticVerdict,
    skepticCommentId,
  };
}


