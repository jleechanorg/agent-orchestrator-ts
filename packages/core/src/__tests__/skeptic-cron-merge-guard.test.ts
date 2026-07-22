/**
 * skeptic-cron-merge-guard.test.ts — Validates the auto_merge decision matrix
 * in .github/workflows/skeptic-cron-reusable.yml.
 *
 * The skeptic verdict on PR #551 requested explicit test coverage for the
 * SKEPTIC_CRON_AUTO_MERGE merge guard: omitted input, vars fallback, explicit
 * false, false-like values, and true/1 opt-in behavior.
 *
 * This test parses the YAML and simulates the GitHub Actions expression
 * `${{ inputs.auto_merge != '' && inputs.auto_merge || vars.SKEPTIC_CRON_AUTO_MERGE || '' }}`
 * and the bash merge guard that normalizes to lowercase and only allows
 * merge when value is "true" or "1".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "../../../..");
const WF_PATH = join(REPO_ROOT, ".github/workflows/skeptic-cron-reusable.yml");
const wfContent = readFileSync(WF_PATH, "utf-8");

// ---------------------------------------------------------------------------
// Simulate the GHA expression: inputs.auto_merge != '' && inputs.auto_merge || vars.SKEPTIC_CRON_AUTO_MERGE || ''
// In GHA, non-empty strings are truthy for && / ||
// ---------------------------------------------------------------------------
function resolveAutoMerge(
  inputAutoMerge: string,
  varsAutoMerge: string,
): string {
  // ${ inputs.auto_merge != '' && inputs.auto_merge || vars.SKEPTIC_CRON_AUTO_MERGE || '' }
  if (inputAutoMerge !== "") return inputAutoMerge;
  if (varsAutoMerge !== "") return varsAutoMerge;
  return "";
}

// ---------------------------------------------------------------------------
// Simulate the bash merge guard from the workflow:
//   _AUTO_MERGE_NORM="$(echo "${SKEPTIC_CRON_AUTO_MERGE}" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
//   SKIP_MERGE=true
//   if [ "$_AUTO_MERGE_NORM" = "true" ] || [ "$_AUTO_MERGE_NORM" = "1" ]; then SKIP_MERGE=false; fi
// ---------------------------------------------------------------------------
function shouldMerge(autoMergeValue: string): boolean {
  // sed edge-trim: only strips leading/trailing whitespace, preserves internal spaces
  // so "t r u e" stays "t r u e" and does NOT match "true"
  const norm = autoMergeValue.toLowerCase().replace(/^\s+|\s+$/g, "");
  return norm === "true" || norm === "1";
}

describe("skeptic-cron auto_merge decision matrix", () => {
  // Verify the workflow file has the expected default and expression
  it("workflow has empty default for auto_merge input", () => {
    expect(wfContent).toMatch(/default:\s*""/);
    expect(wfContent).toMatch(
      /inputs\.auto_merge != '' && inputs\.auto_merge \|\| vars\.SKEPTIC_CRON_AUTO_MERGE \|\| ''/,
    );
  });

  it("workflow has fail-closed merge guard (only true/1)", () => {
    expect(wfContent).toMatch(/_AUTO_MERGE_NORM/);
    expect(wfContent).toMatch(/SKIP_MERGE=true/);
    expect(wfContent).toMatch(
      /\$_AUTO_MERGE_NORM" = "true" \] \|\| \[ "\$_AUTO_MERGE_NORM" = "1" \]/,
    );
  });

  // GHA expression resolution tests
  describe("GHA expression resolution", () => {
    it("uses input when explicitly provided (even false)", () => {
      expect(resolveAutoMerge("false", "true")).toBe("false");
    });

    it("uses input when explicitly true", () => {
      expect(resolveAutoMerge("true", "false")).toBe("true");
    });

    it("falls back to vars when input is empty (omitted)", () => {
      expect(resolveAutoMerge("", "true")).toBe("true");
      expect(resolveAutoMerge("", "false")).toBe("false");
    });

    it("returns empty when both input and vars are empty/absent", () => {
      expect(resolveAutoMerge("", "")).toBe("");
    });
  });

  // Bash merge guard tests
  describe("fail-closed merge guard", () => {
    it("allows merge for explicit 'true'", () => {
      expect(shouldMerge("true")).toBe(true);
    });

    it("allows merge for explicit '1'", () => {
      expect(shouldMerge("1")).toBe(true);
    });

    it("allows merge for 'True' (case-insensitive)", () => {
      expect(shouldMerge("True")).toBe(true);
    });

    it("allows merge for 'TRUE' (case-insensitive)", () => {
      expect(shouldMerge("TRUE")).toBe(true);
    });

    it("skips merge for 'false'", () => {
      expect(shouldMerge("false")).toBe(false);
    });

    it("skips merge for 'False' (case-insensitive)", () => {
      expect(shouldMerge("False")).toBe(false);
    });

    it("skips merge for 'FALSE'", () => {
      expect(shouldMerge("FALSE")).toBe(false);
    });

    it("skips merge for '0'", () => {
      expect(shouldMerge("0")).toBe(false);
    });

    it("skips merge for 'off'", () => {
      expect(shouldMerge("off")).toBe(false);
    });

    it("skips merge for empty string", () => {
      expect(shouldMerge("")).toBe(false);
    });

    it("allows merge for whitespace-padded ' true '", () => {
      // sed edge-trim strips leading/trailing whitespace only
      expect(shouldMerge(" true ")).toBe(true);
    });

    it("skips merge for 't r u e' (internal spaces preserved by sed edge-trim)", () => {
      expect(shouldMerge("t r u e")).toBe(false);
    });

    it("skips merge for random string", () => {
      expect(shouldMerge("yes")).toBe(false);
    });
  });

  // End-to-end decision matrix
  describe("end-to-end: GHA expression + bash guard", () => {
    it("caller omits auto_merge, vars=true → merge allowed", () => {
      const resolved = resolveAutoMerge("", "true");
      expect(shouldMerge(resolved)).toBe(true);
    });

    it("caller omits auto_merge, vars=false → merge skipped", () => {
      const resolved = resolveAutoMerge("", "false");
      expect(shouldMerge(resolved)).toBe(false);
    });

    it("caller omits auto_merge, vars absent → merge skipped", () => {
      const resolved = resolveAutoMerge("", "");
      expect(shouldMerge(resolved)).toBe(false);
    });

    it("caller passes true, vars=false → merge allowed (input wins)", () => {
      const resolved = resolveAutoMerge("true", "false");
      expect(shouldMerge(resolved)).toBe(true);
    });

    it("caller passes false, vars=true → merge skipped (input wins)", () => {
      const resolved = resolveAutoMerge("false", "true");
      expect(shouldMerge(resolved)).toBe(false);
    });

    it("caller passes 'False' (non-standard), vars=true → merge skipped (input wins, fail-closed)", () => {
      const resolved = resolveAutoMerge("False", "true");
      expect(shouldMerge(resolved)).toBe(false);
    });
  });
});
