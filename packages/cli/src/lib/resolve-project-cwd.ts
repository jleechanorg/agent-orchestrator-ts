/**
 * resolve-project-cwd.ts — Fork-only helper for cwd-based project resolution.
 *
 * Separated from start.ts to keep upstream file diffs minimal and enable
 * focused unit tests. Not intended for upstreaming to ComposioHQ.
 */
import { resolve, sep } from "node:path";
import type { OrchestratorConfig, ProjectConfig } from "@jleechanorg/ao-core";

/**
 * Given a multi-project config and the current working directory, find a
 * project whose path is an ancestor of (or equal to) `currentDir`.
 *
 * Matches both exact root (`/path/to/proj`) and any subdirectory
 * (`/path/to/proj/src`, `/path/to/proj/packages/foo`, etc.).
 *
 * When multiple projects match (e.g., `/repo` and `/repo/apps/web`), returns
 * the most specific (longest matching) project path.
 *
 * Returns the matched `{ projectId, project }` or `null` if no match.
 */
export function resolveProjectByCwd({
  config,
  currentDir,
}: {
  config: OrchestratorConfig;
  currentDir: string;
}): { projectId: string; project: ProjectConfig } | null {
  const normalizedCwd = resolve(currentDir);
  let bestMatch: { projectId: string; project: ProjectConfig; pathLength: number } | null = null;

  for (const [id, proj] of Object.entries(config.projects)) {
    const projPath = resolve(proj.path);
    const projPrefix = projPath.endsWith(sep) ? projPath : projPath + sep;
    // Exact match OR currentDir is inside the project tree
    if (normalizedCwd === projPath || normalizedCwd.startsWith(projPrefix)) {
      if (bestMatch === null || projPath.length > bestMatch.pathLength) {
        bestMatch = { projectId: id, project: proj, pathLength: projPath.length };
      }
    }
  }

  return bestMatch !== null ? { projectId: bestMatch.projectId, project: bestMatch.project } : null;
}
