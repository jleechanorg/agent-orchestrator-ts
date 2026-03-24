/**
 * Skeptic Reaction Handler — spawn-skeptic action (bd-qw6)
 *
 * Companion module for lifecycle-manager.ts (fork isolation pattern).
 * Handles the "spawn-skeptic" reaction action by:
 *  1. Reading exit criteria from the coder's workspace
 *  2. Building the skeptic system prompt
 *  3. Spawning a separate Skeptic session
 *
 * Design: docs/design/skeptic-agent-verifier.md
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  SessionId,
  SessionManager,
  OrchestratorConfig,
  PluginRegistry,
  ReactionConfig,
  ReactionResult,
  OrchestratorEvent,
  EventPriority,
  EventType,
} from "./types.js";
import { buildSkepticPrompt, resolveSkepticModel } from "./skeptic-prompt.js";

export interface SkepticReactionDeps {
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

/**
 * Read exit criteria from the coder's workspace.
 * Returns the file content or null if the file doesn't exist.
 */
function readExitCriteria(workspacePath: string): string | null {
  const criteriaPath = join(workspacePath, "specs", "exit-criteria.md");
  if (!existsSync(criteriaPath)) {
    return null;
  }
  try {
    return readFileSync(criteriaPath, "utf-8").trim();
  } catch {
    return null;
  }
}

/**
 * Handle the spawn-skeptic reaction action.
 *
 * Called when the lifecycle manager detects a worker-signals-completion event.
 * Spawns a separate Skeptic Agent session with inverted incentives to
 * independently verify exit criteria.
 */
export async function handleSpawnSkeptic(
  sessionId: SessionId,
  projectId: string,
  reactionKey: string,
  _reactionConfig: ReactionConfig,
  deps: SkepticReactionDeps,
): Promise<ReactionResult> {
  const action = "spawn-skeptic";
  const { sessionManager, config, notifyHuman, createEvent } = deps;

  // Get the coder session
  const coderSession = await sessionManager.get(sessionId);
  if (!coderSession) {
    return { reactionType: reactionKey, success: false, action, escalated: false };
  }

  // Validate project exists
  const project = config.projects[coderSession.projectId];
  if (!project) {
    return { reactionType: reactionKey, success: false, action, escalated: false };
  }

  // Check if skeptic is enabled
  const skepticConfig = config.skeptic;
  if (!skepticConfig || !skepticConfig.enabled) {
    return { reactionType: reactionKey, success: false, action, escalated: false };
  }

  // Read exit criteria from the coder's workspace
  const workspacePath = coderSession.workspacePath ?? project.path;
  const exitCriteria = readExitCriteria(workspacePath);
  if (!exitCriteria) {
    const event = createEvent("reaction.triggered", {
      sessionId,
      projectId,
      message: `Skeptic reaction skipped: no specs/exit-criteria.md found in ${workspacePath}`,
      data: { reactionKey, action, reason: "no_exit_criteria" },
    });
    await notifyHuman(event, "warning");
    return { reactionType: reactionKey, success: false, action, escalated: false };
  }

  // Determine coder model and resolve skeptic model
  const coderModel = coderSession.metadata["agent"] ?? config.defaults.agent;
  const skepticModel = skepticConfig.model === "auto"
    ? resolveSkepticModel(coderModel)
    : skepticConfig.model;

  // Build the skeptic system prompt
  const skepticPrompt = buildSkepticPrompt(exitCriteria, coderModel);

  // Spawn the skeptic session
  try {
    const skepticSession = await sessionManager.spawn({
      projectId: coderSession.projectId,
      agent: skepticModel,
      prompt: skepticPrompt,
    });

    const event = createEvent("reaction.triggered", {
      sessionId,
      projectId,
      message: `Skeptic session ${skepticSession.id} spawned to verify ${sessionId} (model: ${skepticModel})`,
      data: {
        reactionKey,
        action,
        skepticSessionId: skepticSession.id,
        coderSessionId: sessionId,
        skepticModel,
        coderModel,
      },
    });
    await notifyHuman(event, "info");

    return { reactionType: reactionKey, success: true, action, escalated: false };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const event = createEvent("reaction.triggered", {
      sessionId,
      projectId,
      message: `Skeptic session spawn failed: ${errorMsg}`,
      data: { reactionKey, action, error: errorMsg },
    });
    await notifyHuman(event, "warning");

    return { reactionType: reactionKey, success: false, action, escalated: false };
  }
}
