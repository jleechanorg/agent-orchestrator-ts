import type { SessionStatus } from "./types.js";

const VALID_TRANSITIONS: Map<SessionStatus, ReadonlySet<SessionStatus>> = new Map([
  ["spawning", new Set(["working", "idle", "errored", "killed"])],
  ["working", new Set(["idle", "pr_open", "stuck", "errored", "killed", "needs_input"])],
  ["idle", new Set(["working", "killed", "terminated"])],
  ["pr_open", new Set(["ci_failed", "review_pending", "mergeable", "merge_conflicts", "merged", "killed", "idle"])],
  ["ci_failed", new Set(["pr_open", "review_pending", "mergeable", "killed", "idle"])],
  ["review_pending", new Set(["changes_requested", "approved", "mergeable", "killed", "idle"])],
  ["changes_requested", new Set(["pr_open", "review_pending", "killed", "idle"])],
  ["approved", new Set(["mergeable", "merged", "killed"])],
  ["mergeable", new Set(["merged", "merge_conflicts", "killed"])],
  ["merge_conflicts", new Set(["pr_open", "mergeable", "killed", "idle"])],
  ["needs_input", new Set(["working", "killed"])],
  ["stuck", new Set(["working", "killed"])],
  ["errored", new Set(["working", "killed"])],
  ["killed", new Set()],
  ["done", new Set()],
  ["terminated", new Set()],
  ["merged", new Set()],
  ["cleanup", new Set(["done", "killed"])],
]);

export interface TransitionValidationResult {
  valid: boolean;
  from: SessionStatus;
  to: SessionStatus;
  reason?: string;
}

export function validateStatusTransition(
  from: SessionStatus,
  to: SessionStatus,
): TransitionValidationResult {
  if (from === to) {
    return { valid: true, from, to };
  }

  const allowed = VALID_TRANSITIONS.get(from);
  if (!allowed) {
    return {
      valid: false,
      from,
      to,
      reason: `unknown source status '${from}'`,
    };
  }

  if (allowed.size === 0) {
    return {
      valid: false,
      from,
      to,
      reason: `terminal status '${from}' cannot transition`,
    };
  }

  if (!allowed.has(to)) {
    return {
      valid: false,
      from,
      to,
      reason: `transition ${from} → ${to} is not valid`,
    };
  }

  return { valid: true, from, to };
}
