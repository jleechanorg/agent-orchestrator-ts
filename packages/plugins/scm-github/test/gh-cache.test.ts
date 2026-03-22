/**
 * gh-cache.test.ts — Unit tests for GhCache TTL cache + in-flight dedupe.
 *
 * Tests cover:
 * - tryGet hit/miss/expiry semantics
 * - withDedupe in-flight deduplication
 * - set() and prune() correctness
 * - metrics accuracy
 * - _resetGhCache() test isolation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GhCache, _resetGhCache, getGhCache } from "../src/gh-cache.js";

beforeEach(() => {
  _resetGhCache();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// tryGet — hit/miss/expiry
// ---------------------------------------------------------------------------

describe("GhCache.tryGet", () => {
  it("returns cached:false on empty cache", () => {
    const cache = new GhCache();
    expect(cache.tryGet(["pr", "view", "1"])).toEqual({ cached: false });
  });

  it("returns cached value within TTL", () => {
    const cache = new GhCache(5_000);
    cache.set(["pr", "view", "1"], undefined, "output");
    vi.advanceTimersByTime(4_999);
    const result = cache.tryGet(["pr", "view", "1"]);
    expect(result).toEqual({ cached: true, value: "output" });
  });

  it("returns cached:false after TTL expires", () => {
    const cache = new GhCache(5_000);
    cache.set(["pr", "view", "1"], undefined, "output");
    vi.advanceTimersByTime(5_001);
    expect(cache.tryGet(["pr", "view", "1"])).toEqual({ cached: false });
  });

  it("distinguishes keys by args", () => {
    const cache = new GhCache();
    cache.set(["pr", "view", "1"], undefined, "pr1");
    cache.set(["pr", "view", "2"], undefined, "pr2");
    expect(cache.tryGet(["pr", "view", "1"])).toEqual({ cached: true, value: "pr1" });
    expect(cache.tryGet(["pr", "view", "2"])).toEqual({ cached: true, value: "pr2" });
  });

  it("distinguishes keys by cwd", () => {
    const cache = new GhCache();
    cache.set(["pr", "view", "1"], "/repo-a", "a");
    cache.set(["pr", "view", "1"], "/repo-b", "b");
    expect(cache.tryGet(["pr", "view", "1"], "/repo-a")).toEqual({ cached: true, value: "a" });
    expect(cache.tryGet(["pr", "view", "1"], "/repo-b")).toEqual({ cached: true, value: "b" });
  });

  it("increments hits counter on cache hit", () => {
    const cache = new GhCache();
    cache.set(["pr", "view", "1"], undefined, "out");
    cache.tryGet(["pr", "view", "1"]);
    cache.tryGet(["pr", "view", "1"]);
    expect(cache.metrics.hits).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// withDedupe — in-flight deduplication
// ---------------------------------------------------------------------------

describe("GhCache.withDedupe", () => {
  it("calls fetchFn once for concurrent identical requests", async () => {
    const cache = new GhCache();
    const fetchFn = vi.fn().mockResolvedValue("result");

    const [r1, r2] = await Promise.all([
      cache.withDedupe(["pr", "view", "1"], undefined, fetchFn),
      cache.withDedupe(["pr", "view", "1"], undefined, fetchFn),
    ]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(r1).toBe("result");
    expect(r2).toBe("result");
  });

  it("calls fetchFn separately for different keys", async () => {
    const cache = new GhCache();
    const fetchFn = vi.fn().mockResolvedValue("result");

    await Promise.all([
      cache.withDedupe(["pr", "view", "1"], undefined, fetchFn),
      cache.withDedupe(["pr", "view", "2"], undefined, fetchFn),
    ]);

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("clears in-flight entry after resolution", async () => {
    const cache = new GhCache();
    const fetchFn = vi.fn().mockResolvedValue("result");
    await cache.withDedupe(["pr", "view", "1"], undefined, fetchFn);

    // A second call after resolution should invoke fetchFn again
    await cache.withDedupe(["pr", "view", "1"], undefined, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("clears in-flight entry after rejection", async () => {
    const cache = new GhCache();
    const fetchFn = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(cache.withDedupe(["pr", "view", "1"], undefined, fetchFn)).rejects.toThrow("fail");
    expect(cache.metrics.inFlight).toBe(0);
  });

  it("increments misses counter on first call", async () => {
    const cache = new GhCache();
    const fetchFn = vi.fn().mockResolvedValue("x");
    await cache.withDedupe(["pr", "view", "1"], undefined, fetchFn);
    expect(cache.metrics.misses).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// prune — expired entry removal
// ---------------------------------------------------------------------------

describe("GhCache.prune", () => {
  it("removes expired entries and retains fresh ones", () => {
    const cache = new GhCache(5_000);
    cache.set(["api", "pr1"], undefined, "old");
    vi.advanceTimersByTime(5_001);
    cache.set(["api", "pr2"], undefined, "fresh");

    cache.prune();
    expect(cache.metrics.activeEntries).toBe(1);
    expect(cache.tryGet(["api", "pr2"])).toEqual({ cached: true, value: "fresh" });
  });
});

// ---------------------------------------------------------------------------
// clear — full reset
// ---------------------------------------------------------------------------

describe("GhCache.clear", () => {
  it("empties cache and resets counters", () => {
    const cache = new GhCache();
    cache.set(["pr", "view", "1"], undefined, "v");
    cache.tryGet(["pr", "view", "1"]);
    cache.clear();
    expect(cache.metrics).toEqual({ hits: 0, misses: 0, activeEntries: 0, inFlight: 0, totalCalls: 0 });
  });
});

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

describe("GhCache.metrics", () => {
  it("totalCalls equals hits + misses", async () => {
    const cache = new GhCache();
    cache.set(["pr", "view", "1"], undefined, "v");
    cache.tryGet(["pr", "view", "1"]); // hit
    await cache.withDedupe(["pr", "view", "2"], undefined, async () => "x"); // miss
    const m = cache.metrics;
    expect(m.totalCalls).toBe(m.hits + m.misses);
  });
});

// ---------------------------------------------------------------------------
// getGhCache / _resetGhCache singleton
// ---------------------------------------------------------------------------

describe("getGhCache singleton", () => {
  it("returns same instance on repeated calls", () => {
    const a = getGhCache();
    const b = getGhCache();
    expect(a).toBe(b);
  });

  it("_resetGhCache creates a fresh instance", () => {
    const a = getGhCache();
    _resetGhCache();
    const b = getGhCache();
    expect(a).not.toBe(b);
  });
});
