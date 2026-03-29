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

import { ghJson, ghJsonPaginate, fetchReviews, fetchIssueComments, type ReviewInfo } from "./gh-client.js";

const NIT_PATTERN = /^(nit:|nitpick|_🧹\s*nitpick)/i;
const CR_BOT = "coderabbitai[bot]";
const EVIDENCE_BOT = "evidence-review-bot";
const CR_CHAT_APPROVE_PATTERN = /\[approve\]|ready for merge|ready to merge|this pr is ready to ship|STATUS: READY FOR MERGE|all good from my side/i;

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
  /** CR posted [approve]/READY FOR MERGE in chat (incremental review deadlock bypass) */
  crChatApproval: boolean;
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
    // Use the immutable head SHA (not the mutable branch ref) so a push between
    // fetching PR data and fetching status cannot mix states from different commits.
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
        const checkRunData = await ghJsonPaginate(
          "repos/" + owner + "/" + repo + "/commits/" + headSha + "/check-runs?per_page=100",
        ) as Array<{ name: string; status: string; conclusion: string | null }>;
        // Deduplicate by name, keeping latest conclusion
        const seen = new Map<string, CheckRunSummary>();
        for (const run of (checkRunData ?? [])) {
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
      const afterArg = cursor ? `, after:"${cursor}"` : "";
      const threadQuery = `{
  repository(owner:"${owner}", name:"${repo}") {
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
  } catch {
    // non-fatal
  }

  // 4. Evidence review
  const evidenceReviews = reviews.filter((r) => r.author?.login === EVIDENCE_BOT);
  const latestEvidence = evidenceReviews.sort(sortReviewsNewestFirst)[0];
  const evidenceApproved = latestEvidence?.state === "approved";
  const evidenceRequired = false; // controlled via config; default false for skeptic CLI

  // 5. Issue comments — skeptic verdict + CR chat approval detection
  let skepticVerdict: "PASS" | "FAIL" | "SKIPPED" | null = null;
  let skepticCommentId: number | null = null;
  let crChatApproval = false;
  try {
    // Use paginated client so verdict comments beyond page 1 are not silently dropped.
    const comments = await fetchIssueComments(owner, repo, prNumber);
    for (const c of comments) {
      // CR chat approval detection: CR posts "[approve]" or "READY FOR MERGE" in chat
      // when incremental review system prevents formal APPROVED state update after rebases.
      if (c.user?.login === CR_BOT && CR_CHAT_APPROVE_PATTERN.test(c.body)) {
        const hasCRChangesRequested = reviews.some(
          (r) => r.author?.login === CR_BOT && r.state === "changes_requested",
        );
        if (!hasCRChangesRequested) {
          crChatApproval = true;
        }
      }
      // Skeptic verdict detection
      if (c.user?.login === skepticBotAuthor) {
        if (/VERDICT:\s*PASS/i.test(c.body)) {
          skepticVerdict = "PASS";
          skepticCommentId = c.id;
        } else if (/VERDICT:\s*FAIL/i.test(c.body)) {
          skepticVerdict = "FAIL";
          skepticCommentId = c.id;
        } else if (/VERDICT:\s*SKIPPED/i.test(c.body)) {
          skepticVerdict = "SKIPPED";
          skepticCommentId = c.id;
        }
      }
    }
    // CR chat approval override: if CR approved via chat and no blocking comments, treat as approved
    if (crChatApproval && !crApproved && unresolvedBlockingComments === 0) {
      crApproved = true;
      crState = crState === "none" ? "commented_chat_approved" : crState + "_chat_approved";
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
    crChatApproval,
    crDismissedWithoutApproval,
    bugbotErrors,
    unresolvedBlockingComments,
    evidenceApproved,
    evidenceRequired,
    skepticVerdict,
    skepticCommentId,
  };
}
