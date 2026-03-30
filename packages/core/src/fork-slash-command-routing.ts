/**
 * Fork companion module: slash-command routing for Claude Code workers.
 *
 * Extracted into a companion file per fork isolation policy:
 * keeps upstream diffs minimal, isolates fork behavior.
 */

const COMMENT_FIX_KEYWORDS = [
  "review comment", "review comments", "comments on", "feedback on",
  "changes requested", "address feedback", "fix comments", "fix review",
];
const CI_MERGE_KEYWORDS = [
  "ci fail", "ci-fail", "ci failing", "ci error", "not mergeable",
  "merge conflict", "merge conflicts", "to green", "6-green", "skeptic", "verdict",
];

function messageContainsCommentFixIntentImpl(msg: string): boolean {
  const lower = msg.toLowerCase();
  // Single-word keywords use whole-word matching to avoid false positives like
  // "email address" triggering fix intent. Multi-word phrases use substring matching
  // because a word-boundary regex (\b) would fail when other words separate them.
  const hasCommentFix = COMMENT_FIX_KEYWORDS.some((kw) =>
    kw.includes(" ") ? lower.includes(kw.toLowerCase()) : wholeWordMatch(lower, kw.toLowerCase())
  );
  const hasCiMergeFix = CI_MERGE_KEYWORDS.some((kw) =>
    kw.includes(" ") ? lower.includes(kw.toLowerCase()) : wholeWordMatch(lower, kw.toLowerCase())
  );
  return hasCommentFix || hasCiMergeFix;
}

function wholeWordMatch(text: string, keyword: string): boolean {
  // Escape regex special chars, then match with word boundaries on both sides.
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

function transformToSlashCommandImpl(msg: string): string {
  // If message already starts with a slash command, preserve it.
  const existingSlash = msg.match(/^\/(copilot|polish)\s*/i);
  if (existingSlash) {
    const slash = `/${existingSlash[1].toLowerCase()}`;
    const stripped = msg.replace(/^\/(?:copilot|polish)\s*/i, "").trim();
    return `${slash}\n${stripped}`;
  }

  const lower = msg.toLowerCase();
  const hasCommentFix = COMMENT_FIX_KEYWORDS.some((kw) =>
    kw.includes(" ") ? lower.includes(kw.toLowerCase()) : wholeWordMatch(lower, kw.toLowerCase())
  );
  const hasCiMergeFix = CI_MERGE_KEYWORDS.some((kw) =>
    kw.includes(" ") ? lower.includes(kw.toLowerCase()) : wholeWordMatch(lower, kw.toLowerCase())
  );

  const slash = hasCommentFix ? "/copilot" : hasCiMergeFix ? "/polish" : "/copilot";
  return `${slash}\n${msg.trim()}`;
}

// Re-export for consumers that import from utils.ts (backward compat)
export { messageContainsCommentFixIntentImpl as messageContainsCommentFixIntent, transformToSlashCommandImpl as transformToSlashCommand };

/**
 * Apply slash-command routing: if the message has fix intent and the agent
 * is claude-code, transform it to the appropriate slash command.
 *
 * Non-Claude-Code agents receive the message unchanged.
 */
export function applySlashCommandRouting(
  message: string,
  agentName: string,
): string {
  if (agentName === "claude-code" && messageContainsCommentFixIntentImpl(message)) {
    return transformToSlashCommandImpl(message);
  }
  return message;
}
