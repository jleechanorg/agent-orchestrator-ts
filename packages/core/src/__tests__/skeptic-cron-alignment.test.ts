/**
 * skeptic-cron-alignment.test.ts
 * 
 * TDD Red-phase evidence:
 * - Red Evidence Log: https://gist.githubusercontent.com/jleechan2015/de187ca5ebede188300a0248b42f5cf0/raw/red.log
 * - Green Evidence Cast: https://gist.githubusercontent.com/jleechan2015/de187ca5ebede188300a0248b42f5cf0/raw/green.cast
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "../../../..");
const REUSABLE_WF_PATH = join(REPO_ROOT, ".github/workflows/skeptic-cron-reusable.yml");
const MAIN_WF_PATH = join(REPO_ROOT, ".github/workflows/skeptic-cron.yml");

const reusableWf = readFileSync(REUSABLE_WF_PATH, "utf-8");
const mainWf = readFileSync(MAIN_WF_PATH, "utf-8");

describe("skeptic-cron workflow alignment", () => {
  it("main workflow should use the same fail-closed merge guard as reusable workflow", () => {
    const normPattern = /_AUTO_MERGE_NORM=.*\btr\b.*\bsed\b/;
    const reusableMatch = reusableWf.match(normPattern);
    expect(reusableMatch, "reusable workflow must contain _AUTO_MERGE_NORM assignment with tr+sed pipeline").not.toBeNull();
    const reusableLine = reusableMatch![0].trimEnd();

    const mainMatch = mainWf.match(normPattern);
    expect(mainMatch, "main workflow must contain _AUTO_MERGE_NORM assignment with tr+sed pipeline").not.toBeNull();
    const mainLine = mainMatch![0].trimEnd();

    expect(mainLine).toBe(reusableLine);
    expect(mainWf).toMatch(/SKIP_MERGE=true/);
  });

  it("main workflow should use empty default fallback for SKEPTIC_CRON_AUTO_MERGE env var", () => {
    // reusable uses || '' at the end of the expression
    const reusableEnvMatch = reusableWf.match(/SKEPTIC_CRON_AUTO_MERGE: \$\{\{ (?:inputs\.auto_merge != '' && inputs\.auto_merge \|\| )?vars\.SKEPTIC_CRON_AUTO_MERGE \|\| '' \}\}/);
    expect(reusableEnvMatch).not.toBeNull();
    
    expect(mainWf).toMatch(/SKEPTIC_CRON_AUTO_MERGE: \$\{\{ vars\.SKEPTIC_CRON_AUTO_MERGE \|\| '' \}\}/);
  });
});
