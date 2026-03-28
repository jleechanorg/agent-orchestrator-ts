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
  const extra: string[] = [];
  if (triggerSha) {
    extra.push(`<!-- skeptic-gate-trigger-${triggerSha} -->`);
  }
  const body = [
    "<!-- skeptic-agent-verdict -->",
    extra.length > 0 ? extra.join("\n") : "",
    "**🤖 Skeptic Agent Verdict (bd-qw6)**",
    "",
    verdict,
    "",
    `_Posted by ${botAuthor} · ${new Date().toISOString()}_`,
  ]
    .filter((line) => line !== "") // skip blank lines from empty extra
    .join("\n");

  if (existingCommentId) {
    await patchComment(owner, repo, existingCommentId, body);
  } else {
    await createComment(owner, repo, prNumber, body);
  }
}
