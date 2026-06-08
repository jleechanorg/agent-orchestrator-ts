// GitHub comment body hard limit is 65536 chars. Reserve ~4000 for header/footer so
// llmOutput can safely occupy the bulk without risking 422 on createComment/patchComment.
const MAX_LLM_OUTPUT_CHARS = 60_000;

/**
 * Verdict posting — creates or updates the idempotent VERDICT comment on a PR.
 *
 * The body includes the LLM output so users can see the skeptic's reasoning.
 * Output is capped to MAX_LLM_OUTPUT_CHARS to avoid GitHub 422 on oversized comments.
 */

import { patchComment, createComment } from "./gh-client.js";
import { extractSkepticGateMarkers } from "./verdict-utils.js";

export interface SkepticVerdictBinding {
  requestId?: string;
  headSha?: string;
}

export async function postVerdict(
  owner: string,
  repo: string,
  prNumber: number,
  verdict: string,
  existingCommentId: number | null,
  botAuthor: string,
  triggerSha?: string,
  /** Full LLM output — included in body so explanations are never lost. */
  llmOutput?: string,
  binding?: SkepticVerdictBinding,
): Promise<string> {
  const gateMarkers = extractSkepticGateMarkers(llmOutput ?? verdict);
  const body = [
    "<!-- skeptic-agent-verdict -->",
    binding?.requestId ? `<!-- skeptic-request-id-${binding.requestId} -->` : null,
    // Always include head-sha when provided, even if updating a comment posted without it.
    binding?.headSha ? `<!-- skeptic-head-sha-${binding.headSha} -->` : null,
    ...gateMarkers,
    "**🤖 Skeptic Agent Verdict (bd-qw6)**",
    "",
    verdict,
    "",
    // Include capped LLM output so FAIL/SKIPPED comments carry context.
    // When llmOutput === verdict (no trailing text), this is a no-op duplicate.
    llmOutput && llmOutput !== verdict
      ? `--- Full skeptic output ---\n${llmOutput.slice(0, MAX_LLM_OUTPUT_CHARS)}`
      : null,
    "",
    `_Posted by ${botAuthor} · ${new Date().toISOString()}_`,
    triggerSha ? `<!-- skeptic-gate-trigger-${triggerSha} -->` : "",
    triggerSha ? `<!-- skeptic-cron-trigger-${triggerSha} -->` : "",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  if (existingCommentId) {
    try {
      await patchComment(owner, repo, existingCommentId, body);
    } catch (err) {
      // bd-479: 404 (comment deleted) → fall back to CREATE.
      // 403 (cross-user edit blocked) → fall back to CREATE.
      //   When the existing verdict comment was posted by a different GitHub
      //   user (e.g. jleechan-af) and the current gh CLI is authenticated as
      //   a different account (e.g. jleechan2015), GitHub returns 403 because
      //   cross-user comment edits are not allowed. The previous behavior
      //   rethrew the 403, causing `ao skeptic verify` to fail with
      //   "Failed to post verdict" and silently drop the new verdict.
      //   Falling back to CREATE loses idempotent re-use but guarantees the
      //   verdict comment lands on the PR — which is what Skeptic Gate polls.
      // Rethrow all other errors (auth failure on the caller's account,
      // rate-limit, network, 422 oversized body) so upstream can handle
      // retries/failures and avoid creating duplicate verdict comments.
      if (!isGhNotFoundError(err) && !isGhForbiddenError(err)) {
        throw err;
      }
      await createComment(owner, repo, prNumber, body);
    }
  } else {
    await createComment(owner, repo, prNumber, body);
  }

  return body;
}

/**
 * Returns true when the error indicates a GitHub API 404 / "not found" response.
 * The `gh` CLI prints "HTTP 404: Not Found" or "status: 404" in stderr on such errors.
 */
function isGhNotFoundError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "";
  return /\b404\b/i.test(msg) || /not\s+found/i.test(msg);
}

/**
 * Returns true when the error indicates a GitHub API 403 / "forbidden" response.
 * The `gh` CLI prints "HTTP 403: Forbidden" or "status: 403" in stderr on such
 * errors. We treat 403 as a recoverable condition (cross-user comment edit)
 * and fall back to creating a new comment — see the catch block in postVerdict.
 */
function isGhForbiddenError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "";

  // First verify this is actually a 403/forbidden error
  let is403OrForbidden = false;
  if (err && typeof err === "object") {
    const status = (err as Record<string, unknown>).status ?? (err as Record<string, unknown>).statusCode;
    if (status === 403) {
      is403OrForbidden = true;
    }
  }
  if (!is403OrForbidden) {
    const is403Text = /\b403\b/i.test(msg);
    const isForbiddenText = /forbidden/i.test(msg);
    if (is403Text || isForbiddenText) {
      is403OrForbidden = true;
    }
  }
  if (!is403OrForbidden) {
    return false;
  }

  // Explicitly return false for messages indicating authentication, token, or rate-limit issues
  const isNonRecoverable =
    /rate\s*limit/i.test(msg) ||
    /abuse/i.test(msg) ||
    /authentication/i.test(msg) ||
    /invalid\s+token/i.test(msg) ||
    /resource\s+not\s+accessible/i.test(msg);

  if (isNonRecoverable) {
    return false;
  }

  // Return true only when the message indicates a cross-user/edit-authority conflict
  const isEditConflict =
    /cannot\s+edit|not\s+the\s+author|only\s+the\s+creator|edit\s+conflict|must\s+be\s+the\s+author|must\s+be\s+the\s+repository/i.test(msg);

  return isEditConflict;
}
