/**
 * gh-cache.ts — Shared TTL cache + in-flight dedupe for GitHub API read calls.
 *
 * Goals:
 * - Reduce gh CLI invocations across concurrent sessions targeting the same PR
 * - Deduplicate in-flight requests so simultaneous callers share one network round-trip
 * - Provide instrumentation so callers can observe cache hit/miss rates
 *
 * Design:
 * - Cache entries expire after TTL_MS milliseconds (default: 15 000 = 15 s)
 * - Entries store the resolved result, not the pending promise, so callers that
 *   miss an in-flight slot still get a cached value if it was set before they started.
 * - In-flight entries hold the unresolved promise; new callers for the same key wait on it.
 */

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface InFlightEntry {
  promise: Promise<string>;
  startMs: number;
}

/**gh-cache instance keyed by full gh arg array + optional cwd. */
type ArgvKey = string; // serialized: "cwd\0" + args.join("\0")

export interface CacheMetrics {
  /** Total gh calls that were served from cache (fresh or in-flight shared). */
  hits: number;
  /** Total gh calls that went to gh CLI (cache miss or stale). */
  misses: number;
  /** Number of currently cached entries. */
  activeEntries: number;
  /** Number of in-flight requests currently pending. */
  inFlight: number;
  /** Total gh calls initiated since cache creation. */
  totalCalls: number;
}

/** Controls which gh commands are eligible for caching. */
export type CacheMode = "enabled" | "disabled" | "pr-view" | "pr-checks";

const DEFAULT_TTL_MS = 15_000; // 15 seconds — short enough for PR status freshness

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function makeKey(args: string[], cwd?: string): ArgvKey {
  return `${cwd ?? ""}\x00${args.join("\x00")}`;
}

// ---------------------------------------------------------------------------
// GhCache class
// ---------------------------------------------------------------------------

export class GhCache {
  private cache = new Map<ArgvKey, CacheEntry<string>>();
  private inFlight = new Map<ArgvKey, InFlightEntry>();
  private _hits = 0;
  private _misses = 0;

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  /**
   * Try to return a cached value for the given gh args.
   *
   * Returns `{ cached: true, value }` when a fresh (non-expired) entry exists.
   * Returns `{ cached: false }` when nothing is cached or the entry is stale —
   *   caller should invoke gh and then call `set()` to populate the cache.
   *
   * In-flight requests are handled separately by `withDedupe`.
   */
  tryGet(args: string[], cwd?: string): { cached: true; value: string } | { cached: false } {
    const key = makeKey(args, cwd);
    const entry = this.cache.get(key);
    if (entry === undefined) return { cached: false };
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return { cached: false };
    }
    this._hits++;
    return { cached: true, value: entry.value };
  }

  /**
   * Deduplicate concurrent requests for the same gh args.
   *
   * If another caller is already fetching this key, returns that pending promise
   * so both callers share one network round-trip.
   * If no request is in flight, stores and returns `fetchFn()` as the in-flight entry.
   *
   * The caller MUST call `set()` after the returned promise resolves to populate
   * the cache for future callers.
   */
  async withDedupe<T>(
    args: string[],
    cwd: string | undefined,
    fetchFn: () => Promise<string>,
  ): Promise<string> {
    const key = makeKey(args, cwd);
    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      this._hits++;
      return existing.promise;
    }

    const promise = fetchFn();
    this.inFlight.set(key, { promise, startMs: Date.now() });
    this._misses++;

    // Always clean up in-flight map when the request settles, regardless of outcome
    promise.finally(() => this.inFlight.delete(key)).catch(() => {});

    return promise;
  }

  /**
   * Store a gh result in the cache. Safe to call multiple times.
   */
  set(args: string[], cwd: string | undefined, value: string): void {
    const key = makeKey(args, cwd);
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /**
   * Evict all entries and reset counters.
   */
  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
    this._hits = 0;
    this._misses = 0;
  }

  /**
   * Remove only expired entries. Called periodically by consumers that need
   * to trim memory without clearing the whole cache.
   */
  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) this.cache.delete(key);
    }
  }

  get metrics(): CacheMetrics {
    return {
      hits: this._hits,
      misses: this._misses,
      activeEntries: this.cache.size,
      inFlight: this.inFlight.size,
      totalCalls: this._hits + this._misses,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton factory (per-plugin-process)
// ---------------------------------------------------------------------------

let _shared: GhCache | undefined;

export function getGhCache(): GhCache {
  if (_shared === undefined) {
    _shared = new GhCache();
  }
  return _shared;
}

/** Replace the singleton. Exists for testing. */
export function _resetGhCache(): void {
  _shared = undefined;
}
