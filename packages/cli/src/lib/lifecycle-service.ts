import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
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

  return { running: false, pid: null, verified: null, pidFile, logFile };
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
