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
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";

/** Type for the promisified exec used internally. */
type ExecAsync = (
  cmd: string,
  args: string[],
  opts: { encoding: string; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

// Mutable ref — tests can replace via ghHeadroomInject()
let _execAsync: ExecAsync = promisify(_execFile) as unknown as ExecAsync;

/**
 * Inject test doubles (same pattern as tmuxInject in tmux.ts).
 * Accepts a pre-promisified exec function so tests avoid util.promisify.custom
 * complications with vi.fn() stubs.
 * @internal — for unit testing only
 */
export function ghHeadroomInject(doubles: { execAsync?: ExecAsync } = {}) {
  if (doubles.execAsync) _execAsync = doubles.execAsync;
  else _execAsync = promisify(_execFile) as unknown as ExecAsync; // reset
}

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
  /** "graphql" | "rest" | "defer" */
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
  graphql?: { remaining: number; limit: number; reset: number };
  core?: { remaining: number; limit: number; reset: number };
  search?: { remaining: number; limit: number; reset: number };
}

/** Parse `gh api rate_limit --jq '.resources'` output. Returns null on parse failure. */
export function parseGhRateLimitOutput(stdout: string): GHRateLimitResources | null {
  try {
    const parsed = JSON.parse(stdout);
    // gh api rate_limit returns a top-level "resources" object.
    // Caller passes --jq '.resources' so we receive the resources object directly.
    // Support both that (jq-extracted) and the full-response shape.
    const resources = parsed.resources ?? parsed;
    // Defensive: require at least one known resource key to avoid accepting
    // arbitrary JSON that coincidentally has no 'resources' key.
    if (
      typeof resources !== "object" ||
      resources === null ||
      !("graphql" in resources || "core" in resources || "search" in resources)
    ) {
      return null;
    }
    return resources;
  } catch {
    return null;
  }
}

/**
 * Fetch current rate limit status via `gh api rate_limit`.
 * Returns null on failure (caller should fall back to REST).
 */
export async function fetchGhRateLimit(): Promise<GHRateLimitResources | null> {
  try {
    const { stdout } = await _execAsync("gh", ["api", "rate_limit", "--jq", ".resources"], {
      encoding: "utf-8",
      timeout: 10_000,
    });
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
  // Coerce reset to number — GitHub API returns epoch seconds as a number, but
  // defensive coding guards against string or unexpected types.
  const rawReset = resources?.graphql?.reset ?? resources?.core?.reset ?? null;
  const resetEpoch = rawReset !== null ? Number(rawReset) : null;
  const resetAt =
    resetEpoch !== null && !Number.isNaN(resetEpoch)
      ? new Date(resetEpoch * 1000).toISOString()
      : null;

  // Defensive: if we have no snapshot or no actionable buckets (graphql/core),
  // the safe default is "defer" — never guess graphql when headroom is unknown.
  const hasGraphql = resources != null && "graphql" in resources;
  const hasCore    = resources != null && "core"    in resources;

  if (!hasGraphql && !hasCore) {
    _cachedHeadroom = {
      graphqlRemaining: 0,
      restRemaining: 0,
      resetAt,
      canUseGraphQL: false,
      canUseREST: false,
      recommendation: "defer",
    };
  } else {
    _cachedHeadroom = {
      graphqlRemaining: resources?.graphql?.remaining ?? 0,
      restRemaining: resources?.core?.remaining ?? 0,
      resetAt,
      canUseGraphQL: (resources?.graphql?.remaining ?? 0) >= opts.graphqlMin,
      canUseREST: (resources?.core?.remaining ?? 0) >= opts.restMin,
      recommendation: (resources?.graphql?.remaining ?? 0) >= opts.graphqlMin
        ? "graphql"
        : (resources?.core?.remaining ?? 0) >= opts.restMin
        ? "rest"
        : "defer",
    };
  }
  _headroomFetchedAt = now;

  return applyThresholds(_cachedHeadroom, opts);
}

function applyThresholds(status: HeadroomStatus, opts: HeadroomThresholds): HeadroomStatus {
  // Enforce hard floor: if either remaining count is below absoluteMin,
  // treat both channels as unusable regardless of graphqlMin/restMin.
  const belowAbsoluteMin =
    status.graphqlRemaining < opts.absoluteMin ||
    status.restRemaining < opts.absoluteMin;

  if (belowAbsoluteMin) {
    return { ...status, canUseGraphQL: false, canUseREST: false, recommendation: "defer" };
  }

  const canUseGraphQL = status.graphqlRemaining >= opts.graphqlMin;
  const canUseREST    = status.restRemaining >= opts.restMin;
  const recommendation: HeadroomStatus["recommendation"] =
    canUseGraphQL ? "graphql" : canUseREST ? "rest" : "defer";
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
        // Fall through to REST — re-fetch status so the REST check uses fresh headroom
        const freshStatus = await getHeadroomStatus(thresholds);
        if (!freshStatus.canUseREST) {
          throw new Error(
            `GitHub API headroom exhausted (gql:${freshStatus.graphqlRemaining} rest:${freshStatus.restRemaining}). Cannot proceed.`,
            { cause: err },
          );
        }
        try {
          const data = await restFn();
          return { data, via: "rest" };
        } catch (restErr) {
          if (isGhRateLimitError(restErr)) invalidateHeadroomCache();
          throw restErr;
        }
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

  try {
    const data = await restFn();
    return { data, via: "rest" };
  } catch (restErr) {
    if (isGhRateLimitError(restErr)) invalidateHeadroomCache();
    throw restErr;
  }
}

/**
 * Return the current GitHub API headroom snapshot.
 * Use `recommendation === "defer"` when both GraphQL and REST are low.
 */
export async function getOperationHeadroom(
  thresholds: Partial<HeadroomThresholds> = {},
): Promise<HeadroomStatus> {
  return getHeadroomStatus(thresholds);
}

/**
 * @deprecated Use `getOperationHeadroom` instead.
 */
export const shouldDeferOperation = getOperationHeadroom;
