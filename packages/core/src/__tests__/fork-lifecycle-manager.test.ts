import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseRateLimitReset } from "../fork-lifecycle-manager.js";

describe("parseRateLimitReset", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when output contains no rate-limit message", () => {
    expect(parseRateLimitReset("All good, no errors here")).toBeNull();
    expect(parseRateLimitReset("")).toBeNull();
  });

  it("returns null when output says 'usage limit reached' but no reset time or duration", () => {
    expect(parseRateLimitReset("usage limit reached")).toBeNull();
  });

  it("parses an explicit 'limit will reset at YYYY-MM-DD HH:MM' timestamp in the future", () => {
    vi.setSystemTime(new Date("2026-06-01T08:00:00"));
    const output = "usage limit reached\nlimit will reset at 2026-06-01 10:00";
    const result = parseRateLimitReset(output);
    expect(result).not.toBeNull();
    expect(result?.getFullYear()).toBe(2026);
    expect(result?.getMonth()).toBe(5); // June = month index 5
    expect(result?.getDate()).toBe(1);
    expect(result?.getHours()).toBe(10);
    expect(result?.getMinutes()).toBe(0);
  });

  it("ignores explicit reset timestamps already in the past", () => {
    vi.setSystemTime(new Date("2026-06-01T12:00:00"));
    const output = "usage limit reached\nlimit will reset at 2026-06-01 10:00";
    expect(parseRateLimitReset(output)).toBeNull();
  });

  it("falls back to duration parsing when explicit reset is in the past", () => {
    vi.setSystemTime(new Date("2026-06-01T12:00:00"));
    const output =
      "usage limit reached\nlimit will reset at 2026-06-01 10:00\nusage limit reached for 2 hours";
    const result = parseRateLimitReset(output);
    expect(result).not.toBeNull();
    // Duration-based: now + 2h
    const expected = new Date("2026-06-01T14:00:00").getTime();
    expect(result?.getTime()).toBeCloseTo(expected, -3); // within ~1 second
  });

  it("returns the latest future explicit reset when multiple lines exist (mixed stale + fresh)", () => {
    // Simulate two banners: one stale (already past), one fresh
    vi.setSystemTime(new Date("2026-06-01T11:00:00"));
    const output = [
      "usage limit reached",
      "limit will reset at 2026-06-01 10:00", // stale — in the past
      "limit will reset at 2026-06-01 13:00", // fresh — in the future
      "limit will reset at 2026-06-01 12:30", // fresh but earlier
    ].join("\n");
    const result = parseRateLimitReset(output);
    expect(result).not.toBeNull();
    expect(result?.getHours()).toBe(13); // latest future one
    expect(result?.getMinutes()).toBe(0);
  });

  it("falls back to duration when all explicit resets are stale and duration is present", () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00"));
    const output = [
      "usage limit reached",
      "limit will reset at 2026-06-01 10:00", // stale
      "usage limit reached for 30 minutes",
    ].join("\n");
    const result = parseRateLimitReset(output);
    expect(result).not.toBeNull();
    const expected = Date.now() + 30 * 60_000;
    expect(result?.getTime()).toBeCloseTo(expected, -3);
  });

  it("parses duration in hours", () => {
    vi.setSystemTime(new Date("2026-06-01T08:00:00"));
    const result = parseRateLimitReset("usage limit reached for 3 hours");
    expect(result).not.toBeNull();
    const expected = Date.now() + 3 * 3_600_000;
    expect(result?.getTime()).toBeCloseTo(expected, -3);
  });

  it("parses duration in minutes", () => {
    vi.setSystemTime(new Date("2026-06-01T08:00:00"));
    const result = parseRateLimitReset("usage limit reached for 45 min");
    expect(result).not.toBeNull();
    const expected = Date.now() + 45 * 60_000;
    expect(result?.getTime()).toBeCloseTo(expected, -3);
  });
});
