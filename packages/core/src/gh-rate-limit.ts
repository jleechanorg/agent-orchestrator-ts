/**
 * Shared GitHub rate-limit detection and backoff utilities.
 *
 * Used by scm-github, poller-github-pr, and tracker-github plugins to avoid
 * triplicating the same retry/detection logic.
 */

/**
 * Error message substrings that indicate a GitHub rate-limit error.
 * Unified superset from all plugin implementations.
 *
 * Matching is case-insensitive; list distinct phrases only (no duplicate casing).
 *
 * The `"API error:reth"` entry is intentional: it matches a short fragment that
 * has appeared in `gh`/HTTP wrapper stderr when longer messages are truncated or
 * mangled. Do not drop without checking production logs across plugins.
 */
export const GH_RATE_LIMIT_ERROR_PATTERNS: readonly string[] = [
  "rate limit",
  "API rate limit",
  "GraphQL rate limit",
  "rate limit exceeded",
  "Too Many Requests",
  "API error:reth",
];

/**
 * Detect whether an error is a GitHub rate-limit error by scanning the
 * error message against known patterns (case-insensitive).
 * Also recursively checks `error.cause` for wrapped errors.
 */
export function isGhRateLimitError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  if (
    GH_RATE_LIMIT_ERROR_PATTERNS.some((pattern) =>
      msg.toLowerCase().includes(pattern.toLowerCase()),
    )
  ) {
    return true;
  }
  if (error instanceof Error && error.cause) {
    return isGhRateLimitError(error.cause);
  }
  return false;
}

/**
 * Promise-based sleep helper for exponential backoff.
 */
export async function ghSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
