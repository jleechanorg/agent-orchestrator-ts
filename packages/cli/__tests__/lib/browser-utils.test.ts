/**
 * Tests for shouldOpenBrowser — the single guard for browser auto-open.
 *
 * Regression guard for the recurring "localhost:3000 keeps reopening" complaint:
 * this function is the ONLY gate; if it returns true, the dashboard URL is
 * handed to macOS `open` via waitForPortAndOpen. Any future code path that
 * bypasses this function (e.g. a new call site in start.ts that opens the
 * browser directly) must also be tested — this test does NOT cover that.
 *
 * Precedence (per packages/cli/src/lib/browser-utils.ts):
 *   1. opts.openBrowser === false → false (CLI --no-open-browser wins)
 *   2. opts.open === false        → false (CLI --no-open wins)
 *   3. opts.openBrowser === true  → true  (CLI --open-browser wins)
 *   4. opts.open === true         → true  (CLI --open wins)
 *   5. AO_NO_OPEN_BROWSER ∈ {1,true} → false (env belt-and-suspenders)
 *   6. config.openBrowser === true → true (yaml opt-in)
 *   7. default                    → false (PR #676 — off by default)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { shouldOpenBrowser } from "../../src/lib/browser-utils.js";

describe("shouldOpenBrowser", () => {
  const originalEnv = process.env["AO_NO_OPEN_BROWSER"];

  beforeEach(() => {
    delete process.env["AO_NO_OPEN_BROWSER"];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["AO_NO_OPEN_BROWSER"];
    } else {
      process.env["AO_NO_OPEN_BROWSER"] = originalEnv;
    }
  });

  it("returns false by default (no opts, no config, no env)", () => {
    expect(shouldOpenBrowser(undefined, {})).toBe(false);
    expect(shouldOpenBrowser({}, {})).toBe(false);
  });

  it("CLI --no-open-browser (opts.openBrowser === false) wins over config.openBrowser === true", () => {
    // This is the exact regression scenario from the recurring
    // "localhost:3000 keeps reopening" complaint: even if the user has
    // opted in via yaml, an explicit --no-open-browser flag must suppress.
    expect(shouldOpenBrowser({ openBrowser: false }, { openBrowser: true })).toBe(false);
  });

  it("CLI --no-open (opts.open === false) wins over config.openBrowser === true", () => {
    // The exact flag pattern ao-health.sh uses to suppress browser when
    // restarting a project: `ao start $project --no-dashboard --no-open`.
    expect(shouldOpenBrowser({ open: false }, { openBrowser: true })).toBe(false);
  });

  it("CLI --no-open (opts.open === false) wins over AO_NO_OPEN_BROWSER=undefined and default config", () => {
    expect(shouldOpenBrowser({ open: false }, {})).toBe(false);
  });

  it("CLI --open-browser (opts.openBrowser === true) overrides config.openBrowser === false", () => {
    expect(shouldOpenBrowser({ openBrowser: true }, { openBrowser: false })).toBe(true);
  });

  it("CLI --open (opts.open === true) overrides config.openBrowser === false", () => {
    expect(shouldOpenBrowser({ open: true }, { openBrowser: false })).toBe(true);
  });

  it("AO_NO_OPEN_BROWSER=1 env suppresses browser even when config.openBrowser === true", () => {
    process.env["AO_NO_OPEN_BROWSER"] = "1";
    expect(shouldOpenBrowser(undefined, { openBrowser: true })).toBe(false);
  });

  it("AO_NO_OPEN_BROWSER=true env suppresses browser", () => {
    process.env["AO_NO_OPEN_BROWSER"] = "true";
    expect(shouldOpenBrowser(undefined, { openBrowser: true })).toBe(false);
  });

  it("AO_NO_OPEN_BROWSER is case-insensitive", () => {
    process.env["AO_NO_OPEN_BROWSER"] = "TRUE";
    expect(shouldOpenBrowser(undefined, { openBrowser: true })).toBe(false);
  });

  it("AO_NO_OPEN_BROWSER=0 does NOT suppress (only 1/true are recognized)", () => {
    process.env["AO_NO_OPEN_BROWSER"] = "0";
    expect(shouldOpenBrowser(undefined, { openBrowser: true })).toBe(true);
  });

  it("config.openBrowser === true opens browser when no CLI override", () => {
    expect(shouldOpenBrowser(undefined, { openBrowser: true })).toBe(true);
  });

  it("opts.open === false takes precedence over opts.openBrowser === true (defensive)", () => {
    // Defensive: if both flags are set inconsistently, --no-open should win
    // because suppress is safer than open.
    expect(shouldOpenBrowser({ openBrowser: true, open: false }, {})).toBe(false);
  });

  it("opts.openBrowser === false takes precedence over opts.open === true (defensive)", () => {
    expect(shouldOpenBrowser({ openBrowser: false, open: true }, {})).toBe(false);
  });

  it("CLI flag check order: openBrowser before open (matches source)", () => {
    // When ONLY opts.openBrowser === true is set, must return true.
    expect(shouldOpenBrowser({ openBrowser: true }, {})).toBe(true);
    // When ONLY opts.open === true is set, must return true.
    expect(shouldOpenBrowser({ open: true }, {})).toBe(true);
  });
});