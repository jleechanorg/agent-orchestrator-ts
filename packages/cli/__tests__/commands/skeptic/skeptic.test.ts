/**
 * Unit tests for skeptic.ts verdict parsing — SKIPPED verdict path.
 * CR: "Add failing-first tests that cover the new SKIPPED verdict path"
 * (Line 60, Lines 130-132 — PASS/FAIL/SKIPPED are all first-class verdicts now)
 *
 * Tests import from verdict-utils.ts so they test the actual production
 * implementation, not local copies.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { VERDICT_LINE_RE, getVerdictColor } from "../../../src/commands/skeptic/verdict-utils.js";

describe("VERDICT_LINE_RE — SKIPPED path", () => {
  it("matches VERDICT: SKIPPED (uppercase)", () => {
    const m = "VERDICT: SKIPPED".match(VERDICT_LINE_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("SKIPPED");
  });

  it("matches verdict: skipped (case-insensitive)", () => {
    const m = "verdict: skipped".match(VERDICT_LINE_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("skipped");
  });

  it("matches SKIPPED with trailing context (newline)", () => {
    const m = "VERDICT: SKIPPED\n\n## Details".match(VERDICT_LINE_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("SKIPPED");
  });

  it("matches SKIPPED with trailing whitespace", () => {
    const m = "VERDICT: SKIPPED  ".match(VERDICT_LINE_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("SKIPPED");
  });

  it("does NOT match SKIP (word boundary required)", () => {
    const m = "VERDICT: SKIP".match(VERDICT_LINE_RE);
    expect(m).toBeNull();
  });

  it("still matches PASS", () => {
    const m = "VERDICT: PASS".match(VERDICT_LINE_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("PASS");
  });

  it("still matches FAIL", () => {
    const m = "VERDICT: FAIL".match(VERDICT_LINE_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("FAIL");
  });
});

describe("getVerdictColor — SKIPPED maps to yellow", () => {
  it("SKIPPED maps to yellow", () => {
    expect(getVerdictColor("SKIPPED")).toBe("yellow");
  });

  it("PASS maps to green", () => {
    expect(getVerdictColor("PASS")).toBe("green");
  });

  it("FAIL maps to red", () => {
    expect(getVerdictColor("FAIL")).toBe("red");
  });

  it("unknown verdict type maps to red (fail-closed)", () => {
    expect(getVerdictColor("UNKNOWN")).toBe("red");
  });
});
