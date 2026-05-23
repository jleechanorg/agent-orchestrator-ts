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
    // Extract the normalization block from reusable workflow
    const reusableMatch = reusableWf.match(/_AUTO_MERGE_NORM="[^"]+"/);
    expect(reusableMatch).not.toBeNull();
    const reusableBlock = reusableMatch![0];

    // Check for normalization logic in main workflow
    expect(mainWf).toContain(reusableBlock);
    expect(mainWf).toMatch(/SKIP_MERGE=true/);
    expect(mainWf).toMatch(/sed 's\/\^\[\[:space:\]\]\*\/\/;s\/\[\[:space:\]\]\*\$\/\/'/);
  });

  it("main workflow should use empty default fallback for SKEPTIC_CRON_AUTO_MERGE env var", () => {
    // reusable uses || '' at the end of the expression
    const reusableEnvMatch = reusableWf.match(/SKEPTIC_CRON_AUTO_MERGE: \$\{\{ (?:inputs\.auto_merge != '' && inputs\.auto_merge \|\| )?vars\.SKEPTIC_CRON_AUTO_MERGE \|\| '' \}\}/);
    expect(reusableEnvMatch).not.toBeNull();
    
    expect(mainWf).toMatch(/SKEPTIC_CRON_AUTO_MERGE: \$\{\{ vars\.SKEPTIC_CRON_AUTO_MERGE \|\| '' \}\}/);
  });
});
