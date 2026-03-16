import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
    writeFileSync(STATE_FILE, "null", "utf-8");
  } else {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  }
}

/**
 * Register the current AO instance as running.
 * Prunes any stale entry first.
 */
export function register(entry: RunningState): void {
  writeState(entry);
}

/**
 * Unregister the running AO instance.
 */
export function unregister(): void {
  writeState(null);
}

/**
 * Get the currently running AO instance, if any.
 * Auto-prunes stale entries (dead PIDs).
 */
export function getRunning(): RunningState | null {
  const state = readState();
  if (!state) return null;

  if (!isProcessAlive(state.pid)) {
    // Stale entry — process is dead, clean up
    writeState(null);
    return null;
  }

  return state;
}

/**
 * Check if AO is already running.
 * Returns the running state if alive, null otherwise.
 */
export function isAlreadyRunning(): RunningState | null {
  return getRunning();
}
