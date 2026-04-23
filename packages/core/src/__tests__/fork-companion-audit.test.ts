/**
 * Fork Companion Audit Test -- Phase A non-conflicting restructure audit.
 *
 * Validates that all 11 fork-*.ts companion files:
 *   1. Exist on disk
 *   2. Export at least one expected function (type-only exports verified by TS)
 *   3. Are imported by the files that consume them
 *
 * This is a LIVENESS test -- proves the companions are live code, not dead weight.
 */

import { beforeAll, describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { stat, readFile } from "node:fs/promises";

const CORE_SRC = resolve(import.meta.dirname, "..");

// All 11 fork-*.ts companion files in the audit scope
const FORK_FILES = [
  "fork-skeptic-extension",
  "fork-claim-verification",
  "fork-utils",
  "fork-slash-command-routing",
  "fork-dead-agent",
  "fork-reaction-handlers",
  "fork-reaction-retry-policy",
  "fork-reaction-rfr",
  "fork-lifecycle-manager",
  "fork-lifecycle-postmerge",
  "fork-lifecycle-kki-override",
] as const;

type ForkFile = (typeof FORK_FILES)[number];

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function hasNamedValueExport(source: string, name: string): boolean {
  const escapedName = escapeRegex(name);
  const exportPattern = new RegExp(
    `(?:export\\s+(?:function|const|async\\s+function|class)\\s+${escapedName}(?![A-Za-z0-9_$])|export\\s+\\{\\s*[^}]*\\s+as\\s+${escapedName}\\s*\\}|export\\s+\\{\\s*${escapedName}\\s*\\})`,
    "m",
  );
  return exportPattern.test(source);
}

// VALUE exports only (functions/consts -- not type-only interfaces).
// Type-only exports are verified by TypeScript compilation.
const EXPECTED_VALUE_EXPORTS: Record<ForkFile, string[]> = {
  "fork-skeptic-extension": ["runSkepticReviewReaction"],
  "fork-claim-verification": ["runClaimVerification", "verifySkepticClaimForPR"],
  "fork-utils": ["updateSessionMetadataHelper"],
  // messageContainsCommentFixIntent and transformToSlashCommand are re-export aliases
  // of internal -Impl functions; their liveness is proven by applySlashCommandRouting.
  "fork-slash-command-routing": ["applySlashCommandRouting"],
  "fork-dead-agent": ["applyDeadAgentOverride"],
  "fork-reaction-handlers": ["handleRequestMerge", "handleParallelRetry"],
  "fork-reaction-retry-policy": ["resolveReactionMaxRetries"],
  "fork-reaction-rfr": ["handleRespawnForReview"],
  "fork-lifecycle-manager": [
    "parseRateLimitReset",
    "setProjectPause",
    "clearProjectPause",
    "detectAndApplyRateLimitPause",
  ],
  "fork-lifecycle-postmerge": [
    "reapPostMergeCoWorkers",
    "POST_MERGE_REAPER_CONFIG",
  ],
  "fork-lifecycle-kki-override": ["isPRMerged"],
};

// ---------------------------------------------------------------------------
// Test: file exists on disk
// ---------------------------------------------------------------------------

describe("fork-companion-audit liveness", () => {
  for (const file of FORK_FILES) {
    const fullPath = resolve(CORE_SRC, `${file}.ts`);
    it(`${file}.ts exists on disk`, async () => {
      const s = await stat(fullPath);
      expect(s.isFile(), `${fullPath} is not a file`).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Test: each companion file exports the expected value exports (functions/consts)
// Type-only exports are NOT runtime-verifiable -- skip them.
// ---------------------------------------------------------------------------

describe("fork-companion-audit exports", () => {
  it("matches exact export identifiers instead of prefix matches", () => {
    expect(hasNamedValueExport("export function setProjectPause() {}", "setProjectPause")).toBe(true);
    expect(hasNamedValueExport("export function setProjectPaused() {}", "setProjectPause")).toBe(false);
  });

  for (const [file, expectedExports] of Object.entries(EXPECTED_VALUE_EXPORTS)) {
    const fullPath = resolve(CORE_SRC, `${file}.ts`);
    it(`${file}.ts exports expected value names`, async () => {
      const src = await readFile(fullPath, "utf8");
      for (const name of expectedExports) {
        expect(hasNamedValueExport(src, name), `${file}.ts missing value export: ${name}`).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Test: each companion is imported by its primary consumer (lifecycle-manager.ts)
// We read the source file directly to avoid vitest import caching issues.
// ---------------------------------------------------------------------------

describe("fork-companion-audit imported by lifecycle-manager.ts", () => {
  let lifecycleManagerSource = "";
  const consumedByLifecycleManager: ForkFile[] = [
    "fork-lifecycle-manager",
    "fork-lifecycle-kki-override",
    "fork-reaction-handlers",
    "fork-reaction-rfr",
    "fork-utils",
    "fork-dead-agent",
    "fork-skeptic-extension",
    "fork-claim-verification",
    "fork-reaction-retry-policy",
    "fork-lifecycle-postmerge",
  ];

  beforeAll(async () => {
    lifecycleManagerSource = await readFile(resolve(CORE_SRC, "lifecycle-manager.ts"), "utf8");
  });

  for (const file of consumedByLifecycleManager) {
    it(`lifecycle-manager.ts imports ${file}`, () => {
      expect(
        lifecycleManagerSource.includes(`from "./${file}.js"`),
        `lifecycle-manager.ts does not import ${file}`,
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Test: fork-utils is imported by multiple non-lifecycle files
// ---------------------------------------------------------------------------

describe("fork-companion-audit fork-utils consumers", () => {
  const forkUtilsConsumers = [
    "review-backlog.ts",
    "review-sla.ts",
    "review-kpi.ts",
    "review-atomic-rereview.ts",
    "no-delta-watchdog.ts",
    "fork-reaction-rfr.ts",
  ];

  for (const file of forkUtilsConsumers) {
    it(`fork-utils is imported by ${file}`, async () => {
      const fullPath = resolve(CORE_SRC, file);
      const src = await readFile(fullPath, "utf8");
      expect(
        src.includes('from "./fork-utils.js"'),
        `fork-utils not imported in ${file}`,
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Test: slash command routing is re-exported via utils.ts
// ---------------------------------------------------------------------------

describe("fork-companion-audit slash-command-routing", () => {
  it("fork-slash-command-routing is re-exported via utils.ts", async () => {
    const utilsSrc = await readFile(resolve(CORE_SRC, "utils.ts"), "utf8");
    expect(utilsSrc).toContain('from "./fork-slash-command-routing.js"');
  });

  it("fork-slash-command-routing is used by session-manager.ts", async () => {
    const smSrc = await readFile(resolve(CORE_SRC, "session-manager.ts"), "utf8");
    expect(smSrc).toContain('from "./fork-slash-command-routing.js"');
  });
});

// ---------------------------------------------------------------------------
// Test: fork-lifecycle-postmerge exports reapPostMergeCoWorkers
// ---------------------------------------------------------------------------

describe("fork-companion-audit fork-lifecycle-postmerge", () => {
  it("fork-lifecycle-postmerge exports reapPostMergeCoWorkers", async () => {
    const src = await readFile(resolve(CORE_SRC, "fork-lifecycle-postmerge.ts"), "utf8");
    expect(src).toContain("export async function reapPostMergeCoWorkers");
  });
});
