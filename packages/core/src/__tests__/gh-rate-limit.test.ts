import { describe, it, expect, vi, afterEach } from "vitest";
import { isGhRateLimitError, ghSleep } from "../gh-rate-limit.js";

describe("isGhRateLimitError", () => {
  it("returns true for common GitHub rate limit phrases", () => {
    expect(isGhRateLimitError(new Error("API rate limit exceeded"))).toBe(true);
    expect(isGhRateLimitError(new Error("GraphQL rate limit"))).toBe(true);
    expect(isGhRateLimitError(new Error("Too Many Requests"))).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isGhRateLimitError(new Error("RATE LIMIT EXCEEDED"))).toBe(true);
  });

  it("returns true for documented reth fragment substring", () => {
    expect(isGhRateLimitError(new Error("prefix API error:reth suffix"))).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isGhRateLimitError(new Error("authentication required"))).toBe(false);
    expect(isGhRateLimitError(new Error("not found"))).toBe(false);
  });

  it("walks error.cause", () => {
    const inner = new Error("API rate limit exceeded");
    const outer = new Error("wrapped", { cause: inner });
    expect(isGhRateLimitError(outer)).toBe(true);
  });

  it("handles non-Error values", () => {
    expect(isGhRateLimitError("rate limit")).toBe(true);
    expect(isGhRateLimitError(null)).toBe(false);
  });
});

describe("ghSleep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after the given delay", async () => {
    vi.useFakeTimers();
    const p = ghSleep(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBeUndefined();
  });
});
