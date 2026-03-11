type ProjectWithPrefix = { sessionPrefix?: string };
type SessionLike = { id: string; projectId: string };

/**
 * Check if a session belongs to a specific project.
 * Matches by projectId or sessionPrefix (same logic as resolveProject).
 *
 * @param session - Session with id and projectId
 * @param projectId - The project key to match against
 * @param projects - Projects config mapping
 */
function matchesProject(
  session: SessionLike,
  projectId: string,
  projects: Record<string, ProjectWithPrefix>,
): boolean {
  if (session.projectId === projectId) return true;
  const project = projects[projectId];
  if (project?.sessionPrefix && session.id.startsWith(project.sessionPrefix)) return true;
  return false;
}

function isOrchestratorSession(session: { id: string }): boolean {
  return session.id.endsWith("-orchestrator");
}

export function findOrchestratorSessionId<T extends SessionLike>(
  sessions: T[],
  projectFilter: string | null | undefined,
  projects: Record<string, ProjectWithPrefix>,
): string | null {
  if (projectFilter && projectFilter !== "all") {
    const session = sessions.find(
      (s) => isOrchestratorSession(s) && matchesProject(s, projectFilter, projects),
    );
    return session?.id ?? null;
  }

  const session = sessions.find((s) => isOrchestratorSession(s));
  return session?.id ?? null;
}

export function filterWorkerSessions<T extends SessionLike>(
  sessions: T[],
  projectFilter: string | null | undefined,
  projects: Record<string, ProjectWithPrefix>,
): T[] {
  const workers = sessions.filter((s) => !isOrchestratorSession(s));
  if (!projectFilter || projectFilter === "all") return workers;
  return workers.filter((s) => matchesProject(s, projectFilter, projects));
}
