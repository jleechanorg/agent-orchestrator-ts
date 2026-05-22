/**
 * Companion module for upstream commit 9d9eab409 (#1981).
 *
 * Extracts the session header simplification logic — specifically the
 * `deriveDisplayName` function and its markdown-heading-strip behaviour —
 * into a fork-isolated file so that session-manager.ts (a hot fork surface
 * with 1379+ lines of divergence) receives only a one-line import + call.
 *
 * Upstream reference: packages/core/src/session-manager.ts:248–279 (post-9d9eab409)
 */

const DISPLAY_NAME_MAX_LENGTH = 80;

const MARKDOWN_HEADING_RE = /^#{1,6}\s+/;

function pickLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? "";
}

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= DISPLAY_NAME_MAX_LENGTH) return collapsed;
  return `${codePoints
    .slice(0, DISPLAY_NAME_MAX_LENGTH - 1)
    .join("")
    .trimEnd()}…`;
}

export interface DeriveDisplayNameInput {
  issueTitle?: string;
  prompt?: string;
}

export function deriveDisplayName(input: DeriveDisplayNameInput): string | undefined {
  if (input.issueTitle && input.issueTitle.trim()) {
    return truncate(input.issueTitle);
  }

  if (input.prompt && input.prompt.trim()) {
    const line = pickLine(input.prompt).replace(MARKDOWN_HEADING_RE, "");
    if (line) return truncate(line);
  }

  return undefined;
}

export { DISPLAY_NAME_MAX_LENGTH, MARKDOWN_HEADING_RE };
