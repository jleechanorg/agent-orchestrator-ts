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
  /**
   * Master switch for the three new dedup layers (per-PR time throttle,
   * SHA-stability window, verdict cooldown). When false (the default),
   * only the legacy `updatedAt` and `SHA` dedups apply — preserves
   * pre-existing behaviour for repos that want the old cadence.
   *
   * When true, the three layers below activate with the documented
   * defaults. Set this from a project's agent-orchestrator.yaml to
   * throttle over-firing on rapidly-iterating PRs.
   */
  enablePerPrThrottle?: boolean;
  /** Layer A — min ms between consecutive evals of the same PR. Default 30 min. */
  perPrCooldownMs?: number;
  /** Layer B — wait at least this long after first seeing a new SHA. Default 5 min. */
  shaStabilityWindowMs?: number;
  /** Layer C — skip if last verdict was FAIL and no new review activity. Default true. */
  enableVerdictCooldown?: boolean;
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
// Per-PR checked comments updatedAt dedup — keyed by `${projectId}:${prNumber}`.
// Bounded to avoid unbounded growth in long-running lifecycle workers.
const lastCheckedUpdatedAtByPR = new BoundedMap<string, string>(MAX_SKEPTIC_DEDUP_ENTRIES);

// Layer A — Per-PR time throttle (cooldown between evaluations regardless of SHA).
// Without this, a PR in heavy iteration (e.g. level-up modal work) re-evaluates
// on every commit, eating the project throttle slot and spamming LLM cost.
const lastEvaluatedAtByPR = new BoundedMap<string, number>(MAX_SKEPTIC_DEDUP_ENTRIES);

// Layer B — SHA-stability window. When a new HEAD SHA is observed, record the
// time. If we evaluate before the window elapses, the author is still pushing
// and the verdict will likely be stale within minutes.
const firstSeenNewShaAtByPR = new BoundedMap<string, number>(MAX_SKEPTIC_DEDUP_ENTRIES);

// Layer C — Verdict cooldown. Track last verdict + the non-bot comment count
// observed at evaluation time. If the prior verdict was FAIL and the
// developer hasn't responded (no new review activity), don't re-run.
const lastVerdictByPR = new BoundedMap<string, "PASS" | "FAIL" | "SKIPPED">(MAX_SKEPTIC_DEDUP_ENTRIES);
const lastEvalNonBotCommentCountByPR = new BoundedMap<string, number>(MAX_SKEPTIC_DEDUP_ENTRIES);

const SKEPTIC_CRON_INTERVAL_MS = 10 * 60_000; // 10 minutes
const DEFAULT_MAX_CONCURRENT_SKEPTIC_REVIEWS = 3;
const DEFAULT_SKEPTIC_PER_PR_COOLDOWN_MS = 30 * 60_000; // Layer A default 30 minutes
const DEFAULT_SKEPTIC_SHA_STABILITY_WINDOW_MS = 5 * 60_000; // Layer B default 5 minutes
const DEFAULT_SKEPTIC_VERDICT_COOLDOWN_ENABLED = true;

function normalizePerPrCooldownMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SKEPTIC_PER_PR_COOLDOWN_MS;
  if (!Number.isFinite(value) || value < 0) return DEFAULT_SKEPTIC_PER_PR_COOLDOWN_MS;
  return value;
}

function normalizeShaStabilityWindowMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SKEPTIC_SHA_STABILITY_WINDOW_MS;
  if (!Number.isFinite(value) || value < 0) return DEFAULT_SKEPTIC_SHA_STABILITY_WINDOW_MS;
  return value;
}

/** Marker regex for our own verdict and trigger comments — these count as
 * "skeptic noise", not "developer review activity", and must be excluded
 * from the Layer C verdict-cooldown baseline. Without this, a posted verdict
 * is itself non-bot and would be misread as new activity, defeating the
 * cooldown. */
const SKEPTIC_NOISE_MARKER_RE = /<!--\s*skeptic-(?:agent-verdict|cron-trigger|gate)[\w-]*\s*-->/i;

/** A best-effort filter that excludes our own verdict comments from the count
 * used by the Layer C verdict-cooldown check. Returns the count of comments
 * whose author is not a known bot (heuristic: login ends with `[bot]` or
 * user.type === "Bot") AND whose body does not contain a skeptic-noise
 * marker (verdict/trigger/gate comment posted by us). Defensive — falls
 * back to total count when type is missing. */
function countNonBotComments(
  comments: ReadonlyArray<{ body?: string; user?: { login: string; type?: string | null } | null }>,
): number {
  let n = 0;
  for (const c of comments) {
    const login = c.user?.login ?? "";
    const isBot =
      login.endsWith("[bot]") || c.user?.type === "Bot";
    if (isBot) continue;
    const body = c.body ?? "";
    if (SKEPTIC_NOISE_MARKER_RE.test(body)) continue;
    n += 1;
  }
  return n;
}

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
  lastCheckedUpdatedAtByPR.clear();
  lastEvaluatedAtByPR.clear();
  firstSeenNewShaAtByPR.clear();
  lastVerdictByPR.clear();
  lastEvalNonBotCommentCountByPR.clear();
}

/** Returns the stored last-evaluated timestamp for a PR — exposed for testing only. */
export function _getLastEvaluatedAt(projectId: string, prNumber: number): number | undefined {
  return lastEvaluatedAtByPR.get(`${projectId}:${prNumber}`);
}

/** Returns the stored last verdict for a PR — exposed for testing only. */
export function _getLastVerdict(projectId: string, prNumber: number):
  "PASS" | "FAIL" | "SKIPPED" | undefined {
  return lastVerdictByPR.get(`${projectId}:${prNumber}`);
}

/** Sets the first-seen-new-SHA timestamp for a PR — exposed for testing only. */
export function _setFirstSeenNewShaAt(
  projectId: string,
  prNumber: number,
  ts: number,
): void {
  firstSeenNewShaAtByPR.set(`${projectId}:${prNumber}`, ts);
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

    // 1. If PR's updatedAt matches our last checked updatedAt, we know nothing changed (no comments, commits, etc.)
    if (pr.updatedAt && lastCheckedUpdatedAtByPR.get(cacheKey) === pr.updatedAt) {
      return false;
    }

    let headSha: string | undefined;
    try {
      headSha = await scm?.getPRHeadSha?.(pr);
    } catch {
      // getPRHeadSha unavailable or threw — fail open, evaluate normally
    }

    // 2. Fetch comments and check for a trigger comment (required for both recent and stale PRs)
    let fetchedComments: Array<{ body: string; user?: { login: string; type?: string | null } }> | null = null;
    if (scm?.listPRComments) {
      try {
        const comments = await scm.listPRComments(pr);
        fetchedComments = comments as Array<{ body: string; user?: { login: string; type?: string | null } }>;
        if (!hasValidTriggerComment(comments)) {
          // No trigger comment, so it's safe to cache the updatedAt so we don't check comments again
          if (pr.updatedAt) {
            lastCheckedUpdatedAtByPR.set(cacheKey, pr.updatedAt);
          }
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
      // Fallback: if scm.listPRComments is missing, fall back to the 24-hour PR age check
      if (pr.updatedAt) {
        const updatedAtMs = Date.parse(pr.updatedAt);
        if (Number.isFinite(updatedAtMs)) {
          const ageMs = Date.now() - updatedAtMs;
          const oneDayMs = 24 * 60 * 60 * 1000;
          if (ageMs > oneDayMs) {
            // Older than 24h, skip
            lastCheckedUpdatedAtByPR.set(cacheKey, pr.updatedAt);
            return false;
          }
        }
      }
    }

    // 3. If already successfully evaluated for this HEAD SHA, skip entirely
    // Enforce SHA cache even with trigger to prevent infinite re-evaluation loops (per design)
    if (headSha && lastEvaluatedShaByPR.get(cacheKey) === headSha) {
      // Also cache this updatedAt so we skip next time immediately
      if (pr.updatedAt) {
        lastCheckedUpdatedAtByPR.set(cacheKey, pr.updatedAt);
      }
      try { observer.recordOperation({ metric: "lifecycle_poll", operation: "skeptic.cron.sha_dedup_skip", outcome: "success", correlationId, projectId, data: { prNumber: pr.number, headSha }, level: "info" }); } catch { /* observer throw must not poison Promise.allSettled batch */ }
      return false;
    }

    // ----------------------------------------------------------------
    // 4-6. Three additional dedup layers to prevent over-firing on a
    //      rapidly-iterating PR (e.g. level-up modal work where a single
    //      PR can re-trigger skeptic every 14-58 minutes on a new SHA).
    //      Gated behind `enablePerPrThrottle` so the legacy cadence is
    //      preserved for repos that have not opted in.
    // ----------------------------------------------------------------
    if (params.enablePerPrThrottle) {
      const perPrCooldownMs = normalizePerPrCooldownMs(params.perPrCooldownMs);
      const shaStabilityWindowMs = normalizeShaStabilityWindowMs(params.shaStabilityWindowMs);
      const verdictCooldownEnabled = params.enableVerdictCooldown ?? DEFAULT_SKEPTIC_VERDICT_COOLDOWN_ENABLED;

    // 4. Layer A — Per-PR time throttle. Even if the SHA changed, do not
    //    re-evaluate the same PR within `perPrCooldownMs` of the last eval.
    //    The 10-min project throttle alone is too coarse when a single PR
    //    is in rapid iteration — it eats the slot for all other PRs in
    //    the project and produces a verdict every cron cycle on a new SHA.
    //    IMPORTANT: do NOT stamp `lastCheckedUpdatedAtByPR` here — doing so
    //    would arm Step 1's "nothing changed" check on the next poll and
    //    short-circuit the cron before the throttle layers can re-evaluate.
    //    The throttle's own state (lastEvaluatedAtByPR) is sufficient.
    const lastEvalAt = lastEvaluatedAtByPR.get(cacheKey);
    if (lastEvalAt !== undefined && now - lastEvalAt < perPrCooldownMs) {
      try { observer.recordOperation({ metric: "lifecycle_poll", operation: "skeptic.cron.per_pr_cooldown_skip", outcome: "success", correlationId, projectId, data: { prNumber: pr.number, headSha: headSha ?? null, msSinceLastEval: now - lastEvalAt, perPrCooldownMs }, level: "info" }); } catch { /* observer throw must not poison Promise.allSettled batch */ }
      return false;
    }

    // 5. Layer B — SHA-stability window. The first time we observe a new
    //    SHA, stamp the time. If the author is still actively pushing, the
    //    SHA will keep changing and we should wait for them to settle
    //    before spending LLM budget on what is likely a transient state.
    //    IMPORTANT: do NOT stamp `lastCheckedUpdatedAtByPR` on skip — see
    //    the Layer A note. The first-seen entry is left in place across
    //    cycles; if the window has elapsed the next pass falls through
    //    to Layer C / evaluation without re-stamping.
    if (headSha) {
      const cachedSha = lastEvaluatedShaByPR.get(cacheKey);
      if (cachedSha !== headSha) {
        const existingFirstSeen = firstSeenNewShaAtByPR.get(cacheKey);
        if (existingFirstSeen === undefined) {
          // First time we observe this SHA — record and skip this cycle
          // so the next cycle can decide if the author is still pushing.
          firstSeenNewShaAtByPR.set(cacheKey, now);
          try { observer.recordOperation({ metric: "lifecycle_poll", operation: "skeptic.cron.sha_first_seen", outcome: "success", correlationId, projectId, data: { prNumber: pr.number, headSha, shaStabilityWindowMs }, level: "info" }); } catch { /* observer throw must not poison Promise.allSettled batch */ }
          return false;
        }
        if (now - existingFirstSeen < shaStabilityWindowMs) {
          // Still inside the stability window — author may be still pushing.
          try { observer.recordOperation({ metric: "lifecycle_poll", operation: "skeptic.cron.sha_stability_skip", outcome: "success", correlationId, projectId, data: { prNumber: pr.number, headSha, msSinceFirstSeen: now - existingFirstSeen, shaStabilityWindowMs }, level: "info" }); } catch { /* observer throw must not poison Promise.allSettled batch */ }
          return false;
        }
        // Stability window elapsed — fall through to Layer C / evaluation.
        // Do NOT clear firstSeenNewShaAtByPR here: if Layer C then skips,
        // clearing would make the next poll re-stamp first-seen for the
        // same HEAD SHA, adding a needless stability wait.
      }
    }

    // 6. Layer C — Verdict cooldown. If the prior verdict was FAIL and
    //    the developer hasn't added any new review activity since, the
    //    next evaluation is very likely to FAIL the same way. Skip until
    //    they respond. (A PASS verdict is reset; we re-evaluate to
    //    detect regressions caused by a new push.)
    //    IMPORTANT: do NOT stamp `lastCheckedUpdatedAtByPR` here — see
    //    the Layer A note. countNonBotComments() now excludes our own
    //    verdict and trigger comments (SKEPTIC_NOISE_MARKER_RE) so the
    //    verdict does not look like new developer activity.
    if (verdictCooldownEnabled && fetchedComments !== null) {
      const lastVerdict = lastVerdictByPR.get(cacheKey);
      if (lastVerdict === "FAIL") {
        const currentNonBotCount = countNonBotComments(fetchedComments);
        const lastNonBotCount = lastEvalNonBotCommentCountByPR.get(cacheKey) ?? 0;
        if (currentNonBotCount <= lastNonBotCount) {
          try { observer.recordOperation({ metric: "lifecycle_poll", operation: "skeptic.cron.verdict_cooldown_skip", outcome: "success", correlationId, projectId, data: { prNumber: pr.number, headSha: headSha ?? null, currentNonBotCount, lastNonBotCount }, level: "info" }); } catch { /* observer throw must not poison Promise.allSettled batch */ }
          return false;
        }
      }
    }
    } // end if (params.enablePerPrThrottle)

    // Use existing session if available, otherwise synthetic
    const session =
      sessionByPR.get(`${projectId}:${pr.number}`) ??
      createSyntheticSession(pr, projectId, project.path ?? null);

    try {
      try { observer.recordOperation({ metric: "lifecycle_poll", operation: "skeptic.cron.evaluating", outcome: "success", correlationId, projectId, data: { prNumber: pr.number, hasSession: sessionByPR.has(`${projectId}:${pr.number}`) }, level: "info" }); } catch { /* observer throw must not poison Promise.allSettled batch */ }

      const result = await runSkepticReview(session, { postComment: true });

      try { observer.recordOperation({ metric: "lifecycle_poll", operation: "skeptic.cron.evaluated", outcome: result.verdict === "PASS" ? "success" : "failure", correlationId, projectId, data: { prNumber: pr.number, verdict: result.verdict, modelUsed: result.modelUsed }, level: result.verdict === "FAIL" ? "warn" : "info" }); } catch { /* observer throw must not poison Promise.allSettled batch */ }

      if (headSha) lastEvaluatedShaByPR.set(cacheKey, headSha);
      if (pr.updatedAt) lastCheckedUpdatedAtByPR.set(cacheKey, pr.updatedAt);
      // Layers A/B/C: record timestamp + verdict + non-bot comment count
      // for the next dedup check. Gated on enablePerPrThrottle so the
      // legacy cadence is preserved when throttling is not opted in.
      // The `countNonBotComments()` helper excludes the verdict and trigger
      // comments via SKEPTIC_NOISE_MARKER_RE, so the next pass's
      // `currentNonBotCount <= lastNonBotCount` check correctly handles the
      // posted verdict without needing a separate bump.
      if (params.enablePerPrThrottle) {
        lastEvaluatedAtByPR.set(cacheKey, now);
        lastVerdictByPR.set(cacheKey, result.verdict);
        if (fetchedComments !== null) {
          lastEvalNonBotCommentCountByPR.set(cacheKey, countNonBotComments(fetchedComments));
        }
      }
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
