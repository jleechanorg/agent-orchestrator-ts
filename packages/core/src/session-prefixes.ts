import type { ProjectConfig } from "./types.js";
import { DEFAULT_AO_SESSION_PREFIXES } from "./tmux-session-sweeper.js";

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

/** Cache for precompiled regex patterns to avoid per-iteration allocation churn. */
const regexCache = new Map<string, RegExp>();

function getCachedRegExp(pattern: string): RegExp {
  let regex = regexCache.get(pattern);
  if (!regex) {
    regex = new RegExp(pattern);
    regexCache.set(pattern, regex);
  }
  return regex;
}

export function isOrchestratorSessionForPrefix(
  session: { id: string; metadata?: Record<string, string> },
  sessionPrefix?: string,
  allSessionPrefixes?: string[],
): boolean {
  // If explicitly marked as worker in metadata, respect it.
  if (session.metadata?.["role"] === "worker") {
    return false;
  }
  // If explicitly marked as orchestrator in metadata, respect it.
  if (session.metadata?.["role"] === "orchestrator") {
    return true;
  }

  // If no prefix provided, fall back to simple check.
  if (!sessionPrefix) {
    return session.id.endsWith("-orchestrator");
  }

  const escapedPrefix = escapeRegExp(sessionPrefix);
  // Match prefix-orchestrator OR prefix-orchestrator-123
  const isMatch = getCachedRegExp(`^${escapedPrefix}-orchestrator(?:-\\d+)?$`).test(session.id);
  if (!isMatch) {
    return false;
  }

  // If we have other prefixes, ensure this session doesn't belong to them (e.g. prefix-123)
  if (allSessionPrefixes) {
    for (const prefix of allSessionPrefixes) {
      if (prefix === sessionPrefix) continue;
      if (getCachedRegExp(`^${escapeRegExp(prefix)}-\\d+$`).test(session.id)) {
        return false;
      }
    }
  }

  return true;
}

export function getAoManagedSessionWorktreePattern(sessionPrefixes?: string[]): RegExp {
  const escapedPrefixes = [...new Set([...DEFAULT_AO_SESSION_PREFIXES, ...(sessionPrefixes ?? [])])]
    .filter((prefix) => prefix.length > 0)
    .map(escapeRegExp);

  return new RegExp(`^(?:${escapedPrefixes.join("|")})-\\d+$`);
}
