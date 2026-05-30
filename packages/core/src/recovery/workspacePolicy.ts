import { resolve, parse, sep, relative, isAbsolute, basename, join } from "path";
import { homedir } from "os";
import type { ProjectConfig } from "../types.js";
import { getWorktreesDir } from "../paths.js";

/**
 * Normalizes a path using path.resolve and trailing separator stripping.
 * Only strips trailing separator if resolved path is not the root path itself.
 */
export function normalizePath(p: string): string {
  const resolved = resolve(p);
  const { root } = parse(resolved);
  if (resolved !== root && resolved.endsWith(sep)) {
    return resolved.slice(0, -sep.length);
  }
  return resolved;
}

/**
 * Checks if child path is inside parent path in a platform-independent way.
 * Returns true if relative path is non-empty, does not start with ".." and is not absolute.
 */
export function isPathInside(child: string, parent: string): boolean {
  const rel = relative(normalizePath(parent), normalizePath(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Determines if a given workspace path should be destroyed based on the project configuration
 * and defined safety roots.
 */
export function shouldDestroyWorkspacePath(
  project: ProjectConfig | undefined,
  projectId: string | undefined,
  workspacePath: string,
  configPath: string,
): boolean {
  if (!project) return false;
  if (normalizePath(workspacePath) === normalizePath(project.path)) return false;

  const roots = [getWorktreesDir(configPath, project.path)];
  const legacyIds = new Set<string>();
  if (projectId) {
    legacyIds.add(projectId);
  }
  legacyIds.add(basename(project.path));

  for (const id of legacyIds) {
    roots.push(join(homedir(), ".worktrees", id));
  }

  return roots.some((root) => isPathInside(workspacePath, root));
}
