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
 * Returns the matched `{ projectId, project }` or `null` if no match.
 */
export function resolveProjectByCwd(
  config: OrchestratorConfig,
  currentDir: string,
): { projectId: string; project: ProjectConfig } | null {
  const normalizedCwd = resolve(currentDir);

  for (const [id, proj] of Object.entries(config.projects)) {
    const projPath = resolve(proj.path);
    // Exact match OR currentDir is inside the project tree
    if (normalizedCwd === projPath || normalizedCwd.startsWith(projPath + sep)) {
      return { projectId: id, project: proj };
    }
  }

  return null;
}
