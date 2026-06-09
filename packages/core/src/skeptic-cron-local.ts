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
  /** Max parallel `ao skeptic verify` calls per project. Defaults to 3. */
  maxConcurrentSkepticReviews?: number;
}

// Per-project throttle state — keyed by projectId so multi-project configs
// don't starve secondary projects when the first one claims the global timer.
const lastSkepticCronTimeByProject = new Map<string, number>();
// Guards against concurrent fire-and-forget calls for the same project.
// Without this, two overlapping calls could both pass the throttle check
// before either sets lastSkepticCronTimeByProject, bypassing the interval.
const pendingSkepticCronByProject = new Set<string>();

/** Simple bounded Map that evicts the oldest entry when max capacity is reached. */
class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly maxSize: number) {
    super();
  }

  override set(key: K, value: V): this {
    // Only evict when inserting a new key and we've reached capacity.
    if (!this.has(key) && this.size >= this.maxSize) {
      const firstKey = this.keys().next().value as K | undefined;
      if (firstKey !== undefined) {
        this.delete(firstKey);
      }
    }
    return super.set(key, value);
  }
}

// Per-PR SHA dedup — keyed by `${projectId}:${prNumber}`.
// Skips re-evaluation when HEAD SHA hasn't changed since last verdict.
// Bounded to avoid unbounded growth in long-running lifecycle workers.
const MAX_SKEPTIC_DEDUP_ENTRIES = 10_000;
const lastEvaluatedShaByPR = new BoundedMap<string, string>(MAX_SKEPTIC_DEDUP_ENTRIES);
// Per-PR checked comments SHA dedup — keyed by `${projectId}:${prNumber}`.
// Bounded to avoid unbounded growth in long-running lifecycle workers.
const lastCheckedCommentsShaByPR = new BoundedMap<string, string>(MAX_SKEPTIC_DEDUP_ENTRIES);
const SKEPTIC_CRON_INTERVAL_MS = 10 * 60_000; // 10 minutes
const DEFAULT_MAX_CONCURRENT_SKEPTIC_REVIEWS = 3;

function normalizeMaxConcurrentSkepticReviews(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_CONCURRENT_SKEPTIC_REVIEWS;
  if (!Number.isFinite(value) || value < 0) return DEFAULT_MAX_CONCURRENT_SKEPTIC_REVIEWS;
  return Math.max(1, Math.trunc(value));
}

function hasValidTriggerComment(
  comments: Array<{
    body: string;
    user?: { login: string };
    /**
     * Structured signal set by the SCM plugin. Application code MUST NOT
     * re-parse the comment body — heuristic keyword routing in app code
     * violates the ZFC coding guideline. If a comment does not arrive with
     * `isSkepticTrigger: true`, it is not a trigger.
     */
    isSkepticTrigger?: boolean;
  }>,
): boolean {
  for (const c of comments) {
    if (c.isSkepticTrigger === true) {
      return true;
    }
  }
  return false;
}

/** Reset throttle + pending state — exposed for testing only. */
export function _resetSkepticCronTimer(): void {
  lastSkepticCronTimeByProject.clear();
  pendingSkepticCronByProject.clear();
}

/** Reset SHA dedup map — exposed for testing only. */
export function _resetSkepticDedupMap(): void {
  lastEvaluatedShaByPR.clear();
  lastCheckedCommentsShaByPR.clear();
}

/** Returns the stored SHA for a PR cache key — exposed for testing only. */
export function _getLastEvaluatedSha(projectId: string, prNumber: number): string | undefined {
  return lastEvaluatedShaByPR.get(`${projectId}:${prNumber}`);
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
 * Evaluations run in bounded batches (default max 3 concurrent) per project
 * to avoid overwhelming the LLM provider while still parallelizing across PRs.
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
      try {
        observer.recordOperation({
          metric: "lifecycle_poll",
          operation: "skeptic.cron.list_prs_failed",
          outcome: "failure",
          correlationId,
          projectId,
          data: { error: err instanceof Error ? err.message : String(err) },
          level: "warn",
        });
      } catch { /* observer throw must not poison retryable listOpenPRs failure path */ }
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
  const maxConcurrent = normalizeMaxConcurrentSkepticReviews(params.maxConcurrentSkepticReviews);

  /**
   * Evaluate a single PR — all error handling, observer recording, and SHA
   * caching are contained here so the batched Promise.all below stays clean.
   */
  const evaluateOnePR = async (pr: PRInfo): Promise<boolean> => {
    const cacheKey = `${projectId}:${pr.number}`;
    let headSha: string | undefined;
    try {
      headSha = await scm?.getPRHeadSha?.(pr);
    } catch {
      // getPRHeadSha unavailable or threw — fail open, evaluate normally
    }

    // 1. If already successfully evaluated for this HEAD SHA, skip entirely
    if (headSha && lastEvaluatedShaByPR.get(cacheKey) === headSha) {
      try { observer.recordOperation({ metric: "lifecycle_poll", operation: "skeptic.cron.sha_dedup_skip", outcome: "success", correlationId, projectId, data: { prNumber: pr.number, headSha }, level: "info" }); } catch { /* observer throw must not poison Promise.allSettled batch */ }
      return false;
    }

    let isStale = false;
    if (pr.updatedAt) {
      const updatedAtMs = Date.parse(pr.updatedAt);
      if (Number.isFinite(updatedAtMs)) {
        const ageMs = Date.now() - updatedAtMs;
        const oneDayMs = 24 * 60 * 60 * 1000;
        if (ageMs > oneDayMs) {
          isStale = true;
        }
      }
    }

    // 2. If the PR is stale and we already checked comments for this HEAD SHA (finding no trigger), skip comment check
    if (isStale && headSha && lastCheckedCommentsShaByPR.get(cacheKey) === headSha) {
      return false;
    }

    // 3. Fetch comments and check for a trigger comment (required for both recent and stale PRs)
    if (scm?.listPRComments) {
      try {
        const comments = await scm.listPRComments(pr);
        // Cache that we've checked comments for this HEAD SHA
        if (headSha) {
          lastCheckedCommentsShaByPR.set(cacheKey, headSha);
        }
        if (!hasValidTriggerComment(comments)) {
          return false;
        }
      } catch (err) {
        try {
          observer.recordOperation({
            metric: "lifecycle_poll",
            operation: "skeptic.cron.list_pr_comments_failed",
            outcome: "failure",
            correlationId,
            projectId,
            data: { prNumber: pr.number, error: err instanceof Error ? err.message : String(err) },
            level: "warn",
          });
        } catch { /* observer failure must not block cron flow */ }
        return false;
      }
    } else {
      return false;
    }

    // Use existing session if available, otherwise synthetic
    const session =
      sessionByPR.get(`${projectId}:${pr.number}`) ??
      createSyntheticSession(pr, projectId, project.path ?? null);

    try {
      try { observer.recordOperation({ metric: "lifecycle_poll", operation: "skeptic.cron.evaluating", outcome: "success", correlationId, projectId, data: { prNumber: pr.number, hasSession: sessionByPR.has(`${projectId}:${pr.number}`) }, level: "info" }); } catch { /* observer throw must not poison Promise.allSettled batch */ }

      const result = await runSkepticReview(session, { postComment: true });

      try { observer.recordOperation({ metric: "lifecycle_poll", operation: "skeptic.cron.evaluated", outcome: result.verdict === "PASS" ? "success" : "failure", correlationId, projectId, data: { prNumber: pr.number, verdict: result.verdict, modelUsed: result.modelUsed }, level: result.verdict === "FAIL" ? "warn" : "info" }); } catch { /* observer throw must not poison Promise.allSettled batch */ }

      if (headSha) lastEvaluatedShaByPR.set(cacheKey, headSha);
      return true;
    } catch (err) {
      try { observer.recordOperation({ metric: "lifecycle_poll", operation: "skeptic.cron.pr_failed", outcome: "failure", correlationId, projectId, data: { prNumber: pr.number, error: err instanceof Error ? err.message : String(err) }, level: "warn" }); } catch { /* observer throw must not poison Promise.allSettled batch */ }
      return false;
    }
  };

  // Collect eligible PRs (non-draft) in a single pass before running
  const eligiblePRs = openPRs.filter((pr) => !pr.isDraft);

  // Run in bounded batches; Promise.allSettled so one observer throw
  // or rejection does not cancel the rest of the batch.
  for (let i = 0; i < eligiblePRs.length; i += maxConcurrent) {
    const batch = eligiblePRs.slice(i, i + maxConcurrent);
    const settled = await Promise.allSettled(batch.map(evaluateOnePR));
    evaluated += settled.filter(r => r.status === "fulfilled" && r.value === true).length;
  }

  if (evaluated > 0) {
    console.log(`[skeptic-cron] evaluated ${evaluated}/${openPRs.length} open PRs`);
  }

  return evaluated;
  } finally {
    pendingSkepticCronByProject.delete(projectId);
  }
}
