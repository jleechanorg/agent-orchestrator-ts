/**
 * Local skeptic cron — runs skeptic evaluation for open PRs from the lifecycle-worker.
 *
 * This replaces the broken GHA-based skeptic execution. Both skeptic-gate.yml and
 * skeptic-cron.yml tried to run `ao skeptic verify` in GitHub Actions where no
 * Codex/Claude API keys exist. This module runs the same evaluation locally on
 * the lifecycle-worker's machine where LLM tools are available.
 *
 * Called from the lifecycle-manager poll loop, throttled to run every 10 minutes.
 * For each open PR (non-draft), runs `runSkepticReview()` which calls `ao skeptic verify --pr N`.
 * Prefers an existing active session for the PR when available (provides workspacePath for
 * report writing); falls back to a synthetic session otherwise. Per-project isolation is
 * enforced by keying the throttle map and session map by projectId.
 *
 * @module skeptic-cron-local
 */

import type {
  PluginRegistry,
  SessionManager,
  Session,
  SCM,
  PRInfo,
  ProjectConfig,
} from "./types.js";
import type { ProjectObserver } from "./observability.js";
import { runSkepticReview } from "./skeptic-reviewer.js";

export interface SkepticCronDeps {
  registry: PluginRegistry;
  sessionManager: SessionManager;
  observer: ProjectObserver;
}

export interface SkepticCronParams {
  projectId: string;
  project: ProjectConfig;
  activeSessions: Session[];
  correlationId: string;
}

// Per-project throttle state — keyed by projectId so multi-project configs
// don't starve secondary projects when the first one claims the global timer.
const lastSkepticCronTimeByProject = new Map<string, number>();
// Guards against concurrent fire-and-forget calls for the same project.
// Without this, two overlapping calls could both pass the throttle check
// before either sets lastSkepticCronTimeByProject, bypassing the interval.
const pendingSkepticCronByProject = new Set<string>();
const SKEPTIC_CRON_INTERVAL_MS = 10 * 60_000; // 10 minutes

/** Reset throttle state — exposed for testing only. */
export function _resetSkepticCronTimer(): void {
  lastSkepticCronTimeByProject.clear();
  pendingSkepticCronByProject.clear();
}

/**
 * Create a minimal synthetic Session for PRs that have no active AO session.
 * Only the fields used by `runSkepticReview()` need real values.
 */
function createSyntheticSession(
  pr: PRInfo,
  projectId: string,
  workspacePath: string | null,
): Session {
  return {
    id: `skeptic-cron-pr-${pr.number}`,
    projectId,
    status: "working",
    activity: null,
    branch: pr.branch ?? null,
    issueId: null,
    pr,
    workspacePath,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: { source: "skeptic-cron-local" },
  };
}

/**
 * Run skeptic evaluation for all open PRs that need it.
 *
 * Throttled to run at most once per SKEPTIC_CRON_INTERVAL_MS.
 * Evaluations run sequentially to avoid overwhelming the system.
 *
 * @returns Number of PRs evaluated
 */
export async function runLocalSkepticCron(
  deps: SkepticCronDeps,
  params: SkepticCronParams,
): Promise<number> {
  const now = Date.now();
  const { projectId, project, activeSessions, correlationId } = params;

  // Guard: skip if already pending for this project (prevents TOCTOU race with
  // fire-and-forget callers where concurrent calls can both pass throttle check)
  if (pendingSkepticCronByProject.has(projectId)) return 0;
  pendingSkepticCronByProject.add(projectId);

  try {
    const lastRun = lastSkepticCronTimeByProject.get(projectId) ?? 0;
    if (now - lastRun < SKEPTIC_CRON_INTERVAL_MS) return 0;

    const { registry, observer } = deps;

    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
    if (!scm?.listOpenPRs) return 0;

    let openPRs: PRInfo[];
    try {
      openPRs = await scm.listOpenPRs(project);
    } catch (err) {
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "skeptic.cron.list_prs_failed",
        outcome: "failure",
        correlationId,
        projectId,
        data: { error: err instanceof Error ? err.message : String(err) },
        level: "warn",
      });
      // Do NOT set throttle on failure — allow retry on next poll cycle
      return 0;
    }

    // Set throttle AFTER successful listOpenPRs — transient failures don't suppress retries
    lastSkepticCronTimeByProject.set(projectId, now);

    if (openPRs.length === 0) return 0;

  // Build a map of (projectId, prNumber) → active session (prefer sessions that
  // already have the PR linked, as they have workspacePath for report writing).
  // Key by projectId too — PR numbers can collide across projects.
  const sessionByPR = new Map<string, Session>();
  for (const s of activeSessions) {
    if (s.pr?.number) {
      sessionByPR.set(`${s.projectId}:${s.pr.number}`, s);
    }
  }

  let evaluated = 0;

  for (const pr of openPRs) {
    if (pr.isDraft) continue;

    // Use existing session if available, otherwise synthetic
    const session = sessionByPR.get(`${projectId}:${pr.number}`)
      ?? createSyntheticSession(pr, projectId, project.path ?? null);

    try {
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "skeptic.cron.evaluating",
        outcome: "success",
        correlationId,
        projectId,
        data: { prNumber: pr.number, hasSession: sessionByPR.has(`${projectId}:${pr.number}`) },
        level: "info",
      });

      const result = await runSkepticReview(session, {
        // Default model; runSkepticReview → ao skeptic verify handles fallback chain
        postComment: true,
      });

      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "skeptic.cron.evaluated",
        outcome: result.verdict === "PASS" ? "success" : "failure",
        correlationId,
        projectId,
        data: {
          prNumber: pr.number,
          verdict: result.verdict,
          modelUsed: result.modelUsed,
        },
        level: result.verdict === "FAIL" ? "warn" : "info",
      });

      evaluated++;
    } catch (err) {
      // One PR failure must not block all other PRs
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "skeptic.cron.pr_failed",
        outcome: "failure",
        correlationId,
        projectId,
        data: {
          prNumber: pr.number,
          error: err instanceof Error ? err.message : String(err),
        },
        level: "warn",
      });
    }
  }

  if (evaluated > 0) {
    console.log(`[skeptic-cron] evaluated ${evaluated}/${openPRs.length} open PRs`);
  }

  return evaluated;
  } finally {
    pendingSkepticCronByProject.delete(projectId);
  }
}
