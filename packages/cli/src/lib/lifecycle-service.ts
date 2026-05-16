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
import {
  createCorrelationId,
  createProjectObserver,
  getProjectBaseDir,
  type LifecycleManager,
  type OrchestratorConfig,
} from "@jleechanorg/ao-core";
import { getLifecycleManager } from "./create-session-manager.js";

const LIFECYCLE_PID_FILE = "lifecycle-worker.pid";
const LIFECYCLE_LOCK_FILE = "lifecycle-worker.lock";
const LIFECYCLE_LOG_FILE = "lifecycle-worker.log";
const DEFAULT_START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 5_000;
const DEFAULT_INTERVAL_MS = 30_000;

export interface LifecycleWorkerStatus {
  running: boolean;
  pid: number | null;
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

export function forceLifecycleLock(
  config: OrchestratorConfig,
  projectId: string,
): (() => void) | null {
  const lockFile = getLifecycleLockFile(config, projectId);

  let ownerPid: number | null;
  try {
    const raw = readFileSync(lockFile, "utf-8").trim();
    ownerPid = Number.parseInt(raw, 10);
    if (!Number.isFinite(ownerPid) || ownerPid <= 0) ownerPid = null;
  } catch {
    ownerPid = null;
  }

  if (ownerPid !== null && ownerPid !== process.pid) {
    const ownerIsWorker = isLifecycleWorkerProcess(ownerPid, projectId);
    if (ownerIsWorker === true) {
      return null;
    }
  }

  return tryAcquireLifecycleLock(config, projectId);
}

export function tryAcquireLifecycleLock(
  config: OrchestratorConfig,
  projectId: string,
): (() => void) | null {
  const lockFile = getLifecycleLockFile(config, projectId);
  const baseDir = getProjectBase(config, projectId);

  const _reapStaleLock = (): boolean => {
    let stalePid: number;
    try {
      const raw = readFileSync(lockFile, "utf-8").trim();
      stalePid = Number.parseInt(raw, 10);
    } catch {
      return false;
    }
    if (!Number.isFinite(stalePid) || stalePid === process.pid) return false;

    const staleIsWorker = isLifecycleWorkerProcess(stalePid, projectId);
    if (staleIsWorker !== false) {
      return false;
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
    const code = typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
    if (code !== "EEXIST") {
      throw err;
    }
    if (_reapStaleLock()) {
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
        return null;
      }
    }
    return null;
  }
}

export function scanForRunningLifecycleWorker(projectId: string): number | null {
  try {
    const stdout = execFileSync("ps", ["-ww", "-o", "pid,args="], {
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf-8");

    const marker = `lifecycle-worker ${projectId}`;
    const markerEscaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|\\s)${markerEscaped}(?:\\s|$)`);

    for (const line of stdout.split("\n")) {
      if (!pattern.test(line)) continue;
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
    return null;
  }
}

export function listLifecycleWorkerPids(): string[] {
  try {
    const stdout = execFileSync("ps", ["-ww", "-o", "args="], {
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf-8");

    const projectIds: string[] = [];
    for (const line of stdout.split("\n")) {
      const match = line.match(/\blifecycle-worker\s+(\S+)/);
      if (match) {
        projectIds.push(match[1]);
      }
    }
    return projectIds;
  } catch {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLifecycleWorkerProcess(
  pid: number,
  projectId: string,
): boolean | null {
  try {
    const cmdline = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "args="], {
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString("utf-8")
      .trim();

    const marker = `lifecycle-worker ${projectId}`;
    const markerEscaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|\\s)${markerEscaped}(?:\\s|$)`);
    return pattern.test(cmdline);
  } catch (err: unknown) {
    const status = typeof err === "object" && err !== null && "status" in err
      ? (err as { status?: unknown }).status
      : undefined;
    if (status === 1) return false;
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
    if (confirmed === false) {
      clearLifecycleWorkerPid(config, projectId, pid);
      return { running: false, pid: null, verified: false, pidFile, logFile };
    }
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
  if (current.verified === null) {
    return { ...current, started: false };
  }

  const scannedPid = scanForRunningLifecycleWorker(projectId);
  if (scannedPid !== null) {
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
    clearLifecycleWorkerPid(config, projectId, status.pid);
    return true;
  }

  try {
    process.kill(status.pid, "SIGKILL");
  } catch {
  }

  clearLifecycleWorkerPid(config, projectId, status.pid);
  return true;
}

interface ActiveLoop {
  lifecycle: LifecycleManager;
  stop: () => void;
}

const activeLoops = new Map<string, ActiveLoop>();

export interface InProcessLifecycleWorkerStatus {
  running: boolean;
  started: boolean;
}

export async function ensureInProcessLifecycleWorker(
  config: OrchestratorConfig,
  projectId: string,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): Promise<InProcessLifecycleWorkerStatus> {
  if (!config.projects[projectId]) {
    throw new Error(`Unknown project: ${projectId}`);
  }

  if (activeLoops.has(projectId)) {
    return { running: true, started: false };
  }

  const observer = createProjectObserver(config, "lifecycle-service");
  const lifecycle = await getLifecycleManager(config, projectId);

  lifecycle.start(intervalMs);

  observer.setHealth({
    surface: "lifecycle.worker",
    status: "ok",
    projectId,
    correlationId: createCorrelationId("lifecycle-service"),
    details: { projectId, intervalMs, inProcess: true },
  });

  activeLoops.set(projectId, {
    lifecycle,
    stop: () => {
      try {
        lifecycle.stop();
      } finally {
        observer.setHealth({
          surface: "lifecycle.worker",
          status: "warn",
          projectId,
          correlationId: createCorrelationId("lifecycle-service"),
          reason: "Lifecycle polling stopped",
          details: { projectId },
        });
      }
    },
  });

  return { running: true, started: true };
}

export function stopInProcessLifecycleWorker(projectId: string): void {
  const entry = activeLoops.get(projectId);
  if (!entry) return;

  try {
    entry.stop();
  } catch {
  }
  activeLoops.delete(projectId);
}

export function stopAllInProcessLifecycleWorkers(): void {
  for (const projectId of Array.from(activeLoops.keys())) {
    stopInProcessLifecycleWorker(projectId);
  }
}

export function isInProcessLifecycleWorkerRunning(projectId: string): boolean {
  return activeLoops.has(projectId);
}

export function listLifecycleWorkers(): string[] {
  const processWorkers = listLifecycleWorkerPids();
  const inProcessWorkers = Array.from(activeLoops.keys());
  return [...new Set([...processWorkers, ...inProcessWorkers])];
}

export async function stopAllLifecycleWorkers(config?: OrchestratorConfig): Promise<void> {
  stopAllInProcessLifecycleWorkers();
  if (config) {
    const workers = listLifecycleWorkerPids();
    for (const projectId of workers) {
      await stopLifecycleWorker(config, projectId);
    }
  }
}
