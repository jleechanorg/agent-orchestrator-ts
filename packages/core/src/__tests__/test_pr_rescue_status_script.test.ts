import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard: pr-rescue-status.sh is the mechanical preflight for 7-green
 * (see AGENTS.md). If deleted or gutted, agents lose a deterministic blocked-vs-done check.
 */
function repoRoot(): string {
  const candidate = join(import.meta.dirname, "..", "..", "..", "..");
  statSync(join(candidate, ".git"));
  return candidate;
}

describe("pr-rescue-status.sh harness script", () => {
  it("exists and contains required gate keywords", () => {
    const path = join(repoRoot(), "scripts", "pr-rescue-status.sh");
    const src = readFileSync(path, "utf-8");
    expect(src.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(src).toContain("reviewThreads");
    expect(src).toContain("resolveReviewThread");
    expect(src).toContain("MERGED");
    expect(src).toContain("APPROVED");
    expect(src).toContain("Skeptic Gate");
    expect(src).toContain("statusCheckRollup");
  });
});
