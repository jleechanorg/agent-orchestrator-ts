/**
 * Shared fork utilities — helpers used by multiple fork-extracted modules.
 * Consolidates logic to avoid duplication across companion modules.
 */

import type { Session, OrchestratorConfig } from "./types.js";
import { updateMetadata } from "./metadata.js";
import { getSessionsDir } from "./paths.js";

/**
 * Update session metadata on disk and in-memory.
 * Used by lifecycle-manager and review-backlog.
 */
export function updateSessionMetadataHelper(
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
