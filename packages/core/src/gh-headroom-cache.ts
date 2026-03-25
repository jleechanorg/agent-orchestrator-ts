/**
 * gh-headroom cache and threshold helpers.
 *
 * Extracted from gh-headroom.ts to keep the core orchestration file under 300 LOC
 * (per repo coding guidelines). This module owns all mutable cache state and
 * threshold-application logic; gh-headroom.ts calls through to it.
 */

import type { HeadroomStatus, HeadroomThresholds } from "./gh-headroom.js";

/** Cached headroom snapshot — raw counts only; threshold-derived fields are
 * recomputed on every use so callers always get a consistent view. */
export interface CachedHeadroom {
  graphqlRemaining: number;
  restRemaining: number;
  resetAt: string | null;
  /** Tracks which thresholds were applied so cache hits can skip recomputation. */
  _cachedThresholds: HeadroomThresholds;
}

let _cachedHeadroom: CachedHeadroom | null = null;
let _headroomFetchedAt: number = 0;
export const HEADROOM_CACHE_TTL_MS = 60_000; // 1 minute — gh rate limit updates every hour

// Mutable cache state — wrapped in an object so callers can mutate through
// live binding without triggering JS getter/setter restrictions on module exports.
export const _cacheState = {
  get headroom(): CachedHeadroom | null {
    return _cachedHeadroom;
  },
  set headroom(v: CachedHeadroom | null) {
    _cachedHeadroom = v;
  },
  get fetchedAt(): number {
    return _headroomFetchedAt;
  },
  set fetchedAt(v: number) {
    _headroomFetchedAt = v;
  },
};

/** Invalidate the cached headroom (call after any rate-limit error). */
export function invalidateHeadroomCache(): void {
  _cachedHeadroom = null;
  _headroomFetchedAt = 0;
}

/**
 * Apply headroom thresholds to a cached snapshot.
 *
 * Per-channel absoluteMin floor: each channel is blocked independently when below
 * the hard floor. A healthy REST bucket is still usable when GraphQL is depleted,
 * and vice versa — only the depleted channel defers.
 */
export function applyThresholds(
  cache: CachedHeadroom,
  opts: HeadroomThresholds,
): HeadroomStatus {
  const belowGraphqlAbs = cache.graphqlRemaining < opts.absoluteMin;
  const belowRestAbs    = cache.restRemaining    < opts.absoluteMin;

  const canUseGraphQL =
    !belowGraphqlAbs && cache.graphqlRemaining >= opts.graphqlMin;
  const canUseREST =
    !belowRestAbs && cache.restRemaining >= opts.restMin;

  // Only defer when NEITHER channel has usable headroom.
  if (!canUseGraphQL && !canUseREST) {
    return {
      graphqlRemaining: cache.graphqlRemaining,
      restRemaining: cache.restRemaining,
      resetAt: cache.resetAt,
      canUseGraphQL: false,
      canUseREST: false,
      recommendation: "defer",
    };
  }

  const recommendation: HeadroomStatus["recommendation"] =
    canUseGraphQL ? "graphql" : "rest";
  return {
    graphqlRemaining: cache.graphqlRemaining,
    restRemaining: cache.restRemaining,
    resetAt: cache.resetAt,
    canUseGraphQL,
    canUseREST,
    recommendation,
  };
}

