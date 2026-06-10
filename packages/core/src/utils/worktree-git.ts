/**
 * worktree-git.ts — shared git-worktree utilities
 *
 * Extracted from backfill-extensions.ts and workspace-worktree/src/index.ts.
 * Both call sites need identical worktree-recovery logic but live in different
 * packages (core vs plugin), so the function lives here in core/src/utils/
 * where both can import it without creating a plugin dependency.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Timeout for git commands (30 seconds). */
const GIT_TIMEOUT = 30_000;

export interface RepoPathResult {
  repoPath: string;
  branch: string;
}

/**
 * Find the owning git repo for a worktree by walking up from the worktree path
 * or scanning `git worktree list` from homedir.
 *
 * @returns `{repoPath, branch}` if the worktree entry is found, else `null`.
 */
export async function findRepoPathForWorktree(
  workspacePath: string,
): Promise<RepoPathResult | null> {
  // 1. Walk up the directory tree from the worktree path looking for .git.
  // Start at workspacePath itself — AO worktrees have .git at the worktree root.
  let dir = workspacePath;
  const root = homedir(); // stop at home
  while (dir !== root && dir !== "/") {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      try {
        const gitCommonDir = (
          await execFileAsync("/usr/bin/git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
            timeout: GIT_TIMEOUT,
            encoding: "utf8",
          })
        ).stdout.trim();
        // Attempt to get branch from the worktree's HEAD so callers can delete it.
        let branch = "";
        try {
          branch = (
            await execFileAsync(
              "/usr/bin/git",
              ["-C", workspacePath, "symbolic-ref", "--short", "HEAD"],
              { timeout: GIT_TIMEOUT, encoding: "utf8" },
            )
          ).stdout.trim();
        } catch {
          // Detached HEAD or worktree broken — leave branch empty
        }
        return { repoPath: resolve(gitCommonDir, ".."), branch };
      } catch {
        // Not a valid git repo — keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 2. Fallback: scan `git worktree list` from workspacePath upward to `/`.
  // Phase 1 can miss when the worktree uses a gitfile (no `.git` directory). Each
  // ancestor of workspacePath is tried. Use workspacePath — not process.cwd() —
  // so daemon/launchd contexts (cwd `/`) still scan from the real worktree path,
  // and repos under `~/projects/...` are reachable without assuming `$HOME` is a repo.
  let scanDir = resolve(workspacePath);
  while (scanDir !== "/") {
    try {
      const output = (
        await execFileAsync("/usr/bin/git", ["-C", scanDir, "worktree", "list", "--porcelain"], {
          timeout: GIT_TIMEOUT,
          encoding: "utf8",
        })
      ).stdout.trim();
      const blocks = output.split("\n\n");
      for (const block of blocks) {
        const lines = block.trim().split("\n");
        let worktreePath = "";
        let gitdir = "";
        let branch = "";
        for (const line of lines) {
          if (line.startsWith("worktree ")) {
            worktreePath = line.slice("worktree ".length);
          } else if (line.startsWith("gitdir ")) {
            gitdir = line.slice("gitdir ".length);
          } else if (line.startsWith("branch ")) {
            branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
          }
        }
        if (resolve(worktreePath) === resolve(workspacePath) && gitdir) {
          // gitdir = /repo/.git/worktrees/<name>; .. → worktrees, ../.. → .git, ../../.. → repo root
          return { repoPath: resolve(gitdir, "..", "..", ".."), branch };
        }
      }
    } catch {
      // scanDir is not a valid git repo — walk up to its parent
    }
    const parent = dirname(scanDir);
    if (parent === scanDir) break;
    scanDir = parent;
  }

  return null;
}

type ExecFileFn = (
  file: string,
  args: readonly string[],
  opts: object,
) => Promise<{ stdout: string; stderr: string }>;

export async function getWorkspaceChangedFiles(
  workspacePath: string,
  baseBranch: string,
  execFn?: ExecFileFn,
): Promise<string[]> {
  const exec = execFn ?? execFileAsync;
  const parseLines = (stdout: string) =>
    stdout.split("\n").map((f) => f.trim()).filter((f) => f.length > 0);

  // 1. Diff against base branch
  try {
    const { stdout } = await exec("/usr/bin/git", ["diff", "--name-only", `${baseBranch}...HEAD`], { cwd: workspacePath, timeout: 10_000 });
    return parseLines(stdout);
  } catch { /* base branch not available locally */ }

  // 2. Diff against origin/base branch
  try {
    const { stdout } = await exec("/usr/bin/git", ["diff", "--name-only", `origin/${baseBranch}...HEAD`], { cwd: workspacePath, timeout: 10_000 });
    return parseLines(stdout);
  } catch { /* origin/base not fetched */ }

  // 3. Diff HEAD against its first parent — works in worktrees even without base ref
  try {
    const { stdout } = await exec("/usr/bin/git", ["diff", "--name-only", "HEAD~1"], { cwd: workspacePath, timeout: 10_000 });
    const files = parseLines(stdout);
    if (files.length > 0) {
      console.warn(`[worktree-git] Falling back to HEAD~1 diff for ${workspacePath}; base branch "${baseBranch}" not resolvable`);
      return files;
    }
  } catch { /* single-commit branch or shallow clone */ }

  console.warn(`[worktree-git] Could not resolve changed files for ${workspacePath}; base="${baseBranch}"`);
  return [];
}
