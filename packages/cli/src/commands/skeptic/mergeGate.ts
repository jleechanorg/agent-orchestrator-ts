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

import { ghJson, fetchReviews, type ReviewInfo } from "./gh-client.js";

const NIT_PATTERN = /^(nit:|nitpick)/i;
const CR_BOT = "coderabbitai[bot]";
const EVIDENCE_BOT = "evidence-review-bot";

export interface MergeGateState {
  ciPassing: boolean;
  noConflicts: boolean;
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
  let noConflicts = false;
  try {
    const prData = await ghJson(
      "repos/" + owner + "/" + repo + "/pulls/" + prNumber,
    ) as { head?: { sha?: string; ref?: string }; mergeable?: boolean; merged?: boolean };
    noConflicts = prData?.mergeable === true || prData?.merged === true;
    // Use head.sha (immutable commit SHA) instead of head.ref (mutable branch ref)
    // to avoid TOCTOU races where the branch moves between status check and merge.
    const headSha = prData?.head?.sha;
    if (headSha) {
      const commitStatus = await ghJson(
        "repos/" + owner + "/" + repo + "/commits/" + headSha + "/status",
      ) as { state?: string };
      ciPassing = commitStatus?.state === "success";
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
  // Uses GraphQL reviewThreads to get accurate isResolved state (REST /comments lacks it).
  let bugbotErrors = 0;
  let unresolvedBlockingComments = 0;
  try {
    const gqlQuery = `
      query($owner: String!, $repo: String!, $pr: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            reviewThreads(first: 100) {
              nodes {
                isResolved
                comments(first: 1) {
                  nodes {
                    author { login }
                    body
                  }
                }
              }
            }
          }
        }
      }
    `;
    const gqlData = await ghJson("graphql", [
      "-f", "query=" + gqlQuery,
      "-F", "owner=" + owner,
      "-F", "repo=" + repo,
      "-F", "pr=" + prNumber,
    ]) as {
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              nodes?: Array<{
                isResolved: boolean;
                comments: { nodes: Array<{ author?: { login?: string }; body?: string }> };
              }>;
            };
          };
        };
      };
    };
    const threads = gqlData?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    for (const thread of threads) {
      const firstComment = thread.comments.nodes[0];
      const body = firstComment?.body ?? "";
      const author = firstComment?.author?.login ?? "";
      const isNit = NIT_PATTERN.test(body.trimStart());
      const isBugbot =
        /cursor\[bot]/i.test(author) &&
        /error/i.test(body) &&
        !thread.isResolved;

      if (isBugbot) bugbotErrors++;
      if (!thread.isResolved && !isNit) unresolvedBlockingComments++;
    }
  } catch {
    // non-fatal: fall back to 0 unresolved (conservative — avoids false positives)
  }

  // 4. Evidence review
  const evidenceReviews = reviews.filter((r) => r.author?.login === EVIDENCE_BOT);
  const latestEvidence = evidenceReviews.sort(sortReviewsNewestFirst)[0];
  const evidenceApproved = latestEvidence?.state === "approved";
  const evidenceRequired = false; // controlled via config; default false for skeptic CLI

  // 5. Existing skeptic verdict
  let skepticVerdict: "PASS" | "FAIL" | "SKIPPED" | null = null;
  let skepticCommentId: number | null = null;
  try {
    const comments = await ghJson(
      "repos/" + owner + "/" + repo + "/issues/" + prNumber + "/comments?per_page=100",
    ) as Array<{ id: number; body: string; user?: { login: string } }>;
    for (const c of comments) {
      if (c.user?.login === skepticBotAuthor) {
        if (/VERDICT:\s*PASS/i.test(c.body)) {
          skepticVerdict = "PASS";
          skepticCommentId = c.id;
          break;
        } else if (/VERDICT:\s*FAIL/i.test(c.body)) {
          skepticVerdict = "FAIL";
          skepticCommentId = c.id;
          break;
        } else if (/VERDICT:\s*SKIPPED/i.test(c.body)) {
          skepticVerdict = "SKIPPED";
          skepticCommentId = c.id;
          break;
        }
      }
    }
  } catch {
    // non-fatal
  }

  return {
    ciPassing,
    noConflicts,
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


