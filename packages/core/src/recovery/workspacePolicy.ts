import { resolve, parse, sep, relative, isAbsolute, basename, join } from "path";
import { homedir } from "os";
import type { ProjectConfig } from "../types.js";
import { getWorktreesDir } from "../paths.js";
import { loadConfig } from "../config.js";

/** Expand ~ to home directory (mirrors workspace-worktree expandPath). */
function expandPath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(1));
  }
  return p;
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

  // 1. Add configured global worktreeDir if present
  try {
    const globalConfig = loadConfig(configPath);
    if (globalConfig.worktreeDir) {
      const expandedGlobal = expandPath(globalConfig.worktreeDir);
      roots.push(join(expandedGlobal, projectId || basename(project.path)));
    }
  } catch {
    // ignore config loading errors
  }

  // 2. Add configured per-project worktreeDir if present
  if (project.worktreeDir) {
    const expandedProject = expandPath(project.worktreeDir);
    roots.push(join(expandedProject, projectId || basename(project.path)));
  }

  // 3. Add default clone base directory
  roots.push(join(homedir(), ".ao-clones", projectId || basename(project.path)));

  // 4. Add configured global cloneDir if present
  try {
    const globalConfig = loadConfig(configPath);
    if (globalConfig.cloneDir) {
      const expandedGlobalClone = expandPath(globalConfig.cloneDir);
      roots.push(join(expandedGlobalClone, projectId || basename(project.path)));
    }
  } catch {
    // ignore config loading errors
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

