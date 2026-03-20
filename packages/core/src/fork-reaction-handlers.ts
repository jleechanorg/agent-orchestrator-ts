/**
 * Fork-specific reaction handlers — request-merge and parallel-retry.
 * Extracted from lifecycle-manager.ts for upstream isolation.
 *
 * These handlers extend the upstream reaction engine with merge-gating
 * and parallel retry capabilities (bd-uxs.4, bd-uxs.8).
 */

import type {
  SessionId,
  SessionManager,
  OrchestratorConfig,
  PluginRegistry,
  ReactionConfig,
  ReactionResult,
  SCM,
  OrchestratorEvent,
  EventPriority,
  EventType,
} from "./types.js";

export interface ReactionHandlerDeps {
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
}

/** Handle request-merge reaction: check mergeability and notify human for approval. */
export async function handleRequestMerge(
  sessionId: SessionId,
  projectId: string,
  reactionKey: string,
  reactionConfig: ReactionConfig,
  deps: ReactionHandlerDeps,
): Promise<ReactionResult> {
  const action = "request-merge";
  const { sessionManager, config, registry, notifyHuman, createEvent } = deps;

  const freshSession = await sessionManager.get(sessionId);
  if (!freshSession) {
    return { reactionType: reactionKey, success: false, action, escalated: false };
  }

  const project = config.projects[freshSession.projectId];
  if (!project) {
    return { reactionType: reactionKey, success: false, action, escalated: false };
  }

  const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
  if (!scm || !freshSession.pr) {
    const event = createEvent("reaction.triggered", {
      sessionId,
      projectId,
      message: `Reaction '${reactionKey}' triggered ${action} (no SCM/PR available)`,
      data: { reactionKey, action },
    });
    await notifyHuman(event, "action");
    return { reactionType: reactionKey, success: true, action, escalated: false };
  }

  const mergeReadiness = await scm.getMergeability(freshSession.pr);
  if (!mergeReadiness.mergeable) {
    const event = createEvent("reaction.triggered", {
      sessionId,
      projectId,
      message: `Reaction '${reactionKey}' triggered ${action} but PR is not mergeable: ${mergeReadiness.blockers.join(", ")}`,
      data: { reactionKey, action, blockers: mergeReadiness.blockers },
    });
    await notifyHuman(event, "action");
    return { reactionType: reactionKey, success: false, action, escalated: false };
  }

  const mergeMethod = reactionConfig.mergeMethod ?? "squash";
  const approvalEvent = createEvent("merge.approval_requested", {
    sessionId,
    projectId,
    message: `PR #${freshSession.pr.number} is ready to merge (${mergeMethod}). Approve to proceed?`,
    data: {
      reactionKey,
      action,
      prNumber: freshSession.pr.number,
      prUrl: freshSession.pr.url,
      mergeMethod,
    },
  });
  await notifyHuman(approvalEvent, "action");

  return { reactionType: reactionKey, success: true, action, escalated: false };
}

/** Handle parallel-retry reaction: spawn multiple sessions with different strategies. */
export async function handleParallelRetry(
  sessionId: SessionId,
  projectId: string,
  reactionKey: string,
  reactionConfig: ReactionConfig,
  deps: ReactionHandlerDeps,
): Promise<ReactionResult> {
  const action = "parallel-retry";
  const { sessionManager, notifyHuman, createEvent } = deps;

  const freshSession = await sessionManager.get(sessionId);
  if (!freshSession) {
    return { reactionType: reactionKey, success: false, action, escalated: false };
  }

  const parallelCfg = reactionConfig.parallelRetry;
  const strategies = parallelCfg?.strategies ?? [];
  const maxParallel = parallelCfg?.maxParallel ?? 1;
  const count = Math.min(strategies.length || 1, maxParallel);

  const spawnedIds: string[] = [];
  const errors: string[] = [];

  for (let i = 0; i < count; i++) {
    const agent = strategies[i] ?? undefined;
    try {
      const spawned = await sessionManager.spawn({
        projectId: freshSession.projectId,
        issueId: freshSession.issueId ?? undefined,
        agent,
      });
      spawnedIds.push(spawned.id);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  const success = spawnedIds.length > 0;
  const event = createEvent("reaction.triggered", {
    sessionId,
    projectId,
    message: `Reaction '${reactionKey}' spawned ${spawnedIds.length} parallel retry session(s)${errors.length > 0 ? ` (${errors.length} failed to spawn)` : ""}`,
    data: { reactionKey, action, spawnedIds, errors },
  });
  await notifyHuman(event, success ? "action" : "warning");
  return { reactionType: reactionKey, success, action, escalated: false };
}
