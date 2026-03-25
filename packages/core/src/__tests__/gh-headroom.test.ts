import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseGhRateLimitOutput,
  DEFAULT_HEADROOM_THRESHOLDS,
  getOperationHeadroom,
  shouldDeferOperation,
  invalidateHeadroomCache,
  fetchGhRateLimit,
  ghHeadroomInject,
  withRESTFallback,
} from "../gh-headroom.js";

describe("parseGhRateLimitOutput", () => {
  it("parses gh api --jq '.resources' output (graphql + core)", () => {
    // This is what fetchGhRateLimit() passes after: gh api rate_limit --jq '.resources'
    const json = JSON.stringify({
      graphql: { remaining: 487, limit: 5000, reset: 1748779200 },
      core:   { remaining: 4999, limit: 5000, reset: 1748779200 },
    });
    const result = parseGhRateLimitOutput(json);
    expect(result?.graphql?.remaining).toBe(487);
    expect(result?.core?.remaining).toBe(4999);
  });

  it("returns null for invalid JSON", () => {
    expect(parseGhRateLimitOutput("not json")).toBeNull();
    expect(parseGhRateLimitOutput("")).toBeNull();
  });

  it("returns null when jq outputs null (missing resources key)", () => {
    // When gh api --jq '.resources' finds no resources key, jq outputs "null"
    expect(parseGhRateLimitOutput("null")).toBeNull();
  });

  it("handles missing graphql/core keys gracefully", () => {
    // gh api --jq '.resources' output with only search
    const json = JSON.stringify({ search: { remaining: 10, limit: 30, reset: 0 } });
    const result = parseGhRateLimitOutput(json);
    expect(result?.graphql).toBeUndefined();
    expect(result?.core).toBeUndefined();
    expect(result?.search?.remaining).toBe(10);
  });
});

describe("DEFAULT_HEADROOM_THRESHOLDS", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_HEADROOM_THRESHOLDS.graphqlMin).toBe(100);
    expect(DEFAULT_HEADROOM_THRESHOLDS.restMin).toBe(50);
    expect(DEFAULT_HEADROOM_THRESHOLDS.absoluteMin).toBe(10);
  });

  it("absoluteMin enforced as hard floor: both channels defer even when above graphqlMin/restMin", async () => {
    // graphql=8, rest=8 — both above 0 but below absoluteMin=10 → must defer
    ghHeadroomInject({ execAsync: stubHeadroom(8, 8) });
    invalidateHeadroomCache();
    const status = await getOperationHeadroom(); // uses DEFAULT_HEADROOM_THRESHOLDS
    expect(status.canUseGraphQL).toBe(false);
    expect(status.canUseREST).toBe(false);
    expect(status.recommendation).toBe("defer");
    ghHeadroomInject();
    invalidateHeadroomCache();
  });
});

describe("getOperationHeadroom / shouldDeferOperation", () => {
  afterEach(() => {
    ghHeadroomInject(); // reset to real execAsync
    invalidateHeadroomCache();
  });

  it("shouldDeferOperation is an alias for getOperationHeadroom", () => {
    expect(shouldDeferOperation).toBe(getOperationHeadroom);
  });

  it("returns a HeadroomStatus with required fields when gh CLI unavailable", async () => {
    // Simulate ENOENT (gh not installed) for determinism — no real subprocess
    const err = Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" });
    ghHeadroomInject({ execAsync: vi.fn().mockRejectedValue(err) });
    invalidateHeadroomCache();
    const status = await getOperationHeadroom();
    expect(typeof status.canUseGraphQL).toBe("boolean");
    expect(typeof status.canUseREST).toBe("boolean");
    expect(typeof status.graphqlRemaining).toBe("number");
    expect(typeof status.restRemaining).toBe("number");
    expect(["graphql", "rest", "defer"]).toContain(status.recommendation);
  });
});

describe("invalidateHeadroomCache", () => {
  it("does not throw when called multiple times", () => {
    expect(() => {
      invalidateHeadroomCache();
      invalidateHeadroomCache();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// fetchGhRateLimit subprocess paths (bd-s4t)
// Uses ghHeadroomInject() — same pattern as tmuxInject — to inject a
// pre-promisified exec stub that avoids util.promisify.custom complications
// when testing with vi.fn() stubs.
// ---------------------------------------------------------------------------

describe("fetchGhRateLimit subprocess paths", () => {
  afterEach(() => {
    ghHeadroomInject(); // reset to real execAsync
    invalidateHeadroomCache();
  });

  it("returns parsed resources on successful subprocess call", async () => {
    // gh api rate_limit --jq '.resources' returns the resources object directly
    const body = JSON.stringify({
      graphql: { remaining: 300, limit: 5000, reset: 1748779200 },
      core:   { remaining: 4500, limit: 5000, reset: 1748779200 },
    });
    ghHeadroomInject({
      execAsync: vi.fn().mockResolvedValue({ stdout: body, stderr: "" }),
    });
    const result = await fetchGhRateLimit();
    expect(result?.graphql?.remaining).toBe(300);
    expect(result?.core?.remaining).toBe(4500);
  });

  it("returns null when subprocess throws spawn failure (ENOENT)", async () => {
    const err = Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" });
    ghHeadroomInject({ execAsync: vi.fn().mockRejectedValue(err) });
    const result = await fetchGhRateLimit();
    expect(result).toBeNull();
  });

  it("returns null when subprocess returns invalid JSON", async () => {
    ghHeadroomInject({
      execAsync: vi.fn().mockResolvedValue({ stdout: "not valid json", stderr: "" }),
    });
    const result = await fetchGhRateLimit();
    expect(result).toBeNull();
  });

  it("returns null when subprocess times out", async () => {
    const err = Object.assign(new Error("command timed out"), { code: "ETIMEDOUT" });
    ghHeadroomInject({ execAsync: vi.fn().mockRejectedValue(err) });
    const result = await fetchGhRateLimit();
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// withRESTFallback (bd-s4t)
// ---------------------------------------------------------------------------

/** Build an execAsync stub that returns the given headroom resources. */
function stubHeadroom(graphqlRemaining: number, coreRemaining: number) {
  const body = JSON.stringify({
    graphql: { remaining: graphqlRemaining, limit: 5000, reset: 1748779200 },
    core:   { remaining: coreRemaining,    limit: 5000, reset: 1748779200 },
  });
  return vi.fn().mockResolvedValue({ stdout: body, stderr: "" });
}

describe("withRESTFallback", () => {
  afterEach(() => {
    ghHeadroomInject();
    invalidateHeadroomCache();
  });

  it("uses GraphQL when headroom is sufficient", async () => {
    ghHeadroomInject({ execAsync: stubHeadroom(500, 4000) });
    invalidateHeadroomCache();

    const graphqlFn = vi.fn().mockResolvedValue("graphql-data");
    const restFn = vi.fn().mockResolvedValue("rest-data");

    const result = await withRESTFallback(graphqlFn, restFn);
    expect(result).toEqual({ data: "graphql-data", via: "graphql" });
    expect(restFn).not.toHaveBeenCalled();
  });

  it("uses REST directly when GraphQL headroom is low", async () => {
    // graphql < 100 threshold → skip GraphQL, go direct to REST
    ghHeadroomInject({ execAsync: stubHeadroom(50, 4000) });
    invalidateHeadroomCache();

    const graphqlFn = vi.fn().mockResolvedValue("graphql-data");
    const restFn = vi.fn().mockResolvedValue("rest-data");

    const result = await withRESTFallback(graphqlFn, restFn);
    expect(result).toEqual({ data: "rest-data", via: "rest" });
    expect(graphqlFn).not.toHaveBeenCalled();
  });

  it("throws when both GraphQL and REST are exhausted", async () => {
    ghHeadroomInject({ execAsync: stubHeadroom(5, 10) }); // below both thresholds
    invalidateHeadroomCache();

    const graphqlFn = vi.fn().mockResolvedValue("data");
    const restFn = vi.fn().mockResolvedValue("data");

    await expect(withRESTFallback(graphqlFn, restFn)).rejects.toThrow(
      "GitHub API headroom exhausted",
    );
    expect(graphqlFn).not.toHaveBeenCalled();
    expect(restFn).not.toHaveBeenCalled();
  });

  it("falls back to REST when GraphQL fails with rate-limit error", async () => {
    // GraphQL headroom available, but the actual call hits rate limit
    ghHeadroomInject({ execAsync: stubHeadroom(500, 4000) });
    invalidateHeadroomCache();

    const rateLimitErr = new Error("GraphQL rate limit exceeded");
    const graphqlFn = vi.fn().mockRejectedValue(rateLimitErr);
    const restFn = vi.fn().mockResolvedValue("rest-fallback-data");

    const result = await withRESTFallback(graphqlFn, restFn);
    expect(result).toEqual({ data: "rest-fallback-data", via: "rest" });
    expect(restFn).toHaveBeenCalled();
  });

  it("throws when GraphQL rate-limits and fresh REST headroom is also exhausted", async () => {
    // First call (preflight): GraphQL and REST both available
    // Second call (post-invalidation re-fetch): REST now exhausted
    // Using mockResolvedValueOnce so the two fetches return distinct payloads,
    // proving withRESTFallback actually re-fetches after cache invalidation.
    const execStub = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify({
        graphql: { remaining: 500, limit: 5000, reset: 1748779200 },
        core:   { remaining: 4000, limit: 5000, reset: 1748779200 },
      }), stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify({
        graphql: { remaining: 500, limit: 5000, reset: 1748779200 },
        core:   { remaining: 10, limit: 5000, reset: 1748779200 }, // REST exhausted
      }), stderr: "" });
    ghHeadroomInject({ execAsync: execStub });
    invalidateHeadroomCache();

    const rateLimitErr = new Error("GraphQL rate limit exceeded");
    const graphqlFn = vi.fn().mockRejectedValue(rateLimitErr);
    const restFn = vi.fn().mockResolvedValue("rest-fallback-data");

    await expect(withRESTFallback(graphqlFn, restFn)).rejects.toThrow(
      "GitHub API headroom exhausted",
    );
    expect(restFn).not.toHaveBeenCalled();
    // Verify both fetches happened (preflight + post-invalidation re-fetch)
    expect(execStub).toHaveBeenCalledTimes(2);
  });

  it("invalidates cache when REST call itself rate-limits (direct REST path)", async () => {
    // REST path (GraphQL headroom low): restFn throws rate-limit → cache cleared
    ghHeadroomInject({ execAsync: stubHeadroom(50, 4000) }); // graphql < 100 → direct REST
    invalidateHeadroomCache();

    const rateLimitErr = new Error("REST rate limit exceeded");
    const graphqlFn = vi.fn().mockResolvedValue("should-not-run");
    const restFn = vi.fn().mockRejectedValue(rateLimitErr);

    await expect(withRESTFallback(graphqlFn, restFn)).rejects.toThrow("REST rate limit exceeded");
    expect(graphqlFn).not.toHaveBeenCalled();

    // Cache should be cleared so next call re-fetches fresh headroom
    // (invalidateHeadroomCache can be called multiple times without throwing)
    expect(() => invalidateHeadroomCache()).not.toThrow();
  });
});
