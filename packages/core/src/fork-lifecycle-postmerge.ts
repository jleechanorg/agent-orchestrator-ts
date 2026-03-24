/**
 * Fork-specific post-merge reaping — extracted from lifecycle-manager.ts.
 *
 * When a session transitions to "merged", this module immediately sweeps co-
 * worker sessions in the same project that:
 *   - have no open PR (`pr === null`)
 *   - have been idle for the configured threshold
 *   - belong to the same project (cross-project isolation)
 *
 * Extracted into a companion module per CLAUDE.md: "extract fork logic into
 * companion modules (*-extensions.ts or fork-*.ts files)" to keep the upstream
 * core diff minimal.
 */

import {
  reapStaleSessions,
  DEFAULT_REAPER_CONFIG,
  type ReaperResult,
} from "./session-reaper.js";
import type { SessionManager, Session } from "./types.js";
import type { ProjectObserver } from "./observability.js";
import { createCorrelationId } from "./observability.js";

// Configurable thresholds — kept in one place so reviewers can validate intent.
export const POST_MERGE_REAPER_CONFIG = {
  /** Sessions with no PR older than this are eligible (default: 4h). */
  noPrThresholdMs: DEFAULT_REAPER_CONFIG.noPrThresholdMs,
  /** Only reap sessions that have been idle for at least this long. */
  idleThresholdMs: 5 * 60_000, // 5 min
  /** Max sessions to kill in one post-merge sweep. */
  maxKillsPerRun: DEFAULT_REAPER_CONFIG.maxKillsPerRun,
  /** ms before orphaned/exited sessions are reaped (not used in no-PR path). */
  orphanedThresholdMs: DEFAULT_REAPER_CONFIG.orphanedThresholdMs,
} as const;

/**
 * A project-scoped SessionManager wrapper that delegates to the real manager
 * but always filters to the given projectId. This prevents a merge in one
 * project from reaping sessions belonging to unrelated projects.
 */
function projectScopedSessionManager(
  delegate: SessionManager,
  projectId: string,
): SessionManager {
  return {
    ...delegate,
    async list(filter) {
      return delegate.list({ ...filter, projectId });
    },
  };
}

/** Result of a post-merge reap sweep. */
export interface PostMergeReapResult {
  /** Sessions that were successfully reaped. */
  killed: ReapedSessionInfo[];
  /** Whether at least one kill error occurred. */
  hadErrors: boolean;
  /** Human-readable summary. */
  summary: string;
}

interface ReapedSessionInfo {
  sessionId: string;
  reason: string;
}

/**
 * Reap co-worker sessions in the same project after a PR merge.
 *
 * Called from lifecycle-manager when a session transitions to "merged".
 * The triggering session itself is not eligible for reaping (it just merged).
 *
 * @param mergedSession  - the session whose PR just merged (provides projectId)
 * @param sessionManager - the global session manager
 * @param observer       - for recording operations into the observability stream
 */
export async function reapPostMergeCoWorkers(
  mergedSession: Session,
  sessionManager: SessionManager,
  observer: ProjectObserver,
): Promise<PostMergeReapResult> {
  const projectId = mergedSession.projectId;

  try {
    const reaped: ReaperResult = await reapStaleSessions(
      {
        ...DEFAULT_REAPER_CONFIG,
        noPrThresholdMs: POST_MERGE_REAPER_CONFIG.noPrThresholdMs,
        idleThresholdMs: POST_MERGE_REAPER_CONFIG.idleThresholdMs,
        maxKillsPerRun: POST_MERGE_REAPER_CONFIG.maxKillsPerRun,
      },
      // Project-scope the session list so cross-project sessions are invisible
      { sessionManager: projectScopedSessionManager(sessionManager, projectId) },
    );

    const killed: ReapedSessionInfo[] = reaped.killed.map((r) => ({
      sessionId: r.sessionId,
      reason: r.reason,
    }));

    const hadErrors = reaped.errors.length > 0;

    // Record outcome(s)
    if (reaped.killed.length > 0) {
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.post_merge_reap",
        outcome: hadErrors ? "failure" : "success",
        correlationId: createCorrelationId("post-merge-reap"),
        projectId,
        sessionId: mergedSession.id,
        data: {
          killed: killed.map((k) => k.sessionId),
          errors: reaped.errors.map((e) => e.sessionId),
        },
        level: "info",
      });
    }

    // Partial failure: at least one session was skipped due to a kill error
    if (hadErrors) {
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.post_merge_reap_partial_failure",
        outcome: "failure",
        correlationId: createCorrelationId("post-merge-reap"),
        projectId,
        sessionId: mergedSession.id,
        data: {
          errors: reaped.errors,
        },
        level: "warn",
      });
    }

    const summary =
      reaped.killed.length === 0 && !hadErrors
        ? "no co-worker sessions eligible for reaping"
        : `reaped ${reaped.killed.length} session(s)${hadErrors ? " (partial failure)" : ""}`;

    return { killed, hadErrors, summary };
  } catch (reapErr) {
    // Non-fatal — reap failure must not break the merge transition.
    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "lifecycle.post_merge_reap",
      outcome: "failure",
      correlationId: createCorrelationId("post-merge-reap"),
      projectId,
      sessionId: mergedSession.id,
      data: { error: reapErr instanceof Error ? reapErr.message : String(reapErr) },
      level: "warn",
    });

    return {
      killed: [],
      hadErrors: true,
      summary: `reap sweep error: ${reapErr instanceof Error ? reapErr.message : String(reapErr)}`,
    };
  }
}
