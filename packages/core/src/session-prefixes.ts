import type { ProjectConfig } from "./types.js";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function getAllSessionPrefixes(projects: Record<string, ProjectConfig>): string[] {
  const prefixes = new Set<string>();
  for (const project of Object.values(projects)) {
    if (project.sessionPrefix) {
      prefixes.add(project.sessionPrefix);
    }
  }
  return [...prefixes];
}

export function isOrchestratorSessionForPrefix(
  session: { id: string; metadata?: Record<string, string> },
  sessionPrefix?: string,
  allSessionPrefixes?: string[],
): boolean {
  if (session.metadata?.["role"] === "orchestrator" || session.id.endsWith("-orchestrator")) {
    return true;
  }
  if (!sessionPrefix) {
    return false;
  }

  const escapedPrefix = escapeRegExp(sessionPrefix);
  if (!new RegExp(`^${escapedPrefix}-orchestrator-\\d+$`).test(session.id)) {
    return false;
  }

  if (allSessionPrefixes) {
    for (const prefix of allSessionPrefixes) {
      if (prefix === sessionPrefix) continue;
      if (new RegExp(`^${escapeRegExp(prefix)}-\\d+$`).test(session.id)) {
        return false;
      }
    }
  }

  return true;
}
