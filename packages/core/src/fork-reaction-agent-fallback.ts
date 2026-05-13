/**
 * fork-reaction-agent-fallback — Agent fallback chain handler.
 *
 * When the primary agent dies with a quota/rate-limit error, this handler
 * respawns the session with the next agent in the configured fallback chain.
 *
 * The fallback chain is configured via `defaults.fallbackAgents` in the
 * AO config, e.g. `fallbackAgents: ["gemini", "minimax"]` for a
 * wafer > gemini > minimax chain.
 *
 * This module is a fork-specific extension, following the pattern of
 * fork-reaction-rfr.ts and fork-reaction-handlers.ts.
 */

import type {
  SessionId,
  SessionManager,
  SessionSpawnConfig,
  OrchestratorConfig,
  ReactionConfig,
  ReactionResult,
  Session,
  OrchestratorEvent,
  EventPriority,
  EventType,
} from "./types.js";
import { updateSessionMetadataHelper } from "./fork-utils.js";
import type { ProjectObserver } from "./observability.js";

export interface AgentFallbackDeps {
  sessionManager: SessionManager;
  config: OrchestratorConfig;
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
 * Resolve the next agent in the fallback chain.
 * The canonical chain is [defaultAgent, ...fallbackAgents].
 * If currentAgent is not in the canonical chain (e.g. project-level override),
 * it is prepended so the session can still fall back to defaultAgent.
 * Returns undefined if the current agent is the last in the chain.
 */
export function resolveNextFallbackAgent(
  currentAgent: string,
  fallbackAgents: string[] | undefined,
  defaultAgent: string,
): string | undefined {
  if (!fallbackAgents || fallbackAgents.length === 0) return undefined;
  // Build the canonical chain: [defaultAgent, ...fallbackAgents]
  const canonicalChain = [defaultAgent, ...fallbackAgents];
  // Check if currentAgent is already in the chain (case-insensitive)
  const currentInChain = canonicalChain.some(
    (a) => a.toLowerCase() === currentAgent.toLowerCase(),
  );
  // If currentAgent is not in the chain, prepend it (project-level override scenario)
  const chain = currentInChain ? canonicalChain : [currentAgent, ...canonicalChain];
  // Deduplicate while preserving order (case-insensitive)
  const seen = new Set<string>();
  const uniqueChain = chain.filter(agent => {
    const lower = agent.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });
  const currentIdx = uniqueChain.findIndex(
    (a) => a.toLowerCase() === currentAgent.toLowerCase(),
  );
  if (currentIdx === -1 || currentIdx >= uniqueChain.length - 1) return undefined;
  return uniqueChain[currentIdx + 1];
}

/**
 * Handle agent-fallback reaction.
 *
 * When the agent is dead and a fallback chain is configured:
 *   - Resolve the current agent from session.metadata["agent"]
 *   - Find the next agent in the fallback chain
 *   - Spawn a new session with the fallback agent
 *   - Persist the fallback agent name and mark the old session as superseded
 *
 * If no fallback is available or the chain is exhausted, notify and escalate.
 */
export async function handleAgentFallback(
  sessionId: SessionId,
  projectId: string,
  reactionKey: string,
  reactionConfig: ReactionConfig,
  session: Session,
  agentDead: boolean | undefined,
  correlationId: string,
  deps: AgentFallbackDeps,
): Promise<ReactionResult> {
  const { sessionManager, config, notifyHuman, createEvent, observer } = deps;
  const action = "agent-fallback";

  if (agentDead !== true) {
    // Agent is alive or liveness unknown — no fallback needed
    return { reactionType: reactionKey, success: true, action, escalated: false };
  }

  const projectConfig = config.projects[projectId];
  const currentAgent = session.metadata?.["agent"] ?? projectConfig?.agent ?? config.defaults.agent;
  const defaultAgent = projectConfig?.defaultAgent ?? projectConfig?.agent ?? config.defaults.agent;
  const fallbackAgents = projectConfig?.fallbackAgents ?? config.defaults.fallbackAgents;

  // Check idempotency guard before escalation
  if (session.metadata?.["fallback_spawned"] === "true") {
    return {
      reactionType: reactionKey,
      success: true,
      action,
      message: `Session already fell back to '${session.metadata?.["fallback_agent"]}'`,
      escalated: false,
    };
  }

  const nextAgent = resolveNextFallbackAgent(currentAgent, fallbackAgents, defaultAgent);

  if (!nextAgent) {
    const exhausted = !fallbackAgents || fallbackAgents.length === 0;
    const event = createEvent("reaction.escalated", {
      sessionId,
      projectId,
      message: exhausted
        ? `Agent '${currentAgent}' exited but no fallback chain configured — add defaults.fallbackAgents to config`
        : `Agent fallback chain exhausted after '${currentAgent}' (chain: [${[currentAgent, ...fallbackAgents!].join(" > ")}])`,
      data: { reactionKey, action, currentAgent, fallbackAgents },
    });
    await notifyHuman(event, "urgent");
    return { reactionType: reactionKey, success: false, action, escalated: true };
  }

  const project = config.projects[projectId];
  if (!project) {
    const event = createEvent("reaction.triggered", {
      sessionId,
      projectId,
      message: `Reaction '${reactionKey}' triggered fallback but project '${projectId}' not found`,
      data: { reactionKey, action, projectId },
    });
    await notifyHuman(event, "warning");
    return { reactionType: reactionKey, success: false, action, escalated: false };
  }

  // Mark the old session as fallback-superseded BEFORE killing it.
  // If we write after kill, the active metadata file is already archived/deleted,
  // and updateMetadata() recreates it from {} — producing a ghost session.
  session.metadata["fallback_spawned"] = "true";
  session.metadata["fallback_agent"] = nextAgent;
  try {
    updateSessionMetadataHelper(session, {
      fallback_spawned: "true",
      fallback_agent: nextAgent,
    }, config);
  } catch (metaErr) {
    console.warn(
      `[agent-fallback] metadata persist before kill failed: ${metaErr instanceof Error ? metaErr.message : String(metaErr)} — proceeding`,
    );
  }

  // Kill the superseded session to free its worktree/tmux before spawning.
  // Without this, the worktree plugin refuses to check out the same branch
  // in a new worktree while the old one still holds it.
  try {
    await sessionManager.kill(sessionId);
  } catch (killErr) {
    const killMsg = killErr instanceof Error ? killErr.message : String(killErr);
    console.warn(
      `[agent-fallback] session.kill(${sessionId}) failed before fallback spawn: ${killMsg} — proceeding`,
    );
  }

  // Spawn a new session with the fallback agent
  const spawnOpts: SessionSpawnConfig = {
    projectId,
    agent: nextAgent,
  };
  if (session.pr) {
    spawnOpts.branch = session.pr.branch;
    spawnOpts.prompt = `Continuing work on PR #${session.pr.number} (${session.pr.url}) — previous agent '${currentAgent}' hit quota limits. Switched to '${nextAgent}'.`;
  } else if (session.issueId) {
    spawnOpts.issueId = session.issueId;
  } else if (session.branch) {
    spawnOpts.branch = session.branch;
  }

  let spawnedId: string | undefined;
  try {
    const spawned = await sessionManager.spawn(spawnOpts);
    spawnedId = spawned.id;

    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "lifecycle.reaction.agent_fallback",
      outcome: "success",
      correlationId,
      projectId,
      sessionId,
      data: {
        reactionKey,
        action: "agent-fallback",
        fromAgent: currentAgent,
        toAgent: nextAgent,
        spawnedSessionId: spawned.id,
      },
      level: "info",
    });
  } catch (spawnErr) {
    const errMsg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "lifecycle.reaction.agent_fallback",
      outcome: "failure",
      correlationId,
      projectId,
      sessionId,
      data: { reactionKey, error: errMsg, fromAgent: currentAgent, toAgent: nextAgent },
      level: "error",
    });

    const event = createEvent("reaction.triggered", {
      sessionId,
      projectId,
      message: `Agent fallback from '${currentAgent}' to '${nextAgent}' failed: ${errMsg}`,
      data: { reactionKey, action, fromAgent: currentAgent, toAgent: nextAgent, error: errMsg },
    });
    await notifyHuman(event, "warning");
    return { reactionType: reactionKey, success: false, action, escalated: false };
  }

  const event = createEvent("reaction.triggered", {
    sessionId,
    projectId,
    message: `Agent fallback: '${currentAgent}' → '${nextAgent}' (spawned ${spawnedId})`,
    data: {
      reactionKey,
      action,
      fromAgent: currentAgent,
      toAgent: nextAgent,
      spawnedSessionId: spawnedId,
    },
  });
  await notifyHuman(event, "action");

  return {
    reactionType: reactionKey,
    success: true,
    action,
    message: `Fallback: ${currentAgent} → ${nextAgent} (session ${spawnedId})`,
    escalated: false,
  };
}
