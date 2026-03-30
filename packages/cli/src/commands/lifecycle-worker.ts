import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { Command } from "commander";
import chalk from "chalk";
import {
  createCorrelationId,
  createProjectObserver,
  expandHome,
  generateConfigHash,
  loadConfig,
  parseTmuxName,
  type SessionManager,
} from "@jleechanorg/ao-core";
import { getLifecycleManager, getSessionManager } from "../lib/create-session-manager.js";
import {
  clearLifecycleWorkerPid,
  forceLifecycleLock,
  getLifecycleLockFile,
  getLifecycleWorkerStatus,
  tryAcquireLifecycleLock,
  writeLifecycleWorkerPid,
} from "../lib/lifecycle-service.js";
import {
  listTmuxSessionsWithActivity,
  sweepOrphanWorktrees,
} from "./orphan-sweep.js";

const execFileAsync = promisify(execFile);

const TMUX_TIMEOUT_MS = 5_000;

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
  const tmuxResult = await listTmuxSessionsWithActivity();
  if (!tmuxResult.available) {
    // no_server: no tmux server running — nothing to do
    // error: log the failure and continue (best-effort)
    if (tmuxResult.reason === "error") {
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.orphan_tmux_sweep",
        outcome: "failure",
        correlationId,
        projectId,
        data: { message: tmuxResult.message ?? "" },
        level: "warn",
        reason: `tmux list-sessions failed: ${tmuxResult.message}`,
      });
    }
    return;
  }
  const tmuxSessions = tmuxResult.sessions;
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
    .option(
      "--force",
      "Override the startup lock and PID-file dedup check. Use for recovery " +
      "scenarios when the existing worker is known-dead and the lock is stale.",
      false,
    )
    .action(
      async (
        projectId: string,
        opts: { intervalMs?: string; orphanSweepIntervalMs?: string; orphanTtlMs?: string; force?: boolean },
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

        // orch-886k: acquire an exclusive lock before checking status or writing
        // the PID file. This closes the TOCTOU window that allowed two concurrent
        // lifecycle-worker processes (e.g. launchd restart + ao start) to both
        // pass the "not running" check before either recorded its PID.
        // --force skips the lock check entirely so operators can override stale locks.
        const releaseLock = opts.force
          ? null
          : tryAcquireLifecycleLock(config, projectId);

        if (releaseLock === null && !opts.force) {
          // Lock held by a live peer — yield.
          const existingLocked = getLifecycleWorkerStatus(config, projectId);
          // When pid is null (peer has no PID file yet), read directly from the
          // lock file — the peer wrote its PID there so we can surface it.
          const lockFile = getLifecycleLockFile(config, projectId);
          let peerPid = existingLocked.pid;
          if (peerPid === null) {
            try {
              const raw = readFileSync(lockFile, "utf-8").trim();
              const parsed = Number.parseInt(raw, 10);
              if (Number.isFinite(parsed) && parsed > 0) peerPid = parsed;
            } catch { /* lock file gone or unreadable — leave null */ }
          }
          observer.setHealth({
            surface: "lifecycle.worker",
            status: "warn",
            projectId,
            correlationId: createCorrelationId("lifecycle-worker"),
            reason: existingLocked.running && existingLocked.pid !== process.pid
              ? `Worker already running with pid ${existingLocked.pid} (lock held)`
              : "Startup lock held by peer; yielding to avoid duplicate worker",
            details: { projectId, pid: peerPid },
          });
          return;
        }

        if (!releaseLock && opts.force) {
          // --force: use forceLifecycleLock which reads the current owner PID,
          // confirms it's dead (ps check), then atomically clears and re-acquires.
          // Returns null if the lock is held by a live process — we yield rather
          // than steal a peer's lock. (orch-886k)
          console.warn(
            chalk.yellow(`[orch-886k] --force set: attempting lock reacquisition for project "${projectId}"`),
          );
          const reAcquire = forceLifecycleLock(config, projectId);
          if (reAcquire === null) {
            // Lock is held by a live process — yield to the peer rather than
            // steal it. (orch-886k)
            const lockFile = getLifecycleLockFile(config, projectId);
            let peerPid: number | null = null;
            try {
              const raw = readFileSync(lockFile, "utf-8").trim();
              const parsed = Number.parseInt(raw, 10);
              if (Number.isFinite(parsed) && parsed > 0) peerPid = parsed;
            } catch { /* lock file gone or unreadable */ }
            observer.setHealth({
              surface: "lifecycle.worker",
              status: "warn",
              projectId,
              correlationId: createCorrelationId("lifecycle-worker"),
              reason: "Lock held by live peer; yielding to avoid duplicate worker",
              details: { projectId, pid: peerPid ?? process.pid },
            });
            return;
          }
          // Hold the lock across writeLifecycleWorkerPid so no peer races past.
          // (orch-886k)
          try {
            writeLifecycleWorkerPid(config, projectId, process.pid);
          } finally {
            reAcquire();
          }
        } else {
          // Normal path: hold the lock, check peer status, write our PID.
          let skipStartup = false;
          let skipReason = "";
          let skipDetails: Record<string, unknown> = {};
          try {
            const existing = getLifecycleWorkerStatus(config, projectId);
            if (existing.running && existing.pid !== process.pid) {
              skipStartup = true;
              skipReason = `Worker already running with pid ${existing.pid}`;
              skipDetails = { projectId, pid: existing.pid };
            } else if (existing.verified === null) {
              // ps failed — a genuine worker may be running and we cannot confirm.
              // Leave the PID file intact so the next call can retry; do not
              // overwrite with our PID and risk creating a duplicate. (orch-886k)
              skipStartup = true;
              skipReason = "Cannot verify peer state (ps failed); refusing to start to avoid duplicate worker";
              skipDetails = { projectId, pid: existing.pid };
            } else {
              // Record our PID while holding the lock so no peer races past this
              // point. (orch-886k)
              writeLifecycleWorkerPid(config, projectId, process.pid);
            }
          } finally {
            // Always release the lock, even on throw.
            releaseLock!();
          }

          if (skipStartup) {
            observer.setHealth({
              surface: "lifecycle.worker",
              status: "warn",
              projectId,
              correlationId: createCorrelationId("lifecycle-worker"),
              reason: skipReason,
              details: skipDetails,
            });
            return;
          }
        }

        const lifecycle = await getLifecycleManager(config, projectId);
        const sessionManager = await getSessionManager(config);
        const intervalMs = parseInterval(opts.intervalMs ?? "75000"); // bd-fmv
        const orphanSweepIntervalMs = parseDurationMs(opts.orphanSweepIntervalMs ?? "300000", 300_000);
        const orphanTtlMs = parseDurationMs(opts.orphanTtlMs ?? "21600000", 6 * 60 * 60 * 1000);
        const configHash = generateConfigHash(config.configPath);
        const allProjectIds = Object.keys(config.projects ?? {});
        // Worktrees live at <worktreeDir>/{projectId>/ where worktreeDir comes from
        // the workspace-worktree plugin config. Mirrors the same lookup in the plugin.
        // Check per-project override, then global config.
        const projectWorktreeDir = config.projects[projectId]?.worktreeDir;
        const globalWorktreeDir = config.worktreeDir;
        const configuredWorktreeDir = projectWorktreeDir ?? globalWorktreeDir;
        const worktreeBaseDir = configuredWorktreeDir
          ? expandHome(configuredWorktreeDir)
          : expandHome("~/.worktrees");
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
