/**
 * Session exit reconciliation (bd-uxs.6) — validates commits pushed and emits proof.
 * Extracted from lifecycle-manager.ts for fork isolation.
 */

import type {
  Session,
  SessionStatus,
  SCM,
  PluginRegistry,
  OrchestratorConfig,
  SessionExitProof,
  EventType,
  EventPriority,
  OrchestratorEvent,
} from "./types.js";
import { createCorrelationId, createProjectObserver } from "./observability.js";

export interface ExitProofDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  notifyHuman: (event: OrchestratorEvent, priority: EventPriority) => Promise<void>;
  createEvent: (
    type: EventType,
    opts: {
      sessionId: string;
      projectId: string;
      message: string;
      priority?: EventPriority;
      data?: Record<string, unknown>;
    },
  ) => OrchestratorEvent;
}

export function emitExitProofEvent(
  proof: SessionExitProof,
  validationFailed: boolean,
  deps: ExitProofDeps,
): void {
  const eventType: EventType = validationFailed ? "session.exit_failed" : "session.exit_validated";
  const priority: EventPriority = validationFailed ? "warning" : "info";

  const event = deps.createEvent(eventType, {
    sessionId: proof.sessionId,
    projectId: proof.projectId,
    message: `Session ${proof.sessionId} exit ${validationFailed ? "failed" : "validated"}: commits_pushed=${proof.commitsPushed}, status=${proof.exitStatus}`,
    priority,
    data: { proof },
  });

  void deps.notifyHuman(event, priority);

  const observer = createProjectObserver(deps.config, "lifecycle-manager");
  const correlationId = createCorrelationId("lifecycle-exit-proof");
  observer.recordOperation({
    metric: "lifecycle_exit_proof",
    operation: "lifecycle.exit_proof",
    outcome: validationFailed ? "failure" : "success",
    correlationId,
    projectId: proof.projectId,
    sessionId: proof.sessionId,
    data: { proof },
    level: validationFailed ? "warn" : "info",
  });
}

export async function validateAndEmitExitProof(
  session: Session,
  exitStatus: SessionStatus,
  deps: ExitProofDeps,
): Promise<void> {
  const project = deps.config.projects[session.projectId];
  if (!project) return;

  const scm = project.scm ? deps.registry.get<SCM>("scm", project.scm.plugin) : null;
  if (!scm) {
    const proof: SessionExitProof = {
      sessionId: session.id,
      projectId: session.projectId,
      exitStatus,
      commitsPushed: false,
      localCommits: [],
      remoteCommits: [],
      prUrl: session.pr?.url,
      prMerged: exitStatus === "merged",
      validatedAt: new Date().toISOString(),
    };
    emitExitProofEvent(proof, true, deps);
    return;
  }

  try {
    if (typeof scm.validateCommits === "function") {
      const validation = await scm.validateCommits(session, project);
      const proof: SessionExitProof = {
        sessionId: session.id,
        projectId: session.projectId,
        exitStatus,
        commitsPushed: validation.pushed,
        localCommits: validation.localCommits,
        remoteCommits: validation.remoteCommits,
        prUrl: session.pr?.url,
        prMerged: exitStatus === "merged",
        validatedAt: new Date().toISOString(),
      };
      emitExitProofEvent(proof, !validation.pushed, deps);
    } else {
      const proof: SessionExitProof = {
        sessionId: session.id,
        projectId: session.projectId,
        exitStatus,
        commitsPushed: false,
        localCommits: [],
        remoteCommits: [],
        prUrl: session.pr?.url,
        prMerged: exitStatus === "merged",
        validatedAt: new Date().toISOString(),
      };
      emitExitProofEvent(proof, true, deps);
    }
  } catch {
    const proof: SessionExitProof = {
      sessionId: session.id,
      projectId: session.projectId,
      exitStatus,
      commitsPushed: false,
      localCommits: [],
      remoteCommits: [],
      prUrl: session.pr?.url,
      prMerged: exitStatus === "merged",
      validatedAt: new Date().toISOString(),
    };
    emitExitProofEvent(proof, true, deps);
  }
}
