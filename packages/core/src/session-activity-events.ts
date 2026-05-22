/**
 * Companion module: activity event hooks for session-manager.
 *
 * Extracted from upstream's inline changes to session-manager.ts to minimize
 * the fork diff surface. The session-manager re-exports these hooks and calls
 * them at the appropriate points — one-line additions per call site instead of
 * inline event-recording logic.
 */

import { recordActivityEvent } from "./activity-events.js";

export function emitSpawnStarted(projectId: string, agent?: string): void {
  recordActivityEvent({
    projectId,
    source: "session-manager",
    kind: "session.spawn_started",
    summary: "spawn started",
    data: { agent: agent ?? undefined },
  });
}

export function emitSpawnFailed(projectId: string, reason: string): void {
  recordActivityEvent({
    projectId,
    source: "session-manager",
    kind: "session.spawn_failed",
    level: "error",
    summary: "spawn failed",
    data: { reason },
  });
}

export function emitSpawned(projectId: string, sessionId: string, agent: string, branch?: string): void {
  recordActivityEvent({
    projectId,
    sessionId,
    source: "session-manager",
    kind: "session.spawned",
    summary: `spawned: ${sessionId}`,
    data: { agent, branch: branch ?? undefined },
  });
}

export function emitKilled(projectId: string, sessionId: string, reason: string): void {
  recordActivityEvent({
    projectId,
    sessionId,
    source: "session-manager",
    kind: "session.killed",
    summary: `killed: ${sessionId}`,
    data: { reason },
  });
}
