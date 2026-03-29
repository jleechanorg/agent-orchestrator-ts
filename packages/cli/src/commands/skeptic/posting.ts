/**
 * Verdict posting — creates or updates the idempotent VERDICT comment on a PR.
 *
 * The body always includes the full LLM output (llmOutput) so users can see the
 * skeptic's reasoning even when the verdict line is the only content.
 * The verdict line is shown prominently at the top; the full output follows.
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
    // Always include the full LLM output so FAIL/SKIPPED comments carry context.
    // When llmOutput === verdict (no trailing text), this is a no-op duplicate.
    llmOutput && llmOutput !== verdict ? `--- Full skeptic output ---\n${llmOutput}` : null,
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
