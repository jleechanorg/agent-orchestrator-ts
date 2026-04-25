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
): Promise<void> {
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
      // bd-479: only fallback for deleted/stale comment IDs (404).
      // Rethrow all other errors (auth, rate-limit, network, 422) so upstream
      // can handle retries/failures and avoid creating duplicate verdict comments.
      if (!isGhNotFoundError(err)) {
        throw err;
      }
      await createComment(owner, repo, prNumber, body);
    }
  } else {
    await createComment(owner, repo, prNumber, body);
  }
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
