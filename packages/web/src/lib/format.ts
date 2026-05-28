/**
 * Pure formatting utilities safe for both server and client components.
 * No side effects, no external dependencies.
 */

import type { DashboardSession } from "./types.js";

/**
 * Humanize a git branch name into a readable title.
 * e.g., "feat/infer-project-id" → "Infer Project ID"
 *       "fix/broken-auth-flow"  → "Broken Auth Flow"
 *       "session/ao-52"         → "ao-52"
 */
export function humanizeBranch(branch: string): string {
  // Remove common prefixes
  const withoutPrefix = branch.replace(
    /^(?:feat|fix|chore|refactor|docs|test|ci|session|release|hotfix|feature|bugfix|build|wip|improvement)\//,
    "",
  );
  // Replace hyphens and underscores with spaces, then title-case each word
  return withoutPrefix
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Compute the best display title for a session card.
 *
 * Fallback chain (ordered by signal quality):
 *   1. User-set display name — only when `displayNameUserSet` is true.
 *                              An explicit rename always wins so the user's
 *                              chosen label isn't shadowed by tracker signals.
 *   2. PR title           — human-visible deliverable name
 *   3. Quality summary    — real agent-generated summary (not a fallback)
 *   4. Issue title        — human-written task description
 *   5. Auto-derived display name — captured at spawn time. Sits below
 *      PR/issue titles so a stale spawn-time value doesn't shadow the
 *      live deliverable name.
 *   6. Any summary        — even a fallback excerpt is better than nothing
 *   7. Humanized branch  — last resort with semantic content
 *   8. Status text        — absolute fallback
 */
export function getSessionTitle(session: DashboardSession): string {
  // 1. User-set rename — wins over everything when explicitly flagged.
  if (session.displayName && session.displayNameUserSet) {
    return session.displayName;
  }

  // 2. PR title
  if (session.pr?.title) return session.pr.title;

  // 3. Quality summary — skip fallback summaries (truncated spawn prompts)
  if (session.summary && !session.summaryIsFallback) {
    return session.summary;
  }

  // 4. Issue title — human-written task description
  if (session.issueTitle) return session.issueTitle;

  // 5. Auto-derived displayName — captured at spawn time. Sits below
  //    PR/issue but above userPrompt.
  if (session.displayName) return session.displayName;

  // 6. Any summary — even fallback excerpts beat branch names
  if (session.summary) return session.summary;

  // 7. Humanized branch
  if (session.branch) return humanizeBranch(session.branch);

  // 8. Status
  return session.status;
}
