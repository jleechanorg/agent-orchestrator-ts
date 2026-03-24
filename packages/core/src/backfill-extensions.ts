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
    // If spawn/claim fails for a PR, skip it and try the next uncovered PR.
    // Stop after consecutive failures to avoid unbounded churn.
    // Spawn failures indicate systemic issues (project paused, missing plugin, etc.)
    // Claim failures indicate systemic workspace issues (CONFLICTING PR, locked ws, etc.)
    const MAX_CONSECUTIVE_SPAWN_FAILURES = 3;
    const MAX_CONSECUTIVE_CLAIM_FAILURES = 3;
    let consecutiveSpawnFailures = 0;
    let consecutiveClaimFailures = 0;
    for (const pr of uncovered) {
      try {
        // Don't pass branch to spawn — let claimPR handle checkout so
        // the workspace starts on the correct PR branch via SCM checkout.
        // pr.title is contributor-supplied — escape quotes to prevent prompt injection.
        const escapedTitle = pr.title
          .replace(/\\/g, "\\\\") // escape backslashes first
          .replace(/"/g, '\\"');
        const session = await sessionManager.spawn({
          projectId,
          // Label the title as untrusted contributor input so the agent does not
          // treat embedded text as system directives. Quotes prevent injection.
          prompt: `Continue working on PR #${pr.number}: [PR title: "${escapedTitle}"]. Check PR status, fix any blockers (CI failures, review comments, merge conflicts), and drive it to 6-green.`,
        });
        consecutiveClaimFailures = 0; // reset on spawn success

        // Claim the PR for this session — this checks out the branch
        try {
          await sessionManager.claimPR(session.id, String(pr.number));
          consecutiveSpawnFailures = 0; // reset when both succeed
        } catch (claimErr) {
          consecutiveClaimFailures++;
          observer.recordOperation({
            metric: "lifecycle_poll",
            operation: "lifecycle.backfill.claim_failed",
            outcome: "failure",
            correlationId,
            projectId,
            sessionId: session.id,
            data: {
              prNumber: pr.number,
              consecutiveClaimFailures,
              error: claimErr instanceof Error ? claimErr.message : String(claimErr),
            },
            level: "warn",
          });
          // If kill fails, abort rather than leaking an orphan session
          try {
            await sessionManager.kill(session.id);
          } catch (killErr) {
            observer.recordOperation({
              metric: "lifecycle_poll",
              operation: "lifecycle.backfill.orphan_cleanup_failed",
              outcome: "failure",
              correlationId,
              projectId,
              sessionId: session.id,
              data: {
                prNumber: pr.number,
                error: killErr instanceof Error ? killErr.message : String(killErr),
              },
              level: "warn",
            });
            // Orphan session couldn't be cleaned up — abort backfill rather than leak
            return false;
          }
          // Stop if claim keeps failing — systemic workspace issue (e.g. all PRs CONFLICTING)
          if (consecutiveClaimFailures >= MAX_CONSECUTIVE_CLAIM_FAILURES) {
            observer.recordOperation({
              metric: "lifecycle_poll",
              operation: "lifecycle.backfill.claim_failed_abort",
              outcome: "failure",
              correlationId,
              projectId,
              data: { consecutiveClaimFailures },
              level: "warn",
            });
            return false;
          }
          continue; // try next uncovered PR
        }

        consecutiveSpawnFailures = 0; // both spawn AND claim succeeded

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
        consecutiveSpawnFailures++;
        observer.recordOperation({
          metric: "lifecycle_poll",
          operation: "lifecycle.backfill.spawn_failed",
          outcome: "failure",
          correlationId,
          projectId,
          data: {
            prNumber: pr.number,
            consecutiveSpawnFailures,
            error: spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
          },
          level: "warn",
        });
        // Stop after MAX_CONSECUTIVE_SPAWN_FAILURES — systemic issue (project paused,
        // missing plugin, etc.) will fail every PR identically in this cycle.
        if (consecutiveSpawnFailures >= MAX_CONSECUTIVE_SPAWN_FAILURES) {
          observer.recordOperation({
            metric: "lifecycle_poll",
            operation: "lifecycle.backfill.spawn_failed_abort",
            outcome: "failure",
            correlationId,
            projectId,
            data: { consecutiveSpawnFailures },
            level: "warn",
          });
          return false;
        }
        continue; // try next uncovered PR
      }
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
