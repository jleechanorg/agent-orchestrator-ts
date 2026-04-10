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
): boolean {
  if (session.metadata?.["role"] === "orchestrator") {
    return true;
  }

  if (sessionPrefix) {
    return session.id === `${sessionPrefix}-orchestrator`;
  }

  return session.id.endsWith("-orchestrator");
}

export function getAoManagedSessionWorktreePattern(sessionPrefixes?: string[]): RegExp {
  const escapedPrefixes = [...new Set(["ao", "jc", "wa", "cc", "ra", "wc", ...(sessionPrefixes ?? [])])]
    .filter((prefix) => prefix.length > 0)
    .map(escapeRegExp);

  return new RegExp(`^(?:${escapedPrefixes.join("|")})-\\d+$`);
}
