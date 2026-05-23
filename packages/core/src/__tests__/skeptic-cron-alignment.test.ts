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
    // Check for normalization logic in main workflow
    expect(mainWf).toMatch(/_AUTO_MERGE_NORM=/);
    expect(mainWf).toMatch(/SKIP_MERGE=true/);
    expect(mainWf).toMatch(/sed 's\/\^\[\[:space:\]\]\*\/\/;s\/\[\[:space:\]\]\*\$\/\/'/);
  });

  it("main workflow should use empty default fallback for SKEPTIC_CRON_AUTO_MERGE env var", () => {
    // reusable uses || '' at the end of the expression
    // main currently uses || 'false'
    expect(mainWf).toMatch(/SKEPTIC_CRON_AUTO_MERGE: \$\{\{ vars\.SKEPTIC_CRON_AUTO_MERGE \|\| '' \}\}/);
  });
});
