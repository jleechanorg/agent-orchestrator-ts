/**
 * GitHub API headroom tracker.
 *
 * Mechanism (4): GraphQL-first headroom preflight with REST fallback when GraphQL is exhausted.
 *
 * Design:
 * - Tracks remaining GraphQL + REST API quota from gh CLI rate limit output
 * - Before each GraphQL operation, checks headroom
 * - If headroom is low, falls back to REST API equivalents (where available)
 * - REST and GraphQL share the same per-hour quota, so both are checked
 *
 * Used alongside gh-graphql-defer.ts (retry+defer) — this module handles
 * the "should I even try GraphQL" preflight decision.
 */

import { isGhRateLimitError } from "./gh-rate-limit.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeadroomStatus {
  /** true if headroom is sufficient for a GraphQL operation */
  canUseGraphQL: boolean;
  /** true if headroom is sufficient for REST (typically more forgiving) */
  canUseREST: boolean;
  /** Estimated remaining GraphQL operations before limit */
  graphqlRemaining: number;
  /** Estimated remaining REST operations before limit */
  restRemaining: number;
  /** Reset timestamp (ISO) for the current rate-limit window */
  resetAt: string | null;
  /** "graphql" | "rest" | "both" | "ok" */
  recommendation: "graphql" | "rest" | "defer";
}

export interface HeadroomThresholds {
  /** Min GraphQL points remaining to use GraphQL (default: 100) */
  graphqlMin: number;
  /** Min REST remaining to use REST (default: 50) */
  restMin: number;
  /** Min remaining before any API call (default: 10) */
  absoluteMin: number;
}

export const DEFAULT_HEADROOM_THRESHOLDS: HeadroomThresholds = {
  graphqlMin: 100,
  restMin: 50,
  absoluteMin: 10,
};

// ---------------------------------------------------------------------------
// Rate limit polling via gh CLI
// ---------------------------------------------------------------------------

interface GHRateLimitResources {
  graphql?: { remaining: number; limit: number; reset: string };
  rest?: { remaining: number; limit: number; reset: string };
  search?: { remaining: number; limit: number; reset: string };
}

/** Parse `gh api rate_limit` JSON output. Returns null on parse failure. */
export function parseGhRateLimitOutput(stdout: string): GHRateLimitResources | null {
  try {
    const parsed = JSON.parse(stdout);
    return parsed.resources ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch current rate limit status via `gh api rate_limit`.
 * Returns null on failure (caller should fall back to REST).
 */
export async function fetchGhRateLimit(): Promise<GHRateLimitResources | null> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["api", "rate_limit", "--jq", ".resources"],
      { timeout: 10_000 },
    );
    return parseGhRateLimitOutput(stdout);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// In-process headroom tracker (singleton per process lifetime)
// ---------------------------------------------------------------------------

let _cachedHeadroom: HeadroomStatus | null = null;
let _headroomFetchedAt: number = 0;
const HEADROOM_CACHE_TTL_MS = 60_000; // 1 minute — gh rate limit updates every hour, no need to check more

/**
 * Get cached headroom status, refreshing if stale.
 */
export async function getHeadroomStatus(
  thresholds: Partial<HeadroomThresholds> = {},
): Promise<HeadroomStatus> {
  const opts: HeadroomThresholds = { ...DEFAULT_HEADROOM_THRESHOLDS, ...thresholds };
  const now = Date.now();

  if (_cachedHeadroom && now - _headroomFetchedAt < HEADROOM_CACHE_TTL_MS) {
    return applyThresholds(_cachedHeadroom, opts);
  }

  const resources = await fetchGhRateLimit();
  const resetAt = resources?.graphql?.reset
    ?? resources?.rest?.reset
    ?? null;

  _cachedHeadroom = {
    graphqlRemaining: resources?.graphql?.remaining ?? 1000,
    restRemaining: resources?.rest?.remaining ?? 5000,
    resetAt,
    canUseGraphQL: (resources?.graphql?.remaining ?? 1000) >= opts.graphqlMin,
    canUseREST: (resources?.rest?.remaining ?? 5000) >= opts.restMin,
    recommendation: (resources?.graphql?.remaining ?? 1000) >= opts.graphqlMin
      ? "graphql"
      : (resources?.rest?.remaining ?? 5000) >= opts.restMin
      ? "rest"
      : "defer",
  };
  _headroomFetchedAt = now;

  return applyThresholds(_cachedHeadroom, opts);
}

function applyThresholds(status: HeadroomStatus, opts: HeadroomThresholds): HeadroomStatus {
  const canUseGraphQL = status.graphqlRemaining >= opts.graphqlMin;
  const canUseREST    = status.restRemaining >= opts.restMin;
  const recommendation: HeadroomStatus["recommendation"] =
    status.graphqlRemaining >= opts.graphqlMin
      ? "graphql"
      : status.restRemaining >= opts.restMin
      ? "rest"
      : "defer";
  return { ...status, canUseGraphQL, canUseREST, recommendation };
}

/** Invalidate the cached headroom (call after any rate-limit error). */
export function invalidateHeadroomCache(): void {
  _cachedHeadroom = null;
  _headroomFetchedAt = 0;
}

// ---------------------------------------------------------------------------
// Wrapper utilities
// ---------------------------------------------------------------------------

/**
 * Execute a GraphQL operation with REST-first fallback.
 *
 * @param graphqlFn  Async function that executes the GraphQL call
 * @param restFn     Async function that executes the REST fallback
 * @param thresholds  Headroom thresholds
 * @returns Result from whichever path succeeded, or throws if both fail
 */
export async function withRESTFallback<T>(
  graphqlFn: () => Promise<T>,
  restFn: () => Promise<T>,
  thresholds: Partial<HeadroomThresholds> = {},
): Promise<{ data: T; via: "graphql" | "rest" }> {
  const status = await getHeadroomStatus(thresholds);

  if (status.canUseGraphQL) {
    try {
      const data = await graphqlFn();
      return { data, via: "graphql" };
    } catch (err) {
      if (isGhRateLimitError(err)) {
        invalidateHeadroomCache();
        // Fall through to REST
      } else {
        throw err; // Non-rate-limit errors should propagate
      }
    }
  }

  // REST fallback
  if (!status.canUseREST) {
    throw new Error(
      `GitHub API headroom exhausted (gql:${status.graphqlRemaining} rest:${status.restRemaining}). Cannot proceed.`,
    );
  }

  const data = await restFn();
  return { data, via: "rest" };
}

/**
 * Determine whether to defer a GH operation based on current headroom.
 * Returns "defer" if both GraphQL and REST are low.
 */
export async function shouldDeferOperation(
  thresholds: Partial<HeadroomThresholds> = {},
): Promise<HeadroomStatus> {
  return getHeadroomStatus(thresholds);
}
