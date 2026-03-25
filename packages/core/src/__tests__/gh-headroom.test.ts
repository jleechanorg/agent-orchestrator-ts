import { describe, it, expect } from "vitest";
import {
  parseGhRateLimitOutput,
  DEFAULT_HEADROOM_THRESHOLDS,
} from "../gh-headroom.js";

describe("parseGhRateLimitOutput", () => {
  it("parses valid gh rate_limit JSON", () => {
    const json = JSON.stringify({
      resources: {
        graphql: { remaining: 487, limit: 5000, reset: "2025-06-01T13:00:00Z" },
        rest:    { remaining: 4999, limit: 5000, reset: "2025-06-01T13:00:00Z" },
      },
    });
    const result = parseGhRateLimitOutput(json);
    expect(result?.graphql?.remaining).toBe(487);
    expect(result?.rest?.remaining).toBe(4999);
  });

  it("returns null for invalid JSON", () => {
    expect(parseGhRateLimitOutput("not json")).toBeNull();
    expect(parseGhRateLimitOutput("")).toBeNull();
  });

  it("returns null when resources key is missing", () => {
    expect(parseGhRateLimitOutput('{"foo": "bar"}')).toBeNull();
  });

  it("handles missing graphql/rest keys gracefully", () => {
    const json = JSON.stringify({ resources: { search: { remaining: 10, limit: 30, reset: "" } } });
    const result = parseGhRateLimitOutput(json);
    expect(result?.graphql).toBeUndefined();
    expect(result?.rest).toBeUndefined();
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
