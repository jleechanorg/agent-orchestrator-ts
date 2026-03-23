/**
 * Backfill extensions — spawns sessions for open PRs that have no active session.
 *
 * Extracted from lifecycle-manager.ts to keep the core polling loop minimal
 * and the backfill logic independently testable.
 */

import type {
  PluginRegistry,
  SessionManager,
  Session,
  SCM,
  ProjectConfig,
} from "./types.js";
import type { ProjectObserver } from "./observability.js";

/** Dependencies injected by the lifecycle-manager call site. */
export interface BackfillDeps {
  registry: PluginRegistry;
  sessionManager: SessionManager;
  observer: ProjectObserver;
}

/** Parameters for a single backfill invocation. */
export interface BackfillParams {
  projectId: string;
  project: ProjectConfig;
  activeSessions: Session[];
  correlationId: string;
}

// ---- module-level throttle state ----
let lastBackfillTime = 0;
const BACKFILL_INTERVAL_MS = 5 * 60_000; // 5 minutes

/** Reset throttle state — exposed for testing only. */
export function _resetBackfillTimer(): void {
  lastBackfillTime = 0;
}

/**
 * Spawn a session for the first uncovered, non-draft open PR.
 *
 * Throttled to run at most once per `BACKFILL_INTERVAL_MS`.
 * Returns `true` when a new session was successfully spawned.
 */
export async function backfillUncoveredPRs(
  deps: BackfillDeps,
  params: BackfillParams,
): Promise<boolean> {
  const { registry, sessionManager, observer } = deps;
  const { projectId, project, activeSessions, correlationId } = params;

  const now = Date.now();
  if (now - lastBackfillTime < BACKFILL_INTERVAL_MS) return false;

  const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
  if (!scm?.listOpenPRs) return false;

  // Set throttle AFTER confirming SCM supports listOpenPRs — so missing
  // support doesn't block retries when a different SCM plugin is loaded.
  lastBackfillTime = now;

  try {
    const openPRs = await scm.listOpenPRs(project);
    if (openPRs.length === 0) return false;

    // Build set of PR numbers AND branches covered by active sessions.
    // Sessions may not have pr.number set yet if detectPR hasn't run,
    // but they will have branch — match on both to avoid duplicate spawns.
    const coveredPRs = new Set<number>();
    const coveredBranches = new Set<string>();
    for (const s of activeSessions) {
      if (s.pr?.number) coveredPRs.add(s.pr.number);
      if (s.branch) coveredBranches.add(s.branch);
    }

    // Find uncovered PRs (skip drafts, check both PR number and branch)
    const uncovered = openPRs.filter(
      (pr) => !pr.isDraft && !coveredPRs.has(pr.number) && !coveredBranches.has(pr.branch),
    );

    if (uncovered.length === 0) return false;

    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "lifecycle.backfill.detected",
      outcome: "success",
      correlationId,
      projectId,
      data: {
        openPRs: openPRs.length,
        activeSessions: activeSessions.length,
        coveredPRs: coveredPRs.size,
        uncoveredCount: uncovered.length,
        uncoveredPRs: uncovered.map((pr) => pr.number),
      },
      level: "info",
    });

    // Spawn one session at a time to avoid thundering herd.
    // The next backfill cycle (5 min later) will pick up the rest.
    const pr = uncovered[0];
    try {
      // Don't pass branch to spawn — let claimPR handle checkout so
      // the workspace starts on the correct PR branch via SCM checkout.
      const session = await sessionManager.spawn({
        projectId,
        prompt: `Continue working on PR #${pr.number}: ${pr.title}. Check PR status, fix any blockers (CI failures, review comments, merge conflicts), and drive it to 6-green.`,
      });

      // Claim the PR for this session — this checks out the branch
      try {
        await sessionManager.claimPR(session.id, String(pr.number));
      } catch (claimErr) {
        // claimPR failed — kill the orphan session to avoid waste
        observer.recordOperation({
          metric: "lifecycle_poll",
          operation: "lifecycle.backfill.claim_failed",
          outcome: "failure",
          correlationId,
          projectId,
          sessionId: session.id,
          data: {
            prNumber: pr.number,
            error: claimErr instanceof Error ? claimErr.message : String(claimErr),
          },
          level: "warn",
        });
        await sessionManager.kill(session.id).catch(() => {});
        return false;
      }

      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.backfill.spawned",
        outcome: "success",
        correlationId,
        projectId,
        sessionId: session.id,
        data: { prNumber: pr.number, prTitle: pr.title, branch: pr.branch },
        level: "info",
      });
      return true;
    } catch (spawnErr) {
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.backfill.spawn_failed",
        outcome: "failure",
        correlationId,
        projectId,
        data: {
          prNumber: pr.number,
          error: spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
        },
        level: "warn",
      });
    }
  } catch (listErr) {
    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "lifecycle.backfill.list_failed",
      outcome: "failure",
      correlationId,
      projectId,
      data: {
        error: listErr instanceof Error ? listErr.message : String(listErr),
      },
      level: "warn",
    });
  }
  return false;
}
