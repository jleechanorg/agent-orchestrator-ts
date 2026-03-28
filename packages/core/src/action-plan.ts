/**
 * Gate-closure action plan — deterministic 7-green sequencing.
 *
 * Consumes MergeGateResult and emits a prioritized list of actions
 * a worker should take to close all failing gates, in optimal order.
 */

import type { MergeGateResult } from "./merge-gate.js";

export interface ActionItem {
  /** Which gate this addresses (matches MergeGateCheck.name) */
  gate: string;
  /** Execution priority (1 = do first). Lower = higher priority. */
  priority: number;
  /** Human-readable action description */
  action: string;
  /** Why this must be done before lower-priority items */
  reason: string;
}

export interface ActionPlan {
  /** Ordered list of actions (sorted by priority ascending) */
  items: ActionItem[];
  /** True if no actions needed (all gates pass) */
  ready: boolean;
}

/**
 * Gate name constants — MUST match the `name` field emitted by checkMergeGate()
 * in merge-gate.ts. If merge-gate.ts changes these strings, update here.
 */
export const GATE = {
  CI_GREEN: "CI green",
  MERGEABLE: "Mergeable",
  CR_APPROVED: "CodeRabbit approved",
  BUGBOT_CLEAN: "Bugbot clean",
  INLINE_RESOLVED: "Inline comments resolved",
  EVIDENCE: "Evidence review pass",
  SKEPTIC: "Skeptic approved",
} as const;

/**
 * Gate name → priority. Lower = do first.
 * Order encodes dependency chain: conflicts block CI, CI blocks CR, etc.
 */
const GATE_PRIORITY: Record<string, number> = {
  [GATE.MERGEABLE]: 1,
  [GATE.CI_GREEN]: 2,
  [GATE.BUGBOT_CLEAN]: 3,
  [GATE.INLINE_RESOLVED]: 4,
  [GATE.CR_APPROVED]: 5,
  [GATE.EVIDENCE]: 6,
  [GATE.SKEPTIC]: 7,
};

/** Gate name → recommended fix action */
const GATE_FIX: Record<string, string> = {
  [GATE.MERGEABLE]:
    "Rebase onto main: git fetch origin && git rebase origin/main && git push --force-with-lease",
  [GATE.CI_GREEN]: "Read CI logs, fix failing tests/lint, push",
  [GATE.BUGBOT_CLEAN]: "Fix error-severity Bugbot findings, push",
  [GATE.INLINE_RESOLVED]:
    "Address all unresolved review threads, push, mark resolved",
  [GATE.CR_APPROVED]:
    "Post '@coderabbitai all good?' after fixing all above gates",
  [GATE.EVIDENCE]: "Run /er to generate evidence bundle",
  [GATE.SKEPTIC]: "Wait for Skeptic CI check or fix issues it flagged",
};

/** Gate name → why this priority order */
const GATE_REASON: Record<string, string> = {
  [GATE.MERGEABLE]:
    "Conflicts block CI and prevent CR from reviewing current code",
  [GATE.CI_GREEN]:
    "CI must pass before CR will approve; also required for skeptic",
  [GATE.BUGBOT_CLEAN]:
    "Error findings should be fixed before addressing CR comments",
  [GATE.INLINE_RESOLVED]:
    "All threads must be resolved before re-requesting CR approval",
  [GATE.CR_APPROVED]:
    "CR re-reviews after code changes — fix everything else first",
  [GATE.EVIDENCE]: "Evidence should be generated after code is stable",
  [GATE.SKEPTIC]: "Skeptic verifies all other gates — must run last",
};

/**
 * Build a prioritized action plan from a merge gate result.
 * Failing gates are sorted by dependency order so workers
 * address blockers before the things they unblock.
 */
export function buildActionPlan(gateResult: MergeGateResult): ActionPlan {
  if (gateResult.passed) {
    return { items: [], ready: true };
  }

  const failingChecks = gateResult.checks.filter((c) => !c.passed);
  const items: ActionItem[] = failingChecks
    .map((check) => ({
      gate: check.name,
      priority: GATE_PRIORITY[check.name] ?? 99,
      action: GATE_FIX[check.name] ?? `Fix: ${check.detail}`,
      reason: GATE_REASON[check.name] ?? "Required for merge",
    }))
    .sort((a, b) => a.priority - b.priority);

  return { items, ready: false };
}
