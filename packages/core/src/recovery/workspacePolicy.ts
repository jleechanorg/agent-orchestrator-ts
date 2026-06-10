import { resolve, parse, sep, relative, isAbsolute, basename, join } from "path";
import { homedir } from "os";
import { realpathSync } from "fs";
import type { ProjectConfig } from "../types.js";
import { getWorktreesDir, expandHome } from "../paths.js";
import { loadConfig } from "../config.js";

/** Expand ~ to home directory — delegates to the canonical helper.
 *  Adds bare-tilde support (`~` alone expands to $HOME) on top of `~/...`. */
function expandPath(p: string): string {
  if (p === "~") return homedir();
  return expandHome(p);
}

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

export function realpathNormalized(p: string): string {
  try {
    return normalizePath(realpathSync(p));
  } catch {
    return normalizePath(p);
  }
}

/**
 * Checks if child path is inside parent path in a platform-independent way.
 * Returns true if relative path is non-empty, does not start with ".." and is not absolute.
 */
export function isPathInside(child: string, parent: string): boolean {
  const normalizedChild = realpathNormalized(child);
  const normalizedParent = realpathNormalized(parent);
  const rel = relative(normalizedParent, normalizedChild);
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
  if (realpathNormalized(workspacePath) === realpathNormalized(project.path)) return false;

  let globalConfig: ReturnType<typeof loadConfig> | undefined;
  try {
    globalConfig = loadConfig(configPath);
  } catch {
    // ignore config loading errors
  }

  const roots = [getWorktreesDir(configPath, project.path)];

  // 1. Add configured global worktreeDir if present
  if (globalConfig?.worktreeDir) {
    const expandedGlobal = expandPath(globalConfig.worktreeDir);
    roots.push(join(expandedGlobal, projectId || basename(project.path)));
  }

  // 2. Add configured per-project worktreeDir if present
  if (project.worktreeDir) {
    const expandedProject = expandPath(project.worktreeDir);
    roots.push(join(expandedProject, projectId || basename(project.path)));
  }

  // 3. Add default clone base directory
  roots.push(join(homedir(), ".ao-clones", projectId || basename(project.path)));

  // 4. Add configured global cloneDir if present
  if (globalConfig?.cloneDir) {
    const expandedGlobalClone = expandPath(globalConfig.cloneDir);
    roots.push(join(expandedGlobalClone, projectId || basename(project.path)));
  }

  // 5. Add configured per-project cloneDir if present
  if (project.cloneDir) {
    const expandedProjectClone = expandPath(project.cloneDir);
    roots.push(join(expandedProjectClone, projectId || basename(project.path)));
  }

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

