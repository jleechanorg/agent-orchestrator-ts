/**
 * Backfill extensions — spawns sessions for open PRs that have no active session.
 *
 * Extracted from lifecycle-manager.ts to keep the core polling loop minimal
 * and the backfill logic independently testable.
 *
 * @module backfill-extensions
 */

import type {
  PluginRegistry,
  SessionManager,
  Session,
  SCM,
  ProjectConfig,
} from "./types.js";
import type { ProjectObserver } from "./observability.js";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** Timeout for git commands in direct cleanup (30 seconds). */
const GIT_TIMEOUT = 30_000;

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

  const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
  if (!scm?.listOpenPRs) return false;

  // Set throttle AFTER confirming SCM supports listOpenPRs — so missing
  // support doesn't block retries when a different SCM plugin is loaded.
  lastBackfillTime = now;

  try {
    const openPRs = await scm.listOpenPRs(project);
    if (openPRs.length === 0) return false;

    // Build set of PR numbers AND branches covered by active sessions.
    // Sessions may not have pr.number set yet if detectPR hasn't run,
    // but they will have branch — match on both to avoid duplicate spawns.
    const coveredPRs = new Set<number>();
    const coveredBranches = new Set<string>();
    for (const s of activeSessions) {
      if (s.pr?.number) coveredPRs.add(s.pr.number);
      if (s.branch) coveredBranches.add(s.branch);
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
        // Don't pass branch to spawn — let claimPR handle checkout so
        // the workspace starts on the correct PR branch via SCM checkout.
        // pr.title is contributor-supplied — escape quotes to prevent prompt injection.
        const escapedTitle = pr.title
          .replace(/\\/g, "\\\\") // escape backslashes first
          .replace(/"/g, '\\"');
        const session = await sessionManager.spawn({
          projectId,
          // Label the title as untrusted contributor input so the agent does not
          // treat embedded text as system directives. Quotes prevent injection.
          prompt: `Continue working on PR #${pr.number}: [PR title: "${escapedTitle}"]. Check PR status, fix any blockers (CI failures, review comments, merge conflicts), and drive it to 6-green.`,
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
            try {
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
              let branch: string | null = null;
              let repoDir: string | null = null;

              if (existsSync(worktreeDir)) {
                // Directory still on disk — get branch and repo from it.
                try {
                  branch = execFileSync("git", ["-C", worktreeDir, "branch", "--show-current"], {
                    encoding: "utf8",
                    timeout: GIT_TIMEOUT,
                  }).trim();
                } catch { /* may be broken */ }
                try {
                  const gitCommon = execFileSync(
                    "git",
                    ["-C", worktreeDir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
                    { encoding: "utf8", timeout: GIT_TIMEOUT },
                  ).trim();
                  repoDir = resolve(gitCommon, "..");
                } catch { /* may be broken */ }
              }

              // If directory is gone or repo wasn't found via dir, scan git worktree
              // list from homedir to locate the worktree entry and recover branch+repo.
              if (repoDir === null) {
                try {
                  const listOutput = execFileSync(
                    "git",
                    ["-C", homedir(), "worktree", "list", "--porcelain"],
                    { encoding: "utf8", timeout: GIT_TIMEOUT },
                  ).trim();
                  const blocks = listOutput.split("\n\n");
                  for (const block of blocks) {
                    const lines = block.trim().split("\n");
                    let wp = "";
                    let gd = "";
                    let br = "";
                    for (const line of lines) {
                      if (line.startsWith("worktree ")) wp = line.slice("worktree ".length);
                      else if (line.startsWith("gitdir ")) gd = line.slice("gitdir ".length);
                      else if (line.startsWith("branch ")) br = line.slice("branch ".length).replace(/^refs\/heads\//, "");
                    }
                    if (wp === worktreeDir && gd) {
                      repoDir = resolve(gd, "..", "..");
                      if (!branch) branch = br || null;
                      break;
                    }
                  }
                } catch { /* best-effort — scan may fail */ }
              }

              // Unlock + remove worktree (--force --force mirrors destroy()).
              if (repoDir) {
                try {
                  execFileSync("git", ["-C", repoDir, "worktree", "unlock", worktreeDir], {
                    encoding: "utf8",
                    timeout: GIT_TIMEOUT,
                  });
                } catch { /* best-effort */ }
                try {
                  execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", "--force", worktreeDir], {
                    encoding: "utf8",
                    timeout: GIT_TIMEOUT,
                  });
                } catch { /* best-effort */ }
                try {
                  execFileSync("git", ["-C", repoDir, "worktree", "prune"], { encoding: "utf8", timeout: GIT_TIMEOUT });
                } catch { /* best-effort */ }
                // Delete stale local branch to prevent cascading fetch failures.
                // Only delete branches that look AO-managed (feat/*, session/*, fix/*).
                if (branch && /^(feat|fix|chore|docs|refactor|session)\//.test(branch)) {
                  try {
                    execFileSync("git", ["-C", repoDir, "branch", "-D", branch], { encoding: "utf8", timeout: GIT_TIMEOUT });
                  } catch { /* best-effort */ }
                }
              }

              // Last resort: remove directory if it still exists on disk.
              if (existsSync(worktreeDir)) {
                rmSync(worktreeDir, { recursive: true, force: true });
              }

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
            } catch (cleanupErr) {
              observer.recordOperation({
                metric: "lifecycle_poll",
                operation: "lifecycle.backfill.direct_cleanup_failed",
                outcome: "failure",
                correlationId,
                projectId,
                sessionId: session.id,
                data: { error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) },
                level: "warn",
              });
            }
            // Direct cleanup attempted — try next PR rather than aborting entirely.
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
          // Stop if claim keeps failing — systemic workspace issue (e.g. all PRs CONFLICTING)
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
