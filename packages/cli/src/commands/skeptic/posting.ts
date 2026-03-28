/**
 * Verdict posting — creates or updates the idempotent VERDICT comment on a PR.
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
): Promise<void> {
  const body = [
    "<!-- skeptic-agent-verdict -->",
    "**🤖 Skeptic Agent Verdict (bd-qw6)**",
    "",
    verdict,
    "",
    `_Posted by ${botAuthor} · ${new Date().toISOString()}_`,
    triggerSha ? `<!-- skeptic-gate-trigger-${triggerSha} -->` : "",
  ].join("\n");

  if (existingCommentId) {
    await patchComment(owner, repo, existingCommentId, body);
  } else {
    await createComment(owner, repo, prNumber, body);
  }
}
