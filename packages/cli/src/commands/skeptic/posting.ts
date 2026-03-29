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
): Promise<void> {
  const body = [
    "<!-- skeptic-agent-verdict -->",
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
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  if (existingCommentId) {
    await patchComment(owner, repo, existingCommentId, body);
  } else {
    await createComment(owner, repo, prNumber, body);
  }
}
