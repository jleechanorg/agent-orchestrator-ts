import { readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync, closeSync, constants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface RunningState {
  pid: number;
  configPath: string;
  port: number;
  startedAt: string;
  projects: string[];
}

const STATE_DIR = join(homedir(), ".agent-orchestrator");
const STATE_FILE = join(STATE_DIR, "running.json");
const LOCK_FILE = join(STATE_DIR, "running.lock");

function ensureDir(): void {
  mkdirSync(STATE_DIR, { recursive: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Simple advisory lockfile. Uses O_EXCL to atomically create the lock.
 * Returns a release function. If lock cannot be acquired within timeout, throws.
 */
function acquireLock(timeoutMs = 5000): () => void {
  ensureDir();
  const start = Date.now();
  while (true) {
    try {
      const fd = openSync(LOCK_FILE, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      closeSync(fd);
      return () => {
        try { unlinkSync(LOCK_FILE); } catch { /* best effort */ }
      };
    } catch {
      if (Date.now() - start > timeoutMs) {
        // Stale lock — force remove and retry once
        try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
        try {
          const fd = openSync(LOCK_FILE, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
          closeSync(fd);
          return () => {
            try { unlinkSync(LOCK_FILE); } catch { /* best effort */ }
          };
        } catch {
          throw new Error("Could not acquire running.json lock");
        }
      }
      // Spin wait 50ms
      const end = Date.now() + 50;
      while (Date.now() < end) { /* busy wait */ }
    }
  }
}

function readState(): RunningState | null {
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    const state = JSON.parse(raw) as RunningState;
    if (!state || typeof state.pid !== "number") return null;
    return state;
  } catch {
    return null;
  }
}

function writeState(state: RunningState | null): void {
  ensureDir();
  if (state === null) {
    try { unlinkSync(STATE_FILE); } catch { /* file may not exist */ }
  } else {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  }
}

/**
 * Register the current AO instance as running.
 * Uses a lockfile to prevent concurrent registration.
 */
export function register(entry: RunningState): void {
  const release = acquireLock();
  try {
    writeState(entry);
  } finally {
    release();
  }
}

/**
 * Unregister the running AO instance.
 */
export function unregister(): void {
  const release = acquireLock();
  try {
    writeState(null);
  } finally {
    release();
  }
}

/**
 * Get the currently running AO instance, if any.
 * Auto-prunes stale entries (dead PIDs).
 */
export function getRunning(): RunningState | null {
  const release = acquireLock();
  try {
    const state = readState();
    if (!state) return null;

    if (!isProcessAlive(state.pid)) {
      // Stale entry — process is dead, clean up
      writeState(null);
      return null;
    }

    return state;
  } finally {
    release();
  }
}

/**
 * Check if AO is already running.
 * Returns the running state if alive, null otherwise.
 */
export function isAlreadyRunning(): RunningState | null {
  return getRunning();
}

/**
 * Wait for a process to exit, polling isProcessAlive.
 * Returns true if the process exited, false if timeout reached.
 */
export function waitForExit(pid: number, timeoutMs = 5000): boolean {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    // Spin wait 100ms
    const end = Date.now() + 100;
    while (Date.now() < end) { /* busy wait */ }
  }
  return !isProcessAlive(pid);
}
