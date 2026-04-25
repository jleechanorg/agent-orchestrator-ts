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
      // bd-479: if patch fails (comment was deleted or 404), fall back to create.
      // This keeps the idempotent-retry pattern working even with stale comment IDs.
      await createComment(owner, repo, prNumber, body);
    }
  } else {
    await createComment(owner, repo, prNumber, body);
  }
}
