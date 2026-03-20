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
import { updateMetadata } from "./metadata.js";
import { getSessionsDir } from "./paths.js";

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
  ) => Promise<ReactionResult>;
}

function makeFingerprint(ids: string[]): string {
  return [...ids].sort().join(",");
}

function updateSessionMetadata(
  session: Session,
  updates: Partial<Record<string, string>>,
  config: OrchestratorConfig,
): void {
  const project = config.projects[session.projectId];
  if (!project) return;

  const sessionsDir = getSessionsDir(config.configPath, project.path);
  updateMetadata(sessionsDir, session.id, updates);

  const cleaned = Object.fromEntries(
    Object.entries(session.metadata).filter(([key]) => {
      const update = updates[key];
      return update === undefined || update !== "";
    }),
  );
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === "") continue;
    cleaned[key] = value;
  }
  session.metadata = cleaned;
}

/**
 * Dispatch review reactions when the set of pending comments changes.
 * Called after each session check in the lifecycle polling loop.
 */
export async function maybeDispatchReviewBacklog(
  session: Session,
  oldStatus: SessionStatus,
  newStatus: SessionStatus,
  deps: ReviewBacklogDeps,
  transitionReaction?: { key: string; result: ReactionResult | null },
): Promise<void> {
  const { config, registry, clearReactionTracker, getReactionConfigForSession, executeReaction } =
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
    updateSessionMetadata(
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
    return;
  }

  const [pendingResult, automatedResult] = await Promise.allSettled([
    scm.getPendingComments(session.pr),
    scm.getAutomatedComments(session.pr),
  ]);

  // null means "failed to fetch" — preserve existing metadata.
  // [] means "confirmed no comments" — safe to clear.
  const pendingComments =
    pendingResult.status === "fulfilled" && Array.isArray(pendingResult.value)
      ? pendingResult.value
      : null;
  const automatedComments =
    automatedResult.status === "fulfilled" && Array.isArray(automatedResult.value)
      ? automatedResult.value
      : null;

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
      updateSessionMetadata(
        session,
        { lastPendingReviewFingerprint: pendingFingerprint },
        config,
      );
    }

    if (!pendingFingerprint) {
      clearReactionTracker(session.id, humanReactionKey);
      updateSessionMetadata(
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
        updateSessionMetadata(
          session,
          {
            lastPendingReviewDispatchHash: pendingFingerprint,
            lastPendingReviewDispatchAt: new Date().toISOString(),
          },
          config,
        );
      }
    } else if (
      !(oldStatus !== newStatus && newStatus === "changes_requested") &&
      pendingFingerprint !== lastPendingDispatchHash
    ) {
      const reactionConfig = getReactionConfigForSession(session, humanReactionKey);
      if (
        reactionConfig &&
        reactionConfig.action &&
        (reactionConfig.auto !== false || reactionConfig.action === "notify")
      ) {
        const result = await executeReaction(
          session.id,
          session.projectId,
          humanReactionKey,
          reactionConfig,
          session,
        );
        if (result.success) {
          updateSessionMetadata(
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
      updateSessionMetadata(
        session,
        { lastAutomatedReviewFingerprint: automatedFingerprint },
        config,
      );
    }

    if (!automatedFingerprint) {
      clearReactionTracker(session.id, automatedReactionKey);
      updateSessionMetadata(
        session,
        {
          lastAutomatedReviewFingerprint: "",
          lastAutomatedReviewDispatchHash: "",
          lastAutomatedReviewDispatchAt: "",
        },
        config,
      );
    } else if (automatedFingerprint !== lastAutomatedDispatchHash) {
      const reactionConfig = getReactionConfigForSession(session, automatedReactionKey);
      if (
        reactionConfig &&
        reactionConfig.action &&
        (reactionConfig.auto !== false || reactionConfig.action === "notify")
      ) {
        const result = await executeReaction(
          session.id,
          session.projectId,
          automatedReactionKey,
          reactionConfig,
          session,
        );
        if (result.success) {
          updateSessionMetadata(
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
