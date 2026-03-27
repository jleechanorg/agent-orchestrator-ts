/**
 * Review backlog dispatch — fingerprint-based dedup for review comments.
 * Extracted from lifecycle-manager.ts for upstream isolation.
 *
 * Tracks pending human and automated review comments by fingerprint,
 * dispatching reactions only when the set of comments changes.
 */

import type {
  Session,
  SessionStatus,
  SessionId,
  SCM,
  OrchestratorConfig,
  PluginRegistry,
  ReactionConfig,
  ReactionResult,
} from "./types.js";
import { updateSessionMetadataHelper } from "./fork-utils.js";

export interface ReviewBacklogDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  clearReactionTracker: (sessionId: SessionId, reactionKey: string) => void;
  getReactionConfigForSession: (session: Session, reactionKey: string) => ReactionConfig | null;
  executeReaction: (
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
    session?: Session,
    correlationId?: string,
    agentDead?: boolean,
  ) => Promise<ReactionResult>;
  /** Whether the agent is confirmed dead — skips send-to-agent backlog dispatches (bd-5o1) */
  agentDead: boolean;
}

function makeFingerprint(ids: string[]): string {
  return [...ids].sort().join(",");
}

// bd-yjo: Per-session poll counter for throttling review backlog checks.
// Only run full API check every REVIEW_BACKLOG_INTERVAL polls (always on transitions).
const pollCounters = new Map<string, number>();
const REVIEW_BACKLOG_INTERVAL = 3;

/** Reset poll counter for a session. Exported for testing. */
export function resetReviewBacklogCounter(sessionId: string): void {
  pollCounters.delete(sessionId);
}

/** Reset all poll counters. Exported for testing. */
export function resetAllReviewBacklogCounters(): void {
  pollCounters.clear();
}

/**
 * Dispatch review reactions when the set of pending comments changes.
 * Called after each session check in the lifecycle polling loop.
 *
 * bd-yjo: Throttled to run every REVIEW_BACKLOG_INTERVAL polls to reduce API calls.
 * Always runs on status transitions (oldStatus !== newStatus).
 */
export async function maybeDispatchReviewBacklog(
  session: Session,
  oldStatus: SessionStatus,
  newStatus: SessionStatus,
  deps: ReviewBacklogDeps,
  transitionReaction?: { key: string; result: ReactionResult | null },
): Promise<void> {
  const { config, registry, clearReactionTracker, getReactionConfigForSession, executeReaction, agentDead } =
    deps;

  const project = config.projects[session.projectId];
  if (!project || !session.pr) return;

  const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
  if (!scm) return;

  const humanReactionKey = "changes-requested";
  const automatedReactionKey = "bugbot-comments";

  if (newStatus === "merged" || newStatus === "killed") {
    clearReactionTracker(session.id, humanReactionKey);
    clearReactionTracker(session.id, automatedReactionKey);
    updateSessionMetadataHelper(
      session,
      {
        lastPendingReviewFingerprint: "",
        lastPendingReviewDispatchHash: "",
        lastPendingReviewDispatchAt: "",
        lastAutomatedReviewFingerprint: "",
        lastAutomatedReviewDispatchHash: "",
        lastAutomatedReviewDispatchAt: "",
      },
      config,
    );
    pollCounters.delete(session.id);
    return;
  }

  // bd-yjo: Throttle — skip the expensive SCM API calls every Nth poll or on transitions.
  // Fingerprint dispatch is also throttled so the reaction retry/escalateAfter logic
  // advances at the same cadence as the fetches (avoids dispatching on stale fingerprints).
  const isTransition = oldStatus !== newStatus;
  const count = (pollCounters.get(session.id) ?? 0) + 1;
  pollCounters.set(session.id, count);
  const shouldThrottle = !isTransition && count % REVIEW_BACKLOG_INTERVAL !== 1;

  // bd-4nz: Skip automated comment polling when configured (saves 1+ REST calls/session)
  const skipAutomated = project.scm?.skipAutomatedCommentPolling === true;

  let pendingComments: Awaited<ReturnType<typeof scm.getPendingComments>> | null = null;
  let automatedComments: Awaited<ReturnType<typeof scm.getAutomatedComments>> | null = null;
  // bd-xxx: Gate changes-requested dispatch on CR's latest verdict so we don't re-alert
  // on unresolved suggestions after CR moves to COMMENTED (not a formal CHANGES_REQUESTED verdict).
  let crLatestVerdict: string | null = null;
  // Track whether any human posted CHANGES_REQUESTED after CR's latest verdict
  let newerHumanCR = false;

  if (!shouldThrottle) {
    const [pendingResult, automatedResult, reviewsResult] = await Promise.allSettled([
      scm.getPendingComments(session.pr),
      skipAutomated ? Promise.resolve(null) : scm.getAutomatedComments(session.pr),
      scm.getReviews(session.pr),
    ]);

    // null means "failed to fetch" — preserve existing metadata.
    // [] means "confirmed no comments" — safe to clear.
    pendingComments =
      pendingResult.status === "fulfilled" && Array.isArray(pendingResult.value)
        ? pendingResult.value
        : null;
    automatedComments =
      automatedResult.status === "fulfilled" && Array.isArray(automatedResult.value)
        ? automatedResult.value
        : null;

    // bd-xxx: Extract CR's latest review verdict to gate changes-requested dispatch.
    // Fail open (null = don't know) so we don't suppress legitimate alerts during transient
    // API errors.
    if (reviewsResult.status === "fulfilled" && Array.isArray(reviewsResult.value)) {
      // getReviews returns Review[] with flat author: string (not author.login)
      const allReviews = reviewsResult.value;
      const crReviews = allReviews.filter((r) => String(r.author ?? "").endsWith("coderabbitai[bot]"));
      const latestCRReview = crReviews[crReviews.length - 1];
      crLatestVerdict = latestCRReview?.state ?? null;

      // Allow dispatch if a human posted CHANGES_REQUESTED after CR's latest verdict
      const latestCRIndex = latestCRReview
        ? allReviews.findIndex((r) => r === latestCRReview)
        : -1;
      newerHumanCR = allReviews.slice(latestCRIndex + 1).some(
        (r) => r.state === "changes_requested" && !String(r.author ?? "").endsWith("coderabbitai[bot]"),
      );
    }
  }

  // --- Pending (human) review comments ---
  if (pendingComments !== null) {
    const pendingFingerprint = makeFingerprint(pendingComments.map((comment) => comment.id));
    const lastPendingFingerprint = session.metadata["lastPendingReviewFingerprint"] ?? "";
    const lastPendingDispatchHash = session.metadata["lastPendingReviewDispatchHash"] ?? "";

    if (
      pendingFingerprint !== lastPendingFingerprint &&
      transitionReaction?.key !== humanReactionKey
    ) {
      clearReactionTracker(session.id, humanReactionKey);
    }
    if (pendingFingerprint !== lastPendingFingerprint) {
      updateSessionMetadataHelper(
        session,
        { lastPendingReviewFingerprint: pendingFingerprint },
        config,
      );
    }

    if (!pendingFingerprint) {
      clearReactionTracker(session.id, humanReactionKey);
      updateSessionMetadataHelper(
        session,
        {
          lastPendingReviewFingerprint: "",
          lastPendingReviewDispatchHash: "",
          lastPendingReviewDispatchAt: "",
        },
        config,
      );
    } else if (
      transitionReaction?.key === humanReactionKey &&
      transitionReaction.result?.success
    ) {
      if (lastPendingDispatchHash !== pendingFingerprint) {
        updateSessionMetadataHelper(
          session,
          {
            lastPendingReviewDispatchHash: pendingFingerprint,
            lastPendingReviewDispatchAt: new Date().toISOString(),
          },
          config,
        );
      }
    } else if (
      !shouldThrottle &&
      !(oldStatus !== newStatus && newStatus === "changes_requested") &&
      pendingFingerprint !== lastPendingDispatchHash &&
      // bd-xxx: only re-alert on pending comments when verdict is not COMMENTED/DISMISSED
      // (including CHANGES_REQUESTED, null, or any other state), OR when a human reviewer
      // posted CHANGES_REQUESTED after CR's latest verdict. This ensures we never suppress
      // dispatch when verdict is null (fail open for API errors), and we always allow
      // dispatch for CHANGES_REQUESTED or newer human CR. Only COMMENTED/DISMISSED with
      // no newer human CR is suppressed.
      // SCM normalizes GitHub API values: "CHANGES_REQUESTED" → "changes_requested" (scm-github getReviews).
      (crLatestVerdict === null || crLatestVerdict !== "commented" && crLatestVerdict !== "dismissed" || newerHumanCR)
    ) {
      const reactionConfig = getReactionConfigForSession(session, humanReactionKey);
      // bd-5o1: skip send-to-agent for dead agents. respawn-for-review is always
      // allowed from the backlog — the fingerprint guard (lastPendingDispatchHash)
      // prevents same-cycle duplicates, and the retry path needs backlog to re-attempt
      // if a spawn fails.
      const skipForDead = agentDead && reactionConfig?.action === "send-to-agent";
      if (
        reactionConfig &&
        reactionConfig.action &&
        (reactionConfig.auto !== false || reactionConfig.action === "notify") &&
        !skipForDead
      ) {
        const result = await executeReaction(
          session.id,
          session.projectId,
          humanReactionKey,
          reactionConfig,
          session,
          undefined,
          agentDead,
        );
        if (result.success) {
          updateSessionMetadataHelper(
            session,
            {
              lastPendingReviewDispatchHash: pendingFingerprint,
              lastPendingReviewDispatchAt: new Date().toISOString(),
            },
            config,
          );
        }
      }
    }
  }

  // --- Automated (bot) review comments ---
  if (automatedComments !== null) {
    const automatedFingerprint = makeFingerprint(automatedComments.map((comment) => comment.id));
    const lastAutomatedFingerprint = session.metadata["lastAutomatedReviewFingerprint"] ?? "";
    const lastAutomatedDispatchHash = session.metadata["lastAutomatedReviewDispatchHash"] ?? "";

    if (automatedFingerprint !== lastAutomatedFingerprint) {
      clearReactionTracker(session.id, automatedReactionKey);
      updateSessionMetadataHelper(
        session,
        { lastAutomatedReviewFingerprint: automatedFingerprint },
        config,
      );
    }

    if (!automatedFingerprint) {
      clearReactionTracker(session.id, automatedReactionKey);
      updateSessionMetadataHelper(
        session,
        {
          lastAutomatedReviewFingerprint: "",
          lastAutomatedReviewDispatchHash: "",
          lastAutomatedReviewDispatchAt: "",
        },
        config,
      );
    } else if (!shouldThrottle && automatedFingerprint !== lastAutomatedDispatchHash) {
      const reactionConfig = getReactionConfigForSession(session, automatedReactionKey);
      // bd-5o1: skip send-to-agent for dead agents (automated path)
      const skipForDead = agentDead && reactionConfig?.action === "send-to-agent";
      if (
        reactionConfig &&
        reactionConfig.action &&
        (reactionConfig.auto !== false || reactionConfig.action === "notify") &&
        !skipForDead
      ) {
        const result = await executeReaction(
          session.id,
          session.projectId,
          automatedReactionKey,
          reactionConfig,
          session,
          undefined,
          agentDead,
        );
        if (result.success) {
          updateSessionMetadataHelper(
            session,
            {
              lastAutomatedReviewDispatchHash: automatedFingerprint,
              lastAutomatedReviewDispatchAt: new Date().toISOString(),
            },
            config,
          );
        }
      }
    }
  }
}
