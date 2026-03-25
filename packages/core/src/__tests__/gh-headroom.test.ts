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
  it("parses valid gh rate_limit JSON (core key, epoch reset)", () => {
    // GitHub API returns resources.core for REST and epoch seconds for reset
    const json = JSON.stringify({
      resources: {
        graphql: { remaining: 487, limit: 5000, reset: 1748779200 },
        core:    { remaining: 4999, limit: 5000, reset: 1748779200 },
      },
    });
    const result = parseGhRateLimitOutput(json);
    expect(result?.graphql?.remaining).toBe(487);
    expect(result?.core?.remaining).toBe(4999);
  });

  it("returns null for invalid JSON", () => {
    expect(parseGhRateLimitOutput("not json")).toBeNull();
    expect(parseGhRateLimitOutput("")).toBeNull();
  });

  it("returns null when resources key is missing", () => {
    expect(parseGhRateLimitOutput('{"foo": "bar"}')).toBeNull();
  });

  it("handles missing graphql/core keys gracefully", () => {
    const json = JSON.stringify({ resources: { search: { remaining: 10, limit: 30, reset: 1748779200 } } });
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
});

describe("getOperationHeadroom / shouldDeferOperation", () => {
  it("shouldDeferOperation is an alias for getOperationHeadroom", () => {
    expect(shouldDeferOperation).toBe(getOperationHeadroom);
  });

  it("returns a HeadroomStatus with required fields when gh CLI unavailable", async () => {
    // gh CLI may not be available in CI; invalidate cache so we get a fresh fetch
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
    const body = JSON.stringify({
      resources: {
        graphql: { remaining: 300, limit: 5000, reset: 1748779200 },
        core:    { remaining: 4500, limit: 5000, reset: 1748779200 },
      },
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
    resources: {
      graphql: { remaining: graphqlRemaining, limit: 5000, reset: 1748779200 },
      core:    { remaining: coreRemaining,    limit: 5000, reset: 1748779200 },
    },
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
});
