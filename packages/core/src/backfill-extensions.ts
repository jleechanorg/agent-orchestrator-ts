/**
 * Backfill extensions — spawns sessions for open PRs that have no active session.
 *
 * Extracted from lifecycle-manager.ts to keep the core polling loop minimal
 * and the backfill logic independently testable.
 *
 * @module backfill-extensions
 */

import { type PluginRegistry, type SessionManager, type Session, type SCM, type ProjectConfig, TERMINAL_STATUSES } from "./types.js";
import type { ProjectObserver } from "./observability.js";
import { sortReviewsNewestFirst } from "./merge-gate-coderabbit.js";
import { hasSession } from "./tmux.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Timeout for git commands in direct cleanup (30 seconds). */
const GIT_TIMEOUT = 30_000;

import { findRepoPathForWorktree } from "./utils/worktree-git.js";

/** Dependencies injected by the lifecycle-manager call site. */
export interface BackfillDeps {
  registry: PluginRegistry;
  sessionManager: SessionManager;
  observer: ProjectObserver;
}

/** Parameters for a single backfill invocation. */
export interface BackfillParams {
  projectId: string;
  project: ProjectConfig;
  activeSessions: Session[];
  correlationId: string;
  /** Optional configured worktree root (from config.worktreeDir). */
  worktreeDir?: string;
}

// ---- module-level throttle state ----
let lastBackfillTime = 0;
const BACKFILL_INTERVAL_MS = 5 * 60_000; // 5 minutes

/** Reset throttle state — exposed for testing only. */
export function _resetBackfillTimer(): void {
  lastBackfillTime = 0;
}

/** Per-cycle rate-limit counter for CHANGES_REQUESTED PR respawns. */
let changesRequestedRespawnCount = 0;
const MAX_CHANGES_REQUESTED_RESPAWNS_PER_CYCLE = 2;

/** Reset CR respawn counter — exposed for testing only. */
export function _resetCrRespawnCounter(): void {
  changesRequestedRespawnCount = 0;
}

/** Expand ~ to home directory (mirrors workspace-worktree expandPath). */
function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

/**
 * Spawn a session for the first uncovered, non-draft open PR.
 *
 * Throttled to run at most once per `BACKFILL_INTERVAL_MS`.
 * Returns `true` when a new session was successfully spawned.
 */
export async function backfillUncoveredPRs(
  deps: BackfillDeps,
  params: BackfillParams,
): Promise<boolean> {
  const { registry, sessionManager, observer } = deps;
  const { projectId, project, activeSessions, correlationId } = params;

  const now = Date.now();
  if (now - lastBackfillTime < BACKFILL_INTERVAL_MS) return false;

  const scmNullable = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
  if (!scmNullable) return false;
  const listOpenPRs = scmNullable.listOpenPRs?.bind(scmNullable);
  if (!listOpenPRs) return false;
  const scm: SCM = scmNullable;

  // Set throttle AFTER confirming SCM supports listOpenPRs — so missing
  // support doesn't block retries when a different SCM plugin is loaded.
  lastBackfillTime = now;

  // Reset per-cycle rate-limit counters.
  // Counter is scoped per backfill invocation (each invocation is one "cycle").
  // Backfill processes ONE PR per cycle and returns after first spawn+claim.
  // With MAX=2: first backfill call respawns 1 CR-PR, counter=1;
  // second backfill call (5 min later) respawns another, counter=2;
  // third backfill call skips CR-PRs since counter>=MAX.
  // This deliberate design keeps each backfill call fast and bounded.
  changesRequestedRespawnCount = 0;

  try {
    const openPRs = await listOpenPRs(project);
    if (openPRs.length === 0) return false;

    // Build set of PR numbers AND branches covered by LIVE sessions.
    // Build-from-alive (instead of populate-then-delete) avoids a race: if two
    // sessions share the same PR/branch and only one is dead, the delete approach
    // would remove the entry entirely even though a live session still covers it.
    // Non-tmux runtimes are counted as live immediately — we have no way to probe
    // their liveness from tmux.  Tmux runtimes are checked via hasSession; on error
    // treat the session as live (fail-open) to avoid spuriously uncovering PRs.
    const coveredPRs = new Set<number>();
    const coveredBranches = new Set<string>();
    for (const session of activeSessions) {
      if (TERMINAL_STATUSES.has(session.status)) continue;
      if (session.pr?.number) coveredPRs.add(session.pr.number);
      if (session.branch) coveredBranches.add(session.branch);
    }
    // Remove entries whose tmux session is actually dead.
    for (const session of activeSessions) {
      if (TERMINAL_STATUSES.has(session.status)) continue;
      if (!session.runtimeHandle || session.runtimeHandle.runtimeName !== "tmux") continue;
      let live: boolean;
      try {
        live = await hasSession(session.runtimeHandle.id);
      } catch {
        live = true; // fail-open: tmux error → treat session as live
      }
      if (!live) {
        if (session.pr?.number) coveredPRs.delete(session.pr.number);
        if (session.branch) coveredBranches.delete(session.branch);
      }
    }

    // Find uncovered PRs (skip drafts, check both PR number and branch)
    const uncovered = openPRs.filter(
      (pr) => !pr.isDraft && !coveredPRs.has(pr.number) && !coveredBranches.has(pr.branch),
    );

    if (uncovered.length === 0) return false;

    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "lifecycle.backfill.detected",
      outcome: "success",
      correlationId,
      projectId,
      data: {
        openPRs: openPRs.length,
        activeSessions: activeSessions.length,
        coveredPRs: coveredPRs.size,
        uncoveredCount: uncovered.length,
        uncoveredPRs: uncovered.map((pr) => pr.number),
      },
      level: "info",
    });

    // Spawn one session at a time to avoid thundering herd.
    // If spawn/claim fails for a PR, skip it and try the next uncovered PR.
    // Stop after 3 total spawn OR claim failures to avoid unbounded churn.
    // Spawn failures indicate systemic issues (project paused, missing plugin, etc.)
    // Claim failures indicate systemic workspace issues (CONFLICTING PR, locked ws, etc.)
    // Counters are independent — claim failures accumulate across spawn successes.
    const MAX_CONSECUTIVE_SPAWN_FAILURES = 3;
    const MAX_CONSECUTIVE_CLAIM_FAILURES = 3;
    let consecutiveSpawnFailures = 0;
    let consecutiveClaimFailures = 0;
    for (const pr of uncovered) {
      try {
        // Fetch reviewDecision to identify CHANGES_REQUESTED PRs.
        // Fail-open: if the call fails, treat as non-CHANGES_REQUESTED.
        let decision = "pending";
        let crBody: string | undefined;
        try {
          decision = await scm.getReviewDecision(pr);
        } catch { /* fail-open */ }

        if (decision === "changes_requested") {
          // Rate-limit: skip CHANGES_REQUESTED PRs beyond the per-cycle cap.
          if (changesRequestedRespawnCount >= MAX_CHANGES_REQUESTED_RESPAWNS_PER_CYCLE) {
            continue;
          }

          // Fetch CR review body for context injection.
          // Fail-open: if getReviews fails, proceed without context.
          try {
            const reviews = await scm.getReviews(pr);
            const sorted = [...reviews]
              .filter((r) => r.author === "coderabbitai[bot]")
              .sort(sortReviewsNewestFirst);
            crBody = sorted.find((r) => r.state === "changes_requested")?.body;
          } catch { /* fail-open */ }
        }

        // Build spawn prompt: CR context when available, generic fallback otherwise.
        // crBody is contributor-controlled (from PR review text) — escape quotes,
        // backslashes, and the prompt delimiter (---) to prevent prompt injection.
        // Truncate to 5000 chars after sanitization.
        let prompt: string;
        if (decision === "changes_requested" && crBody) {
          const safeBody = crBody
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/^---$/gm, "\\-\\-\\-")
            .slice(0, 5000);
          prompt = `CodeRabbit posted CHANGES_REQUESTED on PR #${pr.number} (${pr.url}).
The review comments are:
---
${safeBody}
---
Fix exactly these items, commit with [agento], and push.`;
        } else {
          const escapedTitle = pr.title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          prompt = `Continue working on PR #${pr.number}: [PR title: "${escapedTitle}"]. Check PR status, fix any blockers (CI failures, review comments, merge conflicts), and drive it to 7-green.`;
        }

        // Don't pass branch to spawn — let claimPR handle checkout so
        // the workspace starts on the correct PR branch via SCM checkout.
        const session = await sessionManager.spawn({
          projectId,
          // Label the title as untrusted contributor input so the agent does not
          // treat embedded text as system directives. Quotes prevent injection.
          prompt,
        });

        // Claim the PR for this session — this checks out the branch
        try {
          await sessionManager.claimPR(session.id, String(pr.number));
          consecutiveSpawnFailures = 0; // reset when both succeed
        } catch (claimErr) {
          consecutiveClaimFailures++;
          observer.recordOperation({
            metric: "lifecycle_poll",
            operation: "lifecycle.backfill.claim_failed",
            outcome: "failure",
            correlationId,
            projectId,
            sessionId: session.id,
            data: {
              prNumber: pr.number,
              consecutiveClaimFailures,
              error: claimErr instanceof Error ? claimErr.message : String(claimErr),
            },
            level: "warn",
          });
          // If kill fails, attempt direct worktree cleanup before aborting.
          // The session may not be fully registered yet so kill() can't find it,
          // but we know the session ID and can compute the workspace path.
          try {
            await sessionManager.kill(session.id);
          } catch (killErr) {
            observer.recordOperation({
              metric: "lifecycle_poll",
              operation: "lifecycle.backfill.orphan_cleanup_failed",
              outcome: "failure",
              correlationId,
              projectId,
              sessionId: session.id,
              data: {
                prNumber: pr.number,
                error: killErr instanceof Error ? killErr.message : String(killErr),
              },
              level: "warn",
            });
            // Direct worktree cleanup fallback — session wasn't registered so
            // kill() couldn't find it, but we know where the worktree lives.
            // Runs as an async IIFE so we can use execFileAsync (non-blocking) instead
            // of execFileSync, avoiding event-loop stalls when many stale worktrees exist.
            let cleanupOk = false;
            let cleanupErr: unknown;
            let branch: string | null = null;
            try {
              await (async () => {
                // Prefer global worktreeDir (config), then project.worktreeDir,
                // then the standard ~/.worktrees/{projectId}/{sessionId} path.
                // expandPath handles ~ expansion for custom worktreeDir paths.
                const worktreeRoot = expandPath(
                  params.worktreeDir ||
                    (project as { worktreeDir?: string }).worktreeDir ||
                    resolve(homedir(), ".worktrees"),
                );
                const worktreeDir = resolve(worktreeRoot, projectId, session.id);

                // Always attempt git-level cleanup even when the directory is already
                // gone — the git worktree entry can persist and block the next claim.
                // Capture branch (from worktree dir if it exists, else from git list).
                // Use project.path as the owning repo — avoid re-discovering via sibling scan.
                let repoDir: string | null = null;

                if (existsSync(worktreeDir)) {
                  // Directory still on disk — get branch and repo from it.
                  try {
                    branch = (
                      await execFileAsync("git", ["-C", worktreeDir, "branch", "--show-current"], {
                        timeout: GIT_TIMEOUT,
                        encoding: "utf8",
                      })
                    ).stdout.trim();
                  } catch { /* may be broken */ }
                  try {
                    const gitCommon = (
                      await execFileAsync(
                        "git",
                        ["-C", worktreeDir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
                        { timeout: GIT_TIMEOUT, encoding: "utf8" },
                      )
                    ).stdout.trim();
                    repoDir = resolve(gitCommon, "..");
                  } catch { /* may be broken */ }
                }

                // If repo wasn't resolved from the worktree dir, use project.path directly
                // (the owning repo is already known from the backfill caller's project param).
                // Resolve to handle relative paths; validate by checking the worktree appears
                // in git worktree list; fall back to the sibling scan only if that fails.
                if (repoDir === null) {
                  const candidateRepo = expandPath(project.path);
                  try {
                    const listOutput = (
                      await execFileAsync(
                        "git",
                        ["-C", candidateRepo, "worktree", "list", "--porcelain"],
                        { timeout: GIT_TIMEOUT, encoding: "utf8" },
                      )
                    ).stdout.trim();
                    // Verify the stale worktree is registered under this repo
                    const blocks = listOutput.split("\n\n");
                    for (const block of blocks) {
                      const lines = block.trim().split("\n");
                      let wp = "";
                      let br = "";
                      for (const line of lines) {
                        if (line.startsWith("worktree ")) wp = line.slice("worktree ".length);
                        else if (line.startsWith("branch "))
                          br = line.slice("branch ".length).replace(/^refs\/heads\//, "");
                      }
                      if (wp === worktreeDir) {
                        repoDir = candidateRepo;
                        if (!branch) branch = br || null;
                        break;
                      }
                    }
                  } catch { /* project.path is not a valid repo — try sibling scan below */ }
                }

                // Last resort: scan sibling worktree directories under projectWorktreeDir to
                // find the repo that has worktreeDir registered. homedir() is not a git repo
                // so we can't scan from there directly.
                if (repoDir === null) {
                  try {
                    const projectWorktreeDir = resolve(worktreeRoot, projectId);
                    if (existsSync(projectWorktreeDir)) {
                      const entries = readdirSync(projectWorktreeDir);
                      for (const entry of entries) {
                        const candidatePath = join(projectWorktreeDir, entry);
                        if (!entry.startsWith(".")) {
                          try {
                            const listOutput = (
                              await execFileAsync(
                                "git",
                                ["-C", candidatePath, "worktree", "list", "--porcelain"],
                                { timeout: GIT_TIMEOUT, encoding: "utf8" },
                              )
                            ).stdout.trim();
                            const blocks = listOutput.split("\n\n");
                            for (const block of blocks) {
                              const lines = block.trim().split("\n");
                              let wp = "";
                              let gd = "";
                              let br = "";
                              for (const line of lines) {
                                if (line.startsWith("worktree ")) wp = line.slice("worktree ".length);
                                else if (line.startsWith("gitdir ")) gd = line.slice("gitdir ".length);
                                else if (line.startsWith("branch "))
                                  br = line.slice("branch ".length).replace(/^refs\/heads\//, "");
                              }
                              if (wp === worktreeDir && gd) {
                                // gitdir = /repo/.git/worktrees/<name>; .. → worktrees, ../.. → .git, ../../.. → repo root
                                repoDir = resolve(gd, "..", "..", "..");
                                if (!branch) branch = br || null;
                                break;
                              }
                            }
                            if (repoDir !== null) break;
                          } catch { /* candidate not a git repo — try next */ }
                        }
                      }
                    }
                  } catch { /* best-effort */ }
                }

                // Absolute last resort: walk up from the worktree path or scan git worktree
                // list from homedir to find the owning repo. This handles the case where
                // the worktree directory has been deleted from disk but its git entry and
                // local branch remain — without cleanup the branch poisons all future
                // backfill attempts for the same PR (git refuses to `worktree add -b <branch>`
                // when the branch already exists locally).
                if (repoDir === null) {
                  const fallback = await findRepoPathForWorktree(worktreeDir);
                  if (fallback) {
                    repoDir = fallback.repoPath;
                    if (!branch) branch = fallback.branch || null;
                  }
                }

                // Unlock + remove worktree (--force --force mirrors destroy()).
                if (repoDir) {
                  try {
                    await execFileAsync("git", ["-C", repoDir, "worktree", "unlock", worktreeDir], {
                      timeout: GIT_TIMEOUT,
                      encoding: "utf8",
                    });
                  } catch { /* best-effort */ }
                  try {
                    await execFileAsync(
                      "git",
                      ["-C", repoDir, "worktree", "remove", "--force", "--force", worktreeDir],
                      { timeout: GIT_TIMEOUT, encoding: "utf8" },
                    );
                  } catch { /* best-effort */ }
                  try {
                    await execFileAsync("git", ["-C", repoDir, "worktree", "prune"], {
                      timeout: GIT_TIMEOUT,
                      encoding: "utf8",
                    });
                  } catch { /* best-effort */ }
                  // Delete stale local branch to prevent cascading fetch failures.
                  // Only delete branches that look AO-managed (feat/*, session/*, fix/*).
                  if (branch && /^(feat|fix|chore|docs|refactor|session)\//.test(branch)) {
                    try {
                      await execFileAsync("git", ["-C", repoDir, "branch", "-D", branch], {
                        timeout: GIT_TIMEOUT,
                        encoding: "utf8",
                      });
                    } catch { /* best-effort */ }
                  }
                }

                // Last resort: remove directory if it still exists on disk.
                if (existsSync(worktreeDir)) {
                  rmSync(worktreeDir, { recursive: true, force: true });
                }

                // Postcondition check: only mark cleanup as successful if the worktree
                // is actually gone. Each git step above is best-effort (wrapped in
                // individual try/catch), so we must independently verify the outcome.
                // Wrap in a dedicated try/catch so transient git failures (timeouts,
                // network glitches) during verification don't abort the backfill
                // even when the cleanup actually succeeded (worktree gone from disk).
                let postconditionErr: unknown;
                if (repoDir) {
                  try {
                    const listOut = (
                      await execFileAsync(
                        "git",
                        ["-C", repoDir, "worktree", "list", "--porcelain"],
                        { timeout: GIT_TIMEOUT, encoding: "utf8" },
                      )
                    ).stdout.trim();
                    const stillRegistered = listOut.split("\n\n").some((block) => {
                      const lines = block.trim().split("\n");
                      for (const line of lines) {
                        if (
                          line.startsWith("worktree ") &&
                          line.slice("worktree ".length) === worktreeDir
                        ) {
                          return true;
                        }
                      }
                      return false;
                    });
                    if (stillRegistered) {
                      postconditionErr = new Error(
                        `worktree ${worktreeDir} still registered in ${repoDir} after cleanup`,
                      );
                    } else {
                      cleanupOk = true;
                    }
                  } catch (e) {
                    postconditionErr = e;
                    // Transient git failure (timeout, I/O error) — verify the directory
                    // is actually gone from disk before reporting failure. If the worktree
                    // was removed, the cleanup succeeded even if git verification errored.
                    if (!existsSync(worktreeDir)) {
                      cleanupOk = true;
                    } else {
                      cleanupErr = postconditionErr;
                    }
                  }
                  // Fail only when the worktree is still on disk (git remove silently failed).
                  // When the directory is gone, cleanup succeeded regardless of git state.
                  if (postconditionErr !== undefined && !cleanupOk) {
                    cleanupErr = postconditionErr;
                  }
                } else {
                  // repoDir unknown — directory removed but git worktree entry unverified.
                  // Log for operator visibility; the entry may persist and block future claims.
                  console.warn(
                    `[backfill] cleanup: removed ${worktreeDir} but could not verify git worktree entry removal (owning repo unknown)`,
                  );
                }
              })();
              // Propagate any error captured inside the IIFE (e.g. from directory removal).
            } catch (e) {
              cleanupErr = e;
            }

            if (cleanupOk) {
              observer.recordOperation({
                metric: "lifecycle_poll",
                operation: "lifecycle.backfill.direct_cleanup_success",
                outcome: "success",
                correlationId,
                projectId,
                sessionId: session.id,
                data: { prNumber: pr.number, branch },
                level: "info",
              });
            } else {
              observer.recordOperation({
                metric: "lifecycle_poll",
                operation: "lifecycle.backfill.direct_cleanup_failed",
                outcome: "failure",
                correlationId,
                projectId,
                sessionId: session.id,
                data: {
                  error: cleanupErr !== undefined
                    ? (cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr))
                    : "repoDir unknown — directory removed but git worktree entry could not be verified (operator should check manually)",
                },
                level: "warn",
              });
              // Abort backfill — direct cleanup failed so we cannot safely try the
              // next PR; each additional spawn would leak another orphan session.
              return false;
            }
          }
          // Reached when kill() succeeded (no orphan) — or after direct cleanup succeeded.
          // Unified abort check for both paths: stop if systemic workspace issue.
          if (consecutiveClaimFailures >= MAX_CONSECUTIVE_CLAIM_FAILURES) {
            observer.recordOperation({
              metric: "lifecycle_poll",
              operation: "lifecycle.backfill.claim_failed_abort",
              outcome: "failure",
              correlationId,
              projectId,
              data: { consecutiveClaimFailures },
              level: "warn",
            });
            return false;
          }
          continue; // try next uncovered PR
        }

        consecutiveSpawnFailures = 0; // both spawn AND claim succeeded
        // Increment CR rate-limit counter only after both spawn and claim succeeded.
        // This prevents failed attempts from burning rate-limit slots.
        if (decision === "changes_requested") {
          changesRequestedRespawnCount++;
        }

        observer.recordOperation({
          metric: "lifecycle_poll",
          operation: "lifecycle.backfill.spawned",
          outcome: "success",
          correlationId,
          projectId,
          sessionId: session.id,
          data: { prNumber: pr.number, prTitle: pr.title, branch: pr.branch },
          level: "info",
        });
        return true;
      } catch (spawnErr) {
        consecutiveSpawnFailures++;
        observer.recordOperation({
          metric: "lifecycle_poll",
          operation: "lifecycle.backfill.spawn_failed",
          outcome: "failure",
          correlationId,
          projectId,
          data: {
            prNumber: pr.number,
            consecutiveSpawnFailures,
            error: spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
          },
          level: "warn",
        });
        // Stop after MAX_CONSECUTIVE_SPAWN_FAILURES — systemic issue (project paused,
        // missing plugin, etc.) will fail every PR identically in this cycle.
        if (consecutiveSpawnFailures >= MAX_CONSECUTIVE_SPAWN_FAILURES) {
          observer.recordOperation({
            metric: "lifecycle_poll",
            operation: "lifecycle.backfill.spawn_failed_abort",
            outcome: "failure",
            correlationId,
            projectId,
            data: { consecutiveSpawnFailures },
            level: "warn",
          });
          return false;
        }
        continue; // try next uncovered PR
      }
    }
  } catch (listErr) {
    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "lifecycle.backfill.list_failed",
      outcome: "failure",
      correlationId,
      projectId,
      data: {
        error: listErr instanceof Error ? listErr.message : String(listErr),
      },
      level: "warn",
    });
  }
  return false;
}
