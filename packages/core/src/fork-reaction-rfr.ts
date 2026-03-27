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

    // Build review context to pre-load into the new worker's prompt
    let context = "";
    if (reactionConfig.message?.includes("{{context}}") && session) {
      try {
        context = await buildReactionContext(reactionKey, session, projectId, config, registry);
      } catch (ctxErr) {
        console.warn(
          `[lifecycle-manager] buildReactionContext failed for session=${sessionId}: ` +
          `${ctxErr instanceof Error ? ctxErr.message : String(ctxErr)} — proceeding without context`,
        );
      }
    }

    let prompt = reactionConfig.message ?? `Fix review comments on PR #${session.pr.number} and push.`;
    // Use callback form so $ patterns in context are not interpreted as replacement tokens
    prompt = prompt.replaceAll("{{context}}", () => context);
    // Prepend PR context so the new worker knows exactly what to fix
    const prContext = `PR #${session.pr.number} (${session.pr.url}) has review comments that need to be addressed. Work on branch '${session.pr.branch}'. `;
    prompt = prContext + prompt;

    try {
      const spawned = await sessionManager.spawn({
        projectId,
        branch: session.pr.branch,
        prompt,
      });

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

      // Mark this session as respawned so the backlog skips it on subsequent cycles.
      // The spawned worker owns the PR from now on.
      updateSessionMetadataHelper(session, {
        pr_respawned: "true",
        respawned_session_id: spawned.id,
      }, config);

      return {
        reactionType: reactionKey,
        success: true,
        action: "respawn-for-review",
        message: `Spawned fresh worker '${spawned.id}' for PR #${session.pr.number}`,
        escalated: false,
      };
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
      // Spawn failed — allow retry on next cycle (don't escalate immediately)
      return { reactionType: reactionKey, success: false, action, escalated: false };
    }
  }

  // Agent is alive — fall back to send-to-agent behavior
  if (reactionConfig.message) {
    try {
      let finalMessage = reactionConfig.message;
      if (session && reactionConfig.message.includes("{{context}}")) {
        const context = await buildReactionContext(reactionKey, session, projectId, config, registry);
        finalMessage = reactionConfig.message.replace(/\{\{context\}\}/g, () => context);
      }
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
  return { reactionType: reactionKey, success: false, action, escalated: false };
}
