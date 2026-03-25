import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseGhRateLimitOutput,
  DEFAULT_HEADROOM_THRESHOLDS,
  getOperationHeadroom,
  shouldDeferOperation,
  invalidateHeadroomCache,
  fetchGhRateLimit,
  ghHeadroomInject,
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
