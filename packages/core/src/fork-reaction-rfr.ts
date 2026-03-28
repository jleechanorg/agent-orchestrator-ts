/**
 * fork-reaction-rfr — bd-rfr companion module.
 *
 * Extracts the `respawn-for-review` reaction action from lifecycle-manager.ts
 * into a standalone fork-specific module. This keeps the core lifecycle-manager
 * diff minimal against upstream.
 *
 * When CR posts CHANGES_REQUESTED and the assigned worker is dead/exhausted,
 * this handler spawns a fresh worker targeting the same PR branch with pre-loaded
 * review context. When the agent is alive, it falls back to send-to-agent.
 */

import type {
  SessionId,
  SessionManager,
  OrchestratorConfig,
  PluginRegistry,
  ReactionConfig,
  ReactionResult,
  Session,
  OrchestratorEvent,
  EventPriority,
  EventType,
} from "./types.js";
import { buildReactionContext } from "./reaction-context.js";
import { updateSessionMetadataHelper } from "./fork-utils.js";
import type { ProjectObserver } from "./observability.js";

export interface RespawnForReviewDeps {
  sessionManager: SessionManager;
  config: OrchestratorConfig;
  registry: PluginRegistry;
  notifyHuman: (event: OrchestratorEvent, priority: EventPriority) => Promise<void>;
  createEvent: (
    type: EventType,
    opts: {
      sessionId: SessionId;
      projectId: string;
      message: string;
      priority?: EventPriority;
      data?: Record<string, unknown>;
    },
  ) => OrchestratorEvent;
  observer: ProjectObserver;
}

/**
 * Build the reaction message with review context injected.
 * Shared by both dead-agent (spawn) and alive-agent (send) paths.
 */
async function buildRespawnMessage(
  reactionConfig: ReactionConfig,
  session: Session,
  projectId: string,
  config: OrchestratorConfig,
  registry: PluginRegistry,
  reactionKey: string,
): Promise<string> {
  let message = reactionConfig.message ?? `Fix review comments on PR #${session.pr!.number} and push.`;
  if (reactionConfig.message?.includes("{{context}}") && session) {
    try {
      const context = await buildReactionContext(reactionKey, session, projectId, config, registry);
      message = reactionConfig.message.replace(/\{\{context\}\}/g, () => context);
    } catch (ctxErr) {
      console.warn(
        `[lifecycle-manager] buildReactionContext failed: ${ctxErr instanceof Error ? ctxErr.message : String(ctxErr)} — proceeding without context`,
      );
    }
  }
  return message;
}

/**
 * Handle respawn-for-review reaction.
 *
 * When agent is dead (agentDead !== false):
 *   - Spawn a fresh worker targeting the same PR branch with pre-loaded review context.
 *   - Mark the old session as respawned to prevent unbounded duplicate workers.
 *   - Fail gracefully: if spawn fails, allow retry on next poll cycle.
 *
 * When agent is alive (agentDead === false):
 *   - Fall back to send-to-agent: inject review context and send to live agent.
 *
 * agentDead is optional; undefined is treated as dead (always respawn) — intended
 * for retry dispatch paths where the caller's determineStatus result is unavailable.
 */
export async function handleRespawnForReview(
  sessionId: SessionId,
  projectId: string,
  reactionKey: string,
  reactionConfig: ReactionConfig,
  session: Session,
  agentDead: boolean | undefined,
  correlationId: string,
  deps: RespawnForReviewDeps,
): Promise<ReactionResult> {
  const { sessionManager, config, registry, notifyHuman, createEvent, observer } = deps;
  const action = "respawn-for-review";

  // Track how many times this session has already failed respawn attempts.
  // Used to enforce the escalateAfter threshold.
  const attemptCount = parseInt(String(session.metadata?.["respawn_attempt_count"] ?? "0"), 10);
  const escalateAfter = typeof reactionConfig.escalateAfter === "number"
    ? reactionConfig.escalateAfter
    : Infinity;
  const isLastAttempt = attemptCount >= escalateAfter;

  if (agentDead !== false) {
    // Agent is dead — spawn a fresh worker targeting this PR
    if (!session?.pr) {
      const event = createEvent("reaction.triggered", {
        sessionId,
        projectId,
        message: `Reaction '${reactionKey}' triggered respawn but no PR is associated with this session`,
        data: { reactionKey, action },
      });
      await notifyHuman(event, "warning");
      return { reactionType: reactionKey, success: false, action, escalated: false };
    }

    // Skip if already respawned for this PR (prevents unbounded duplicate workers)
    if (session.metadata?.["pr_respawned"] === "true") {
      return {
        reactionType: reactionKey,
        success: true,
        action: "respawn-for-review",
        message: `PR #${session.pr.number} already has a respawned worker`,
        escalated: false,
      };
    }

    const project = config.projects[projectId];
    if (!project) {
      const event = createEvent("reaction.triggered", {
        sessionId,
        projectId,
        message: `Reaction '${reactionKey}' triggered respawn but project '${projectId}' not found`,
        data: { reactionKey, action, projectId },
      });
      await notifyHuman(event, "warning");
      return { reactionType: reactionKey, success: false, action, escalated: false };
    }

    // Build review context message (shared helper for both branches)
    const reactionMessage = await buildRespawnMessage(
      reactionConfig, session, projectId, config, registry, reactionKey,
    );
    // Prepend PR context so the new worker knows exactly what to fix
    const prContext = `PR #${session.pr.number} (${session.pr.url}) has review comments that need to be addressed. Work on branch '${session.pr.branch}'. `;
    const prompt = prContext + reactionMessage;

    let spawnedId: string | undefined;
    try {
      const spawned = await sessionManager.spawn({
        projectId,
        branch: session.pr.branch,
        prompt,
      });
      spawnedId = spawned.id;

      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.reaction.respawn_for_review",
        outcome: "success",
        correlationId,
        projectId,
        sessionId,
        data: {
          reactionKey,
          action: "respawn-for-review",
          spawnedSessionId: spawned.id,
          prNumber: session.pr.number,
        },
        level: "info",
      });
    } catch (spawnErr) {
      const errMsg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.reaction.respawn_for_review",
        outcome: "failure",
        correlationId,
        projectId,
        sessionId,
        data: { reactionKey, error: errMsg },
        level: "error",
      });

      // Increment attempt counter so next cycle can escalate if threshold reached.
      // Always mutate in-memory first; persist is best-effort.
      session.metadata["respawn_attempt_count"] = String(attemptCount + 1);
      try {
        updateSessionMetadataHelper(session, {
          respawn_attempt_count: String(attemptCount + 1),
        }, config);
      } catch (metaWriteErr) {
        console.warn(
          `[lifecycle-manager] respawn_attempt_count persist failed: ${metaWriteErr instanceof Error ? metaWriteErr.message : String(metaWriteErr)} — proceeding to escalation check`,
        );
      }

      if (isLastAttempt) {
        const event = createEvent("reaction.escalated", {
          sessionId,
          projectId,
          message: `respawn-for-review exhausted after ${escalateAfter} attempt(s): ${errMsg}`,
          priority: "warning",
          data: { reactionKey, error: errMsg },
        });
        await notifyHuman(event, "warning");
        return { reactionType: reactionKey, success: false, action, escalated: true };
      }
      // Spawn failed but not last attempt — allow retry on next cycle
      return { reactionType: reactionKey, success: false, action, escalated: false };
    }

    // Persist metadata after confirmed spawn success. The new worker already exists —
    // if persistence fails, log and return success rather than re-queuing a duplicate spawn.
    // Always mutate in-memory first so the session state is correct regardless of I/O outcome.
    session.metadata["pr_respawned"] = "true";
    session.metadata["respawned_session_id"] = spawnedId!;
    try {
      updateSessionMetadataHelper(session, {
        pr_respawned: "true",
        respawned_session_id: spawnedId!,
      }, config);
    } catch (metaErr) {
      const metaErrMsg = metaErr instanceof Error ? metaErr.message : String(metaErr);
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.reaction.respawn_for_review",
        outcome: "failure",
        correlationId,
        projectId,
        sessionId,
        data: { reactionKey, error: `spawn succeeded but metadata persist failed: ${metaErrMsg}` },
        level: "warn",
      });
      // Spawn succeeded — the replacement worker already exists. Returning success: true
      // avoids re-queuing a non-idempotent spawn on the next backlog cycle.
    }

    return {
      reactionType: reactionKey,
      success: true,
      action: "respawn-for-review",
      message: `Spawned fresh worker '${spawnedId}' for PR #${session.pr.number}`,
      escalated: false,
    };
  }

  // Agent is alive — fall back to send-to-agent.
  // buildRespawnMessage always produces a message (it has a default), so this path
  // never silently fails due to a missing reactionConfig.message.
  try {
    const finalMessage = await buildRespawnMessage(
      reactionConfig, session, projectId, config, registry, reactionKey,
    );
    await sessionManager.send(sessionId, finalMessage);
    return {
      reactionType: reactionKey,
      success: true,
      action: "respawn-for-review",
      message: finalMessage,
      escalated: false,
    };
  } catch (sendErr) {
    const errMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "lifecycle.reaction.send_failed",
      outcome: "failure",
      reason: errMsg,
      correlationId,
      projectId,
      sessionId,
      data: { reactionKey, error: errMsg },
      level: "warn",
    });
    return { reactionType: reactionKey, success: false, action, escalated: false };
  }
}
