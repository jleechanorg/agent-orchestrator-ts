import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Command } from "commander";
import chalk from "chalk";
import {
  createCorrelationId,
  createProjectObserver,
  generateConfigHash,
  loadConfig,
  parseTmuxName,
  type SessionManager,
} from "@jleechanorg/ao-core";
import { getLifecycleManager, getSessionManager } from "../lib/create-session-manager.js";
import {
  clearLifecycleWorkerPid,
  getLifecycleWorkerStatus,
  writeLifecycleWorkerPid,
} from "../lib/lifecycle-service.js";

const execFileAsync = promisify(execFile);

function parseInterval(value: string): number {
  const parsed = Number.parseInt(value, 10);
  // bd-fmv: 75s default (was 30s) — mitigates secondary rate limit risk from
  // concurrent lifecycle-workers polling GitHub every 30s with many sessions.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 75_000;
}

function parseDurationMs(value: string, fallbackMs: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

interface TmuxSessionInfo {
  name: string;
  activityMs: number | null;
}

const TMUX_TIMEOUT_MS = 5_000;

async function listTmuxSessionsWithActivity(): Promise<TmuxSessionInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      ["list-sessions", "-F", "#{session_name}\t#{session_activity}"],
      { timeout: TMUX_TIMEOUT_MS },
    );
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, activityRaw] = line.split("\t");
        const activitySeconds = Number.parseInt(activityRaw ?? "", 10);
        return {
          name,
          activityMs: Number.isFinite(activitySeconds) ? activitySeconds * 1000 : null,
        };
      });
  } catch {
    return [];
  }
}

async function sweepOrphanTmuxSessions(opts: {
  sessionManager: SessionManager;
  projectId: string;
  allProjectIds: string[];
  configHash: string;
  orphanTtlMs: number;
  observer: ReturnType<typeof createProjectObserver>;
}): Promise<void> {
  const { sessionManager, projectId, allProjectIds, configHash, orphanTtlMs, observer } = opts;
  const correlationId = createCorrelationId("lifecycle-worker");

  // Collect active runtime IDs across ALL projects in this config to avoid
  // cross-project false positives (all projects share the same configHash).
  const allSessionGroups = await Promise.all(allProjectIds.map((pid) => sessionManager.list(pid)));
  const activeRuntimeIds = new Set(
    allSessionGroups
      .flat()
      .map((s) => s.runtimeHandle?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );

  const now = Date.now();
  const tmuxSessions = await listTmuxSessionsWithActivity();
  let orphanCount = 0;
  let cleanedCount = 0;

  for (const tmuxSession of tmuxSessions) {
    const parsed = parseTmuxName(tmuxSession.name);
    if (!parsed) continue;
    if (parsed.hash !== configHash) continue;

    // Managed by AO DB (any project), skip.
    if (activeRuntimeIds.has(tmuxSession.name)) continue;

    // Fail-safe: if activity timestamp is missing, do NOT assume orphan.
    if (tmuxSession.activityMs === null) continue;
    const idleForMs = now - tmuxSession.activityMs;
    if (idleForMs < orphanTtlMs) continue;

    orphanCount += 1;
    try {
      await execFileAsync("tmux", ["kill-session", "-t", tmuxSession.name], {
        timeout: TMUX_TIMEOUT_MS,
      });
      cleanedCount += 1;
    } catch {
      // best-effort cleanup; continue with the rest
    }
  }

  if (orphanCount > 0) {
    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "lifecycle.tmux_orphan_sweep",
      outcome: cleanedCount > 0 ? "success" : "failure",
      correlationId,
      projectId,
      data: { orphanCount, cleanedCount, orphanTtlMs },
      level: cleanedCount > 0 ? "warn" : "error",
    });
  }
}

// AO session name pattern — matches ao-749, jc-12, etc.
const AO_SESSION_PATTERN = /^(ao|jc|wa|cc|ra|wc)-\d+$/;

async function isTmuxSessionAlive(sessionName: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["has-session", "-t", sessionName], {
      timeout: TMUX_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove git worktrees for AO sessions whose tmux session is dead and that are
 * no longer tracked in the AO session DB. Mirrors sweepOrphanTmuxSessions but
 * operates on git worktrees, preventing "refusing to fetch into checked-out
 * branch" errors in backfillUncoveredPRs. (harness: ghost-worktree-sweep)
 */
async function sweepOrphanWorktrees(opts: {
  sessionManager: SessionManager;
  projectId: string;
  allProjectIds: string[];
  configHash: string;
  worktreeBaseDir: string;
  orphanTtlMs: number;
  observer: ReturnType<typeof createProjectObserver>;
}): Promise<void> {
  const {
    sessionManager,
    projectId,
    allProjectIds,
    configHash,
    worktreeBaseDir,
    orphanTtlMs,
    observer,
  } = opts;
  const correlationId = createCorrelationId("lifecycle-worker");

  const allSessionGroups = await Promise.all(allProjectIds.map((pid) => sessionManager.list(pid)));
  const activeRuntimeIds = new Set(
    allSessionGroups
      .flat()
      .map((s) => s.runtimeHandle?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );

  // Worktrees live at <worktreeBaseDir>/<projectId>/<sessionId>/
  const projectWorktreeDir = join(worktreeBaseDir, projectId);
  let entries: string[];
  try {
    entries = readdirSync(projectWorktreeDir);
  } catch {
    // Worktree dir doesn't exist yet — nothing to sweep
    return;
  }

  const now = Date.now();
  let orphanCount = 0;
  let cleanedCount = 0;

  for (const entry of entries) {
    if (!AO_SESSION_PATTERN.test(entry)) continue;

    const fullPath = join(projectWorktreeDir, entry);
    // Tmux session name: "{configHash}-{sessionId}" (e.g. "bb5e6b7f8db3-ao-749")
    const tmuxSessionName = `${configHash}-${entry}`;

    // Fail-safe: skip if we can't stat the dir
    let mtime: number;
    try {
      mtime = statSync(fullPath).mtimeMs;
    } catch {
      continue;
    }

    if (now - mtime < orphanTtlMs) continue;
    // Skip if AO DB still knows about this session (any project)
    if (activeRuntimeIds.has(tmuxSessionName)) continue;
    // Skip if tmux session is still alive
    if (await isTmuxSessionAlive(tmuxSessionName)) continue;

    orphanCount += 1;
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", fullPath], {
        timeout: 15_000,
      });
      cleanedCount += 1;
    } catch {
      // best-effort cleanup; continue with the rest
    }
  }

  if (orphanCount > 0) {
    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "lifecycle.worktree_orphan_sweep",
      outcome: cleanedCount > 0 ? "success" : "failure",
      correlationId,
      projectId,
      data: { orphanCount, cleanedCount, orphanTtlMs, projectWorktreeDir },
      level: cleanedCount > 0 ? "warn" : "error",
    });
  }
}

export function registerLifecycleWorker(program: Command): void {
  program
    .command("lifecycle-worker")
    .description("Internal lifecycle polling worker")
    .argument("<project>", "Project ID from config")
    .option("--interval-ms <ms>", "Polling interval in milliseconds", "75000") // bd-fmv
    .option(
      "--orphan-sweep-interval-ms <ms>",
      "Interval for tmux orphan sweep in milliseconds",
      "300000",
    )
    .option(
      "--orphan-ttl-ms <ms>",
      "Idle threshold before orphan tmux sessions are cleaned",
      "21600000",
    )
    .action(
      async (
        projectId: string,
        opts: { intervalMs?: string; orphanSweepIntervalMs?: string; orphanTtlMs?: string },
      ) => {
        const config = loadConfig();
        const observer = createProjectObserver(config, "lifecycle-worker");
        if (!config.projects[projectId]) {
          observer.setHealth({
            surface: "lifecycle.worker",
            status: "error",
            projectId,
            correlationId: createCorrelationId("lifecycle-worker"),
            reason: `Unknown project: ${projectId}`,
            details: { projectId },
          });
          console.error(chalk.red(`Unknown project: ${projectId}`));
          process.exit(1);
        }

        const existing = getLifecycleWorkerStatus(config, projectId);
        if (existing.running && existing.pid !== process.pid) {
          // Another lifecycle worker is already running for this project — exit
          // silently to avoid duplicate polling loops.
          // Note: getLifecycleWorkerStatus already validates the PID is alive via
          // kill -0, so this is not a stale-PID false positive.
          observer.setHealth({
            surface: "lifecycle.worker",
            status: "warn",
            projectId,
            correlationId: createCorrelationId("lifecycle-worker"),
            reason: `Worker already running with pid ${existing.pid}`,
            details: { projectId, pid: existing.pid },
          });
          return;
        }

        const lifecycle = await getLifecycleManager(config, projectId);
        const sessionManager = await getSessionManager(config);
        const intervalMs = parseInterval(opts.intervalMs ?? "75000"); // bd-fmv
        const orphanSweepIntervalMs = parseDurationMs(opts.orphanSweepIntervalMs ?? "300000", 300_000);
        const orphanTtlMs = parseDurationMs(opts.orphanTtlMs ?? "21600000", 6 * 60 * 60 * 1000);
        const configHash = generateConfigHash(config.configPath);
        const allProjectIds = Object.keys(config.projects ?? {});
        // Worktrees live at ~/.worktrees/{projectId}/ — mirrors workspace-worktree plugin default.
        const worktreeBaseDir = join(homedir(), ".worktrees");
        let shuttingDown = false;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        let orphanSweepTimer: ReturnType<typeof setInterval> | null = null;

        const shutdown = (code: number): void => {
          if (shuttingDown) return;
          shuttingDown = true;
          if (heartbeat) clearInterval(heartbeat);
          if (orphanSweepTimer) clearInterval(orphanSweepTimer);
          lifecycle.stop();
          clearLifecycleWorkerPid(config, projectId, process.pid);
          observer.setHealth({
            surface: "lifecycle.worker",
            status: code === 0 ? "warn" : "error",
            projectId,
            correlationId: createCorrelationId("lifecycle-worker"),
            reason: code === 0 ? "Worker stopped" : "Worker exited unexpectedly",
            details: { projectId, pid: process.pid, exitCode: code },
          });
          // Flush stdout/stderr before exiting so crash messages reach the log file
          const done = (): void => process.exit(code);
          if (process.stdout.writableFinished && process.stderr.writableFinished) {
            done();
          } else {
            let flushed = 0;
            const tryExit = (): void => {
              flushed++;
              if (flushed >= 2) done();
            };
            process.stdout.write("", tryExit);
            process.stderr.write("", tryExit);
            // Hard exit if flush hangs
            setTimeout(done, 1_000).unref();
          }
        };

        process.on("SIGINT", () => shutdown(0));
        process.on("SIGTERM", () => shutdown(0));
        process.on("uncaughtException", (err) => {
          observer.recordOperation({
            metric: "lifecycle_poll",
            operation: "lifecycle.worker_crash",
            outcome: "failure",
            correlationId: createCorrelationId("lifecycle-worker"),
            projectId,
            reason: err instanceof Error ? err.message : String(err),
            level: "error",
          });
          shutdown(1);
        });
        process.on("unhandledRejection", (reason) => {
          observer.recordOperation({
            metric: "lifecycle_poll",
            operation: "lifecycle.worker_rejection",
            outcome: "failure",
            correlationId: createCorrelationId("lifecycle-worker"),
            projectId,
            reason: reason instanceof Error ? reason.message : String(reason),
            level: "error",
          });
          shutdown(1);
        });

        writeLifecycleWorkerPid(config, projectId, process.pid);
        observer.setHealth({
          surface: "lifecycle.worker",
          status: "ok",
          projectId,
          correlationId: createCorrelationId("lifecycle-worker"),
          details: { projectId, pid: process.pid, intervalMs, orphanSweepIntervalMs, orphanTtlMs },
        });

        // Periodic heartbeat so we can verify the worker is alive from the log
        heartbeat = setInterval(() => {
          observer.setHealth({
            surface: "lifecycle.worker",
            status: "ok",
            projectId,
            correlationId: createCorrelationId("lifecycle-worker"),
            details: { projectId, pid: process.pid, intervalMs, heartbeat: true },
          });
        }, 5 * 60_000); // every 5 minutes
        heartbeat.unref();

        orphanSweepTimer = setInterval(() => {
          sweepOrphanTmuxSessions({
            sessionManager,
            projectId,
            allProjectIds,
            configHash,
            orphanTtlMs,
            observer,
          }).catch(() => {
            // best-effort sweep; errors must not crash the lifecycle worker
          });
          sweepOrphanWorktrees({
            sessionManager,
            projectId,
            allProjectIds,
            configHash,
            worktreeBaseDir,
            orphanTtlMs,
            observer,
          }).catch(() => {
            // best-effort sweep; errors must not crash the lifecycle worker
          });
        }, orphanSweepIntervalMs);
        orphanSweepTimer.unref();

        // Run an immediate sweep at startup (best-effort)
        sweepOrphanTmuxSessions({
          sessionManager,
          projectId,
          allProjectIds,
          configHash,
          orphanTtlMs,
          observer,
        }).catch(() => {
          // best-effort sweep; errors must not crash the lifecycle worker
        });
        sweepOrphanWorktrees({
          sessionManager,
          projectId,
          allProjectIds,
          configHash,
          worktreeBaseDir,
          orphanTtlMs,
          observer,
        }).catch(() => {
          // best-effort sweep; errors must not crash the lifecycle worker
        });

        // bd-wse: Add startup jitter (0–10s) to stagger poll start across concurrent
        // project workers. Without this, all lifecycle-workers start polling at T=0
        // simultaneously, firing bursts of GitHub API calls that exhaust the rate limit.
        const jitterMs = Math.floor(Math.random() * Math.min(intervalMs, 10_000));
        if (jitterMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, jitterMs));
        }

        lifecycle.start(intervalMs);
      },
    );
}
