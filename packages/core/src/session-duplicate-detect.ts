import type { Session, SessionStatus } from "./types.js";

const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "killed",
  "terminated",
  "done",
  "cleanup",
  "errored",
  "merged",
]);

export interface DuplicateMatch {
  sessionId: string;
  status: SessionStatus;
  reason: string;
}

export function findDuplicateSessions(
  existing: Session[],
  projectId: string,
  issueId?: string,
  prompt?: string,
): DuplicateMatch[] {
  const matches: DuplicateMatch[] = [];
  const normalizedPrompt = prompt?.trim().toLowerCase();

  for (const session of existing) {
    if (session.projectId !== projectId) continue;
    if (TERMINAL_STATUSES.has(session.status)) continue;

    if (issueId && session.issueId === issueId) {
      matches.push({
        sessionId: session.id,
        status: session.status,
        reason: `same issue: ${issueId}`,
      });
      continue;
    }

    if (normalizedPrompt && session.metadata["requestedTask"]) {
      const existingTask = session.metadata["requestedTask"].trim().toLowerCase();
      if (existingTask === normalizedPrompt) {
        matches.push({
          sessionId: session.id,
          status: session.status,
          reason: "identical task prompt",
        });
      }
    }
  }

  return matches;
}
