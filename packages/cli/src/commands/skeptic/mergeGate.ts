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
import {
  escapeRegexLiteral,
  isFreshPassVerdictContractSatisfied,
  VERDICT_LINE_RE,
} from "./verdict-utils.js";

const NIT_PATTERN = /^(nit:|nitpick)/i;
// GraphQL author.login returns "coderabbitai" (without [bot] suffix) for the CodeRabbit bot.
// REST API user.login returns "coderabbitai[bot]" — but fetchReviews uses GraphQL, so this is correct.
const CR_BOT = "coderabbitai";
const EVIDENCE_BOT = "evidence-review-bot";

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
    const stateLower = (review.state ?? "").toLowerCase();
    if (stateLower === "dismissed") return true;
    if (stateLower === "approved") return false;
  }
  return false;
}

/**
 * Get the latest decisive CR review (approved or changes_requested, newest first).
 *
 * When `headSha` is provided, the result is restricted to reviews attached to
 * that head SHA. This prevents stale `CHANGES_REQUESTED` reviews on a
 * superseded head from causing false-FAIL verdicts. GitHub's UI-level
 * `reviewDecision` reflects the worst state across ALL reviews (including
 * ones on old heads), so we explicitly filter here.
 */
function getLatestDecisiveReview(
  reviews: ReviewInfo[],
  headSha?: string | null,
): ReviewInfo | null {
  const filtered = reviews.filter(
    (r) =>
      r.author?.login === CR_BOT &&
      ((r.state ?? "").toLowerCase() === "approved" ||
        (r.state ?? "").toLowerCase() === "changes_requested") &&
      // If we know the head SHA, the review must be attached to it.
      // Reviews without commitId (very old) are dropped when headSha is
      // known so we never trust unanchored reviews.
      (!headSha || r.commitId === headSha),
  );
  return filtered.sort(sortReviewsNewestFirst)[0] ?? null;
}

function extractSkepticRequestId(body: string): string | undefined {
  const match = body.match(/<!--\s*skeptic-request-id-([A-Za-z0-9_.:-]+)\s*-->/i);
  return match?.[1];
}

function hasMatchingWorkflowTrigger(
  comments: Array<{ body: string; user?: { login: string } }>,
  verdictBody: string,
  headSha: string | undefined,
  requestId: string | undefined,
): string | undefined {
  if (!headSha || !requestId) return undefined;
  const escapedSha = escapeRegexLiteral(headSha);
  const escapedRequestId = escapeRegexLiteral(requestId);
  const headShaRe = new RegExp(`<!--\\s*skeptic-head-sha-${escapedSha}\\s*-->`, "i");
  const requestIdRe = new RegExp(`<!--\\s*skeptic-request-id-${escapedRequestId}\\s*-->`, "i");
  const triggerTypes = (["gate", "cron"] as const).filter((type) =>
    new RegExp(`<!--\\s*skeptic-${type}-trigger-${escapedSha}\\s*-->`, "i").test(verdictBody),
  );
  if (triggerTypes.length === 0) return undefined;

  for (const type of triggerTypes) {
    const triggerLabelRe = new RegExp(`SKEPTIC_${type.toUpperCase()}_TRIGGER`, "i");
    const triggerMarkerRe = new RegExp(`<!--\\s*skeptic-${type}-trigger-${escapedSha}\\s*-->`, "i");
    const found = comments.some(
      (comment) =>
        comment.user?.login?.toLowerCase() === "github-actions[bot]" &&
        triggerLabelRe.test(comment.body) &&
        triggerMarkerRe.test(comment.body) &&
        headShaRe.test(comment.body) &&
        requestIdRe.test(comment.body),
    );
    if (found) return requestId;
  }
  return undefined;
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
  let headSha: string | undefined;
  let prAuthor: string | undefined;
  try {
    const prData = await ghJson(
      "repos/" + owner + "/" + repo + "/pulls/" + prNumber,
    ) as { head?: { ref?: string; sha?: string }; mergeable?: boolean; merged?: boolean; user?: { login?: string } };
    mergeableRaw = prData?.mergeable ?? null;
    noConflicts = prData?.mergeable === true || prData?.merged === true;
    headSha = prData?.head?.sha;
    prAuthor = prData?.user?.login;
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
        // Exclude self-referential "Skeptic Gate" check — its failure is the mechanism
        // that polls for this verdict, creating a circular dependency. The check's
        // own pass/fail is determined by whether THIS verdict appears, not by CI health.
        const SKEPTIC_GATE_CHECK = /^Skeptic\s+Gate$/i;
        const filtered = checkRunData.filter(r => !SKEPTIC_GATE_CHECK.test(r.name ?? ""));
        // Deduplicate by name, keeping latest conclusion
        const seen = new Map<string, CheckRunSummary>();
        for (const run of filtered) {
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
  // CRITICAL: filter by head SHA. GitHub's UI-level reviewDecision returns
  // the worst state across ALL reviews, including stale CHANGES_REQUESTED
  // reviews on superseded head SHAs. Passing headSha here makes the gate
  // trust only reviews actually attached to the current head.
  const latestCR = getLatestDecisiveReview(reviews, headSha);
  const crDismissedWithoutApproval = hasUnresolvedDismissedReview(reviews);

  let crApproved = false;
  let crState = "none";
  if (latestCR) {
    crState = latestCR.state;
    crApproved = (latestCR.state ?? "").toLowerCase() === "approved" && !crDismissedWithoutApproval;
  } else if (headSha) {
    // No on-head decisive review. Surface this explicitly so the LLM doesn't
    // fall back to GitHub's UI-level reviewDecision (which reflects stale
    // reviews on old SHAs and would say CHANGES_REQUESTED even when the
    // current head is clean).
    crState = "none-on-head";
  }
    crState = latestCR.state;
    crApproved = (latestCR.state ?? "").toLowerCase() === "approved" && !crDismissedWithoutApproval;
  }

  // Fallback: check comments for CodeRabbit's [approve] comment if review state is not approved
  if (!crApproved) {
    try {
      if (headSha) {
        const commitData = await ghJson(
          "repos/" + owner + "/" + repo + "/commits/" + headSha,
        ) as { commit?: { committer?: { date?: string } } };
        const headCommittedAt = commitData?.commit?.committer?.date;

        if (headCommittedAt) {
          const headTime = new Date(headCommittedAt).getTime();
          const commentPages = (await ghJsonPaginate(
            "repos/" + owner + "/" + repo + "/issues/" + prNumber + "/comments?per_page=100",
          )) as Array<Array<{ id: number; body: string; created_at: string; user?: { login: string } }>>;
          const comments = commentPages.flat();

          const hasApproveComment = comments.some((c) => {
            const author = c.user?.login?.toLowerCase() ?? "";
            const isCR = author === "coderabbitai" || author === "coderabbitai[bot]";
            if (!isCR) return false;
            if (!c.body) return false;
            const commentTime = new Date(c.created_at).getTime();
            if (commentTime < headTime) return false;
            return /^\s*\[approve\]\s*$|\bchanges approved\./im.test(c.body);
          });

          if (hasApproveComment) {
            crApproved = true;
            crState = "approved (comment)";
          }
        }
      }
    } catch (err) {
      console.warn("[skeptic] CodeRabbit comment-based approval fallback failed:", err);
    }
  }

  // 3. Review threads — nit-filtered unresolved counts (matches checkMergeGate)
  // Uses GraphQL reviewThreads.isResolved (REST /pulls/{n}/comments has no state field).
  // Errors are NOT caught here — fail-closed: if we cannot determine comment state,
  // we must not silently report 0 unresolved comments (which would bypass CR Gate 5).
  let bugbotErrors = 0;
  let unresolvedBlockingComments = 0;
    // Paginate through all review threads (100 per page)
    const allNodes: Array<{
      isResolved: boolean;
      isOutdated: boolean;
      comments?: { nodes?: Array<{ body: string; author?: { login: string } }> };
    }> = [];
    let cursor: string | null = null;
    let hasNextPage = true;
    while (hasNextPage) {
      // Escape GraphQL string inputs to prevent injection via --repo owner/repo.
      // owner/repo are CLI-supplied; cursor comes from GitHub API (trusted but still escaped).
      // Escape control chars (\n \r \t \f) for GraphQL single-line string literals.
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/\f/g, "\\f");
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
    const ACCEPTED_AUTHORS = new Set(
      [skepticBotAuthor, "github-actions[bot]"].map((login) => login.toLowerCase()),
    );
    for (const c of comments) {
      const authorLogin = c.user?.login?.toLowerCase();
      if (authorLogin && ACCEPTED_AUTHORS.has(authorLogin)) {
        // Require the skeptic-agent-verdict HTML marker — prevents spoofed verdicts
        // from malicious actors who gain write access to the bot account.
        if (!/<!-- skeptic-agent-verdict -->/i.test(c.body)) continue;
        // Use the shared VERDICT_LINE_RE from verdict-utils.ts — it accepts both plain
        // VERDICT: PASS and markdown-bold **VERDICT: PASS** variants.
        const m = c.body.match(VERDICT_LINE_RE);
        if (m) {
          const parsedVerdict = m[1].toUpperCase() as "PASS" | "FAIL" | "SKIPPED";
          const verdictRequestId = extractSkepticRequestId(c.body);
          const authorIsPrAuthor =
            typeof prAuthor === "string" &&
            prAuthor.length > 0 &&
            authorLogin === prAuthor.toLowerCase();
          if (authorIsPrAuthor) continue;
          if (
            parsedVerdict === "PASS" &&
            (!isFreshPassVerdictContractSatisfied(c.body, headSha, verdictRequestId) ||
              !hasMatchingWorkflowTrigger(comments, c.body, headSha, verdictRequestId))
          ) {
            continue;
          }
          skepticVerdict = parsedVerdict;
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
