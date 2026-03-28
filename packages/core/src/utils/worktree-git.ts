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
  // 1. Walk up the directory tree from the worktree path looking for .git
  let dir = dirname(workspacePath);
  const root = dirname(homedir()); // stop at home
  while (dir !== root && dir !== "/") {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      try {
        const gitCommonDir = (
          await execFileAsync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
            timeout: GIT_TIMEOUT,
            encoding: "utf8",
          })
        ).stdout.trim();
        return { repoPath: resolve(gitCommonDir, ".."), branch: "" };
      } catch {
        // Not a valid git repo — keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 2. Fallback: scan git worktree list from homedir to find any repo that has this entry
  try {
    const output = (
      await execFileAsync("git", ["-C", homedir(), "worktree", "list", "--porcelain"], {
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
      if (worktreePath === workspacePath && gitdir) {
        // gitdir = /repo/.git/worktrees/<name>; .. → worktrees, ../.. → .git, ../../.. → repo root
        return { repoPath: resolve(gitdir, "..", "..", ".."), branch };
      }
    }
  } catch {
    // Best-effort
  }

  return null;
}
