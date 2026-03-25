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
import { validateAndEmitExitProof } from "./session-exit-proof.js";
import type {
  SessionManager,
  Session,
  OrchestratorConfig,
  PluginRegistry,
  OrchestratorEvent,
  EventPriority,
  EventType,
} from "./types.js";
import { createCorrelationId, type ProjectObserver } from "./observability.js";

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
    async list(_filter) {
      return delegate.list(projectId);
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

/** orch-s66: dependencies needed to emit exit proof notifications for reaped sessions. */
export interface PostMergeExitProofDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  observer: ProjectObserver;
  notifyHuman: (event: OrchestratorEvent, priority: EventPriority) => Promise<void>;
  createEvent: (
    type: EventType,
    opts: {
      sessionId: string;
      projectId: string;
      message: string;
      priority?: EventPriority;
      data?: Record<string, unknown>;
    },
  ) => OrchestratorEvent;
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
 * @param exitProofDeps  - orch-s66: required to emit session.exited notifications
 *                          for reaped co-worker sessions. Pass when terminal
 *                          notification emission is desired (typically always in prod).
 */
export async function reapPostMergeCoWorkers(
  mergedSession: Session,
  sessionManager: SessionManager,
  observer: ProjectObserver,
  exitProofDeps?: PostMergeExitProofDeps,
): Promise<PostMergeReapResult> {
  const projectId = mergedSession.projectId;

  try {
    // Snapshot sessions BEFORE reaping — reapStaleSessions calls kill() which
    // archives sessions, making them invisible to sessionManager.get(). Without
    // this pre-reap snapshot, exit proof emission would silently fail because
    // the reaped session data is no longer available via get().
    const scopedManager = projectScopedSessionManager(sessionManager, projectId);
    const preReapSessions: Session[] = exitProofDeps
      ? await scopedManager.list(projectId)
      : [];
    const sessionById = new Map(preReapSessions.map((s) => [s.id, s]));

    const reaped: ReaperResult = await reapStaleSessions(
      {
        ...DEFAULT_REAPER_CONFIG,
        noPrThresholdMs: POST_MERGE_REAPER_CONFIG.noPrThresholdMs,
        idleThresholdMs: POST_MERGE_REAPER_CONFIG.idleThresholdMs,
        maxKillsPerRun: POST_MERGE_REAPER_CONFIG.maxKillsPerRun,
        startupGracePeriodMs: exitProofDeps?.config.startupGracePeriodMs ?? 120_000, // bd-85r: honor configured value
      },
      // Project-scope the session list so cross-project sessions are invisible
      { sessionManager: scopedManager },
    );

    const killed: ReapedSessionInfo[] = reaped.killed.map((r) => ({
      sessionId: r.sessionId,
      reason: r.reason,
    }));

    const hadErrors = reaped.errors.length > 0;

    // orch-s66: emit session.exited notifications for each reaped co-worker.
    // This mirrors the exit proof that lifecycle-manager emits for the primary
    // merged session. Without this, Slack thread terminal updates are silently
    // skipped for co-workers cleaned up by the post-merge sweep.
    // Uses the pre-reap snapshot since sessions are archived after kill().
    if (exitProofDeps && killed.length > 0) {
      for (const killedInfo of killed) {
        try {
          const reapedSession = sessionById.get(killedInfo.sessionId);
          if (reapedSession) {
            await validateAndEmitExitProof(reapedSession, "merged", {
              config: exitProofDeps.config,
              registry: exitProofDeps.registry,
              observer: exitProofDeps.observer,
              notifyHuman: exitProofDeps.notifyHuman,
              createEvent: exitProofDeps.createEvent,
            });
          }
        } catch (proofErr) {
          // Non-fatal: exit proof failures must not corrupt the reap result
          observer.recordOperation({
            metric: "lifecycle_poll",
            operation: "lifecycle.post_merge_exit_proof",
            outcome: "failure",
            correlationId: createCorrelationId("post-merge-reap"),
            projectId,
            sessionId: killedInfo.sessionId,
            data: { error: proofErr instanceof Error ? proofErr.message : String(proofErr) },
            level: "warn",
          });
        }
      }
    }

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
