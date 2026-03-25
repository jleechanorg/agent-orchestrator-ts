import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getProjectBaseDir, type OrchestratorConfig } from "@jleechanorg/ao-core";

const LIFECYCLE_PID_FILE = "lifecycle-worker.pid";
const LIFECYCLE_LOCK_FILE = "lifecycle-worker.lock";
const LIFECYCLE_LOG_FILE = "lifecycle-worker.log";
const DEFAULT_START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 5_000;

export interface LifecycleWorkerStatus {
  running: boolean;
  pid: number | null;
  /** Whether the PID was verified as a genuine lifecycle-worker via ps. */
  verified: boolean | null;
  pidFile: string;
  logFile: string;
}

function getProjectBase(config: OrchestratorConfig, projectId: string): string {
  const project = config.projects[projectId];
  if (!project) {
    throw new Error(`Unknown project: ${projectId}`);
  }
  return getProjectBaseDir(config.configPath, project.path);
}

export function getLifecyclePidFile(config: OrchestratorConfig, projectId: string): string {
  return join(getProjectBase(config, projectId), LIFECYCLE_PID_FILE);
}

export function getLifecycleLogFile(config: OrchestratorConfig, projectId: string): string {
  return join(getProjectBase(config, projectId), LIFECYCLE_LOG_FILE);
}

export function getLifecycleLockFile(config: OrchestratorConfig, projectId: string): string {
  return join(getProjectBase(config, projectId), LIFECYCLE_LOCK_FILE);
}

/**
 * Attempt to atomically claim the lifecycle-worker startup lock for a project.
 *
 * Uses O_EXCL so only one process can create the lock file. Returns a release
 * function on success, or null if another process holds the lock.
 *
 * If the lock file already exists, this function checks whether the owning
 * process is still alive. If the process is dead (crashed without releasing the
 * lock), the stale lock is reaped and acquisition is retried atomically.
 * This prevents a crashed worker from permanently blocking all future startups.
 *
 * This closes the TOCTOU window between getLifecycleWorkerStatus() and
 * writeLifecycleWorkerPid(): without this lock, two concurrent lifecycle-worker
 * processes (e.g. launchd restart + ao start) can both pass the dedup check
 * before either writes its PID. (orch-886k)
 */
export function tryAcquireLifecycleLock(
  config: OrchestratorConfig,
  projectId: string,
): (() => void) | null {
  const lockFile = getLifecycleLockFile(config, projectId);
  const baseDir = getProjectBase(config, projectId);

  const _reapStaleLock = (): boolean => {
    // Read the PID stored in the stale lock file.
    let stalePid: number;
    try {
      const raw = readFileSync(lockFile, "utf-8").trim();
      stalePid = Number.parseInt(raw, 10);
    } catch {
      return false;
    }
    if (!Number.isFinite(stalePid) || stalePid === process.pid) return false;

    try {
      // -ww: do not truncate the command column (avoids false negatives for
      // long command lines on macOS/BSD).
      // -p: select only the specific PID.
      // -o args=: output only the command line, no header.
      const cmdline = execFileSync("ps", ["-ww", "-p", String(stalePid), "-o", "args="], {
        timeout: 3_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString("utf-8").trim();

      // Non-empty output means the process is still alive.
      if (cmdline.length > 0) return false;
    } catch {
      // ps failed — process is gone (ESRCH, EPERM, etc.) or ps is unavailable.
      // Treat as dead: the lock is stale and can be reaped.
    }

    try {
      unlinkSync(lockFile);
      return true;
    } catch {
      return false;
    }
  };

  try {
    mkdirSync(baseDir, { recursive: true });
    // O_EXCL ensures the creation is atomic -- only one caller succeeds.
    const fd = openSync(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    try {
      writeFileSync(fd, `${process.pid}\n`);
    } finally {
      closeSync(fd);
    }
    return () => {
      try {
        unlinkSync(lockFile);
      } catch {
        /* best effort */
      }
    };
  } catch (err: unknown) {
    // Distinguish EEXIST (lock held by peer) from other filesystem errors.
    const code = typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
    if (code !== "EEXIST") {
      // EACCES, ENOENT, disk full, etc. — re-throw so the caller knows this
      // is a real error, not merely "another worker is starting".
      throw err;
    }
    // EEXIST: another process holds the lock. Check for a stale lock (crashed
    // owner) before giving up.
    if (_reapStaleLock()) {
      // Stale lock removed. Retry acquisition atomically.
      try {
        mkdirSync(baseDir, { recursive: true });
        const fd2 = openSync(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        try {
          writeFileSync(fd2, `${process.pid}\n`);
        } finally {
          closeSync(fd2);
        }
        return () => {
          try {
            unlinkSync(lockFile);
          } catch {
            /* best effort */
          }
        };
      } catch {
        // Another process acquired it between our unlink and retry — yield.
        return null;
      }
    }
    // Genuinely held by a live process — yield to the peer.
    return null;
  }
}

/**
 * Scan the process table for a running lifecycle-worker for the given project.
 *
 * Used as a fallback in ensureLifecycleWorker when no PID file exists -- covers
 * the case where launchd started a worker before it had a chance to write its
 * PID file, which would otherwise cause ensureLifecycleWorker to spawn a
 * duplicate. (orch-886k)
 *
 * Returns the PID if found, null otherwise. Returns null on ps failure so that
 * the caller (ensureLifecycleWorker) skips the scan and conservatively refuses
 * to spawn -- preserving the PID file for the next call to retry.
 */
export function scanForRunningLifecycleWorker(projectId: string): number | null {
  try {
    // -ww: do not truncate the command column (macOS/BSD default to ~16 columns,
    // which cuts off the "lifecycle-worker <projectId>" marker for long paths).
    // -o pid,args=: output PID and full command line, no header.
    const stdout = execFileSync("ps", ["-ww", "-o", "pid,args="], {
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf-8");

    const marker = `lifecycle-worker ${projectId}`;
    const markerEscaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|\\s)${markerEscaped}(?:\\s|$)`);

    for (const line of stdout.split("\n")) {
      if (!pattern.test(line)) continue;
      // Output format: "  PID  args..." — PID is the first whitespace-separated token.
      const trimmed = line.trim();
      const spaceIdx = trimmed.indexOf(" ");
      const pidStr = spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed;
      const pid = Number.parseInt(pidStr, 10);
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
        return pid;
      }
    }
    return null;
  } catch {
    // ps failed (unavailable, timeout, etc.) -- return null so the caller
    // refuses to spawn rather than risk creating a duplicate worker.
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Verify the PID belongs to a lifecycle-worker process for the given projectId.
 *
 * Uses `ps` to read the full command line of the PID and checks for the
 * `lifecycle-worker <projectId>` marker. This prevents false positives when
 * the PID has been recycled and now belongs to an unrelated process.
 *
 * Returns:
 *   true  — process is a lifecycle-worker for this projectId
 *   false — process is confirmed not a lifecycle-worker for this projectId
 *   null  — cannot determine (ps failed); callers must handle conservatively
 */
function isLifecycleWorkerProcess(
  pid: number,
  projectId: string,
): boolean | null {
  try {
    // macOS and Linux both support -o args= for the full command line.
    // Use -ww to disable column truncation (macOS/BSD default to ~16 columns,
    // cutting off the lifecycle-worker marker for long paths/args).
    // Use execFileSync so no shell is involved — avoids quoting issues.
    const cmdline = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "args="], {
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString("utf-8")
      .trim();

    // Require the marker to appear as a distinct token pair: the ao binary
    // argument list ends with "... lifecycle-worker <projectId>", so the
    // marker must either be at the start of the line or follow whitespace.
    // Using a word-boundary check prevents "api" from matching "api-v2".
    const marker = `lifecycle-worker ${projectId}`;
    const markerEscaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|\\s)${markerEscaped}(?:\\s|$)`);
    return pattern.test(cmdline);
  } catch {
    // ps failed (process gone, permission denied, or timeout) — we cannot
    // confirm identity. Return null so callers treat this as indeterminate
    // rather than definitively clearing a potentially valid PID file.
    return null;
  }
}

function readPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;

  try {
    const raw = readFileSync(pidFile, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function writeLifecycleWorkerPid(
  config: OrchestratorConfig,
  projectId: string,
  pid: number,
): void {
  const pidFile = getLifecyclePidFile(config, projectId);
  mkdirSync(getProjectBase(config, projectId), { recursive: true });
  writeFileSync(pidFile, `${pid}\n`, "utf-8");
}

export function clearLifecycleWorkerPid(
  config: OrchestratorConfig,
  projectId: string,
  pid?: number,
): void {
  const pidFile = getLifecyclePidFile(config, projectId);
  if (!existsSync(pidFile)) return;

  if (pid !== undefined) {
    const currentPid = readPid(pidFile);
    if (currentPid !== null && currentPid !== pid) {
      return;
    }
  }

  try {
    unlinkSync(pidFile);
  } catch {
    // Best effort cleanup
  }
}

export function getLifecycleWorkerStatus(
  config: OrchestratorConfig,
  projectId: string,
): LifecycleWorkerStatus {
  const pidFile = getLifecyclePidFile(config, projectId);
  const logFile = getLifecycleLogFile(config, projectId);
  const pid = readPid(pidFile);

  if (pid !== null) {
    const confirmed = isLifecycleWorkerProcess(pid, projectId);
    if (confirmed === true) {
      return { running: true, pid, verified: true, pidFile, logFile };
    }
    // false = confirmed not ours → clear the stale PID file.
    // null  = indeterminate (ps failed) → leave PID file; next startup
    //           will retry verification or clear when the PID is gone.
    if (confirmed === false) {
      clearLifecycleWorkerPid(config, projectId, pid);
      return { running: false, pid: null, verified: false, pidFile, logFile };
    }
    // confirmed === null: indeterminate; preserve PID file and surface
    // verified=null so callers know not to act on this state.
    return { running: false, pid: null, verified: null, pidFile, logFile };
  }

  return { running: false, pid: null, verified: false, pidFile, logFile };
}

function resolveLifecycleWorkerLaunch(projectId: string): { command: string; args: string[] } {
  const entry = process.argv[1];
  const workerArgs = ["lifecycle-worker", projectId];

  if (entry && /\.(?:c|m)?js$/i.test(entry)) {
    return {
      command: process.execPath,
      args: [entry, ...workerArgs],
    };
  }

  if (entry && /\.ts$/i.test(entry)) {
    return {
      command: "npx",
      args: ["tsx", entry, ...workerArgs],
    };
  }

  return {
    command: "ao",
    args: workerArgs,
  };
}

async function waitForLifecycleWorker(
  config: OrchestratorConfig,
  projectId: string,
  timeoutMs = DEFAULT_START_TIMEOUT_MS,
): Promise<LifecycleWorkerStatus> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = getLifecycleWorkerStatus(config, projectId);
    if (status.running) {
      return status;
    }
    await sleep(100);
  }

  return getLifecycleWorkerStatus(config, projectId);
}

export async function ensureLifecycleWorker(
  config: OrchestratorConfig,
  projectId: string,
): Promise<LifecycleWorkerStatus & { started: boolean }> {
  const current = getLifecycleWorkerStatus(config, projectId);
  if (current.running) {
    return { ...current, started: false };
  }
  // verified === null means ps failed and we cannot confirm the process state.
  // Do not spawn a new worker — a genuine worker may already exist and we risk
  // creating a duplicate. The PID file is preserved so the next call retries.
  if (current.verified === null) {
    return { ...current, started: false };
  }

  // orch-886k: ps-scan fallback -- detect workers started by launchd (or any
  // external caller) that haven't written their PID file yet. If a running
  // lifecycle-worker is found in the process table, skip spawning a duplicate
  // even when no PID file exists. This closes the window where launchd + ao
  // start race to spawn two workers for the same project.
  const scannedPid = scanForRunningLifecycleWorker(projectId);
  if (scannedPid !== null) {
    // A worker was found via ps scan even though no PID file exists (e.g.
    // launchd started it). running=true is consistent with LifecycleWorkerStatus:
    // verified=true means ps confirmed a genuine lifecycle-worker process, so the
    // worker IS running even though it hasn't written the PID file yet.
    return { ...current, running: true, pid: scannedPid, verified: true, started: false };
  }

  const baseDir = getProjectBase(config, projectId);
  const logFile = getLifecycleLogFile(config, projectId);
  mkdirSync(baseDir, { recursive: true });

  const stdoutFd = openSync(logFile, "a");
  const stderrFd = openSync(logFile, "a");

  try {
    const launch = resolveLifecycleWorkerLaunch(projectId);
    const child = spawn(launch.command, launch.args, {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      env: {
        ...process.env,
        AO_LIFECYCLE_PROJECT: projectId,
        AO_CONFIG_PATH: config.configPath,
      },
    });

    child.unref();

    // Write PID from the parent immediately after spawn to close the TOCTOU
    // window: without this, a second concurrent `ensureLifecycleWorker` call
    // could pass the "not running" check before the child writes its own PID.
    if (child.pid) {
      writeLifecycleWorkerPid(config, projectId, child.pid);
    }
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }

  const status = await waitForLifecycleWorker(config, projectId);
  if (!status.running) {
    throw new Error(
      `Lifecycle worker failed to start for project ${projectId}. See ${status.logFile}`,
    );
  }

  return { ...status, started: true };
}

export async function stopLifecycleWorker(
  config: OrchestratorConfig,
  projectId: string,
): Promise<boolean> {
  const status = getLifecycleWorkerStatus(config, projectId);
  if (!status.running || status.pid === null) {
    // verified=null means ps failed; do not clear the PID file — a genuine
    // worker may be running and the next call can retry verification.
    if (status.verified === null) {
      return false;
    }
    clearLifecycleWorkerPid(config, projectId);
    return false;
  }

  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    clearLifecycleWorkerPid(config, projectId, status.pid);
    return false;
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const confirmed = isLifecycleWorkerProcess(status.pid, projectId);
    if (confirmed === true) {
      await sleep(100);
      continue;
    }
    // null (ps failed, process likely gone) or false (PID recycled) → success
    clearLifecycleWorkerPid(config, projectId, status.pid);
    return true;
  }

  try {
    process.kill(status.pid, "SIGKILL");
  } catch {
    // Best effort hard stop
  }

  clearLifecycleWorkerPid(config, projectId, status.pid);
  return true;
}
