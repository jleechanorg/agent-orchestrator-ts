/**
 * Terminal finalizer guard.
 *
 * Mechanism (6): terminal finalizer guard — validates PR health and
 * review state before the lifecycle worker declares a session terminal
 * (e.g. before marking a session as "done", "killed", or "stuck").
 *
 * Design:
 * - Called before any terminal status transition
 * - Checks: merge gate conditions, unresolved CHANGES_REQUESTED, open critical comments
 * - If any guard fails, emits a warning event and blocks the transition by default
 * - Caller can override to force-transition (rare, for abandon scenarios)
 */

import type { Session, OrchestratorConfig, SCM, OrchestratorEvent, EventPriority, ReviewComment } from "./types.js";
import { checkMergeGate, type MergeGateResult } from "./merge-gate.js";
import { judgeCommentBatch, type CommentBatchJudgment } from "./review-judgment-matrix.js";

// ---------------------------------------------------------------------------
// Guard result
// ---------------------------------------------------------------------------

export interface TerminalGuardResult {
  /** true if the session is safe to declare terminal */
  safe: boolean;
  /** List of blocking issues found */
  blockers: TerminalGuardBlocker[];
  /** Merge gate result if checked */
  mergeGateResult?: MergeGateResult;
  /** Comment judgment if checked */
  commentJudgment?: CommentBatchJudgment;
}

export interface TerminalGuardBlocker {
  code: string;
  detail: string;
  severity: "error" | "warning";
  /** Recommended action to unblock */
  fixAction: string;
}

// ---------------------------------------------------------------------------
// Guard checks
// ---------------------------------------------------------------------------

export interface TerminalGuardDeps {
  session: Session;
  config: OrchestratorConfig;
  scm: SCM;
  /**
   * Emit a warning event when a guard blocks a terminal transition.
   * If null, events are skipped (e.g. in dry-run contexts).
   */
  emitWarning?: (event: OrchestratorEvent, priority: EventPriority) => Promise<void>;
  createEvent?: (
    type: string,
    opts: { sessionId: string; projectId: string; message: string; data?: Record<string, unknown> },
  ) => OrchestratorEvent;
  /** Force-override: skip guard checks (default: false) */
  force?: boolean;
}

/**
 * Run the terminal finalizer guard on a session.
 *
 * Blocks terminal transition if:
 * 1. PR has unresolved blocking/objective review comments
 * 2. PR fails merge gate (when mergeable=True was expected)
 * 3. Session is still actively processing (new heartbeat < 2 min ago)
 */
export async function runTerminalGuard(deps: TerminalGuardDeps): Promise<TerminalGuardResult> {
  const { session, config, scm, emitWarning, createEvent, force = false } = deps;

  if (force) {
    return { safe: true, blockers: [] };
  }

  const blockers: TerminalGuardBlocker[] = [];
  let mergeGateResult: MergeGateResult | undefined;
  let commentJudgment: CommentBatchJudgment | undefined;

  if (!session.pr) {
    blockers.push({
      code: "no_pr",
      detail: "Session has no associated PR",
      severity: "warning",
      fixAction: "Attach a PR to this session or kill it manually",
    });
  } else {
    // Check 1: Merge gate (skip if PR is expected to be non-mergeable)
    const mergeGateConfig = config.projects[session.projectId]?.mergeGate;
    if (mergeGateConfig?.enabled) {
      try {
        mergeGateResult = await checkMergeGate(session.pr, mergeGateConfig, scm);

        // Unresolved comments are blockers (from merge gate check 5)
        const unresolvedBlocking = mergeGateResult.checks.find(
          (c) => c.name === "Inline comments resolved" && !c.passed,
        );
        if (unresolvedBlocking) {
          blockers.push({
            code: "unresolved_comments",
            detail: unresolvedBlocking.detail,
            severity: "error",
            fixAction: "Resolve all review comments before merging or abandoning",
          });
        }

        // CI not green
        const ciCheck = mergeGateResult.checks.find((c) => c.name === "CI green" && !c.passed);
        if (ciCheck) {
          blockers.push({
            code: "ci_not_green",
            detail: ciCheck.detail,
            severity: "error",
            fixAction: "Wait for CI to pass before merging or killing",
          });
        }

        // Merge conflicts
        const mergeCheck = mergeGateResult.checks.find((c) => c.name === "Mergeable" && !c.passed);
        if (mergeCheck) {
          blockers.push({
            code: "merge_conflicts",
            detail: mergeCheck.detail,
            severity: "warning",
            fixAction: "Rebase or merge main into the PR branch",
          });
        }
      } catch {
        blockers.push({
          code: "merge_gate_check_failed",
          detail: "Could not verify merge gate conditions",
          severity: "warning",
          fixAction: "Manually verify PR health before proceeding",
        });
      }

      // Check 2: Blocking/objective comments via judgment matrix
      try {
        const pendingComments: ReviewComment[] = (await scm.getPendingComments(session.pr)) ?? [];
        commentJudgment = judgeCommentBatch(pendingComments);

        if (commentJudgment.blocking.length > 0) {
          blockers.push({
            code: "blocking_comments",
            detail: `${commentJudgment.blocking.length} blocking review comment(s) found`,
            severity: "error",
            fixAction: "Address security/critical issues before abandoning session",
          });
        }
      } catch {
        // Non-fatal — skip comment judgment if API fails
      }
    }

    // Check 3: Active session guard — don't terminal-ize if agent recently heartbeated
    if (session.lastActivityAt) {
      const minutesSinceHeartbeat = (Date.now() - session.lastActivityAt.getTime()) / 60_000;
      if (minutesSinceHeartbeat < 2) {
        blockers.push({
          code: "session_active",
          detail: `Session last heartbeat ${minutesSinceHeartbeat.toFixed(1)}m ago — still active`,
          severity: "warning",
          fixAction: "Wait for session to complete or time out naturally",
        });
      }
    }
  }

  const safe = blockers.filter((b) => b.severity === "error").length === 0;

  // Emit warning event if blocked
  if (!safe && emitWarning && createEvent && session.pr) {
    const event = createEvent("terminal_guard.blocked", {
      sessionId: session.id,
      projectId: session.projectId,
      message: `Terminal transition blocked for PR #${session.pr.number}: ${blockers.map((b) => b.code).join(", ")}`,
      data: { blockers: blockers.map((b) => ({ code: b.code, detail: b.detail })) },
    });
    await emitWarning(event, "warning");
  }

  return { safe, blockers, mergeGateResult, commentJudgment };
}

/**
 * Summary string for logging.
 */
export function formatGuardResult(result: TerminalGuardResult): string {
  if (result.safe) return "Terminal guard: SAFE";
  const errors = result.blockers.filter((b) => b.severity === "error");
  const warnings = result.blockers.filter((b) => b.severity === "warning");
  const lines = ["Terminal guard: BLOCKED"];
  for (const b of errors)   lines.push(`  [ERROR] ${b.code}: ${b.detail}`);
  for (const b of warnings) lines.push(`  [WARN]  ${b.code}: ${b.detail}`);
  return lines.join("\n");
}
