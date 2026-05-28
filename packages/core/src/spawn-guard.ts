/**
 * Spawn Guard — prevents concurrent `ao spawn` invocations for the same project.
 *
 * Uses a file-based lock so separate CLI processes cannot race to create
 * sessions simultaneously. Lock files are placed in the project base directory
 * with a stale timeout so crashes don't permanently block spawns.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getProjectBaseDir } from "./paths.js";

const LOCK_FILE_NAME = "spawn.lock";
const STALE_LOCK_MS = 60_000;

interface LockInfo {
  pid: number;
  acquiredAt: string;
}

function getLockPath(configPath: string, projectPath: string): string {
  const baseDir = getProjectBaseDir(configPath, projectPath);
  mkdirSync(baseDir, { recursive: true });
  return join(baseDir, LOCK_FILE_NAME);
}

function readLock(lockPath: string): LockInfo | null {
  try {
    if (!existsSync(lockPath)) return null;
    const raw = readFileSync(lockPath, "utf-8");
    const parsed = JSON.parse(raw) as LockInfo;
    if (typeof parsed.pid === "number" && typeof parsed.acquiredAt === "string") {
      return parsed;
    }
  } catch {
    // Corrupt lock file — treat as absent
  }
  return null;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isStale(acquiredAt: string): boolean {
  try {
    const acquired = new Date(acquiredAt).getTime();
    return Date.now() - acquired > STALE_LOCK_MS;
  } catch {
    return true;
  }
}

export interface AcquireResult {
  acquired: true;
  release: () => void;
}

export interface AcquireBlockedResult {
  acquired: false;
  blockingPid: number;
  acquiredAt: string;
}

/**
 * Acquire the spawn lock for a project.
 * Returns either `{ acquired: true, release }` or `{ acquired: false, blockingPid, acquiredAt }`.
 *
 * Stale locks (older than 60s or whose PID is no longer running) are automatically cleared.
 */
export function acquireSpawnLock(
  configPath: string,
  projectPath: string,
): AcquireResult | AcquireBlockedResult {
  const lockPath = getLockPath(configPath, projectPath);
  const existing = readLock(lockPath);

  if (existing) {
    const pidAlive = isProcessRunning(existing.pid);
    const stale = isStale(existing.acquiredAt);

    if (pidAlive && !stale) {
      return {
        acquired: false,
        blockingPid: existing.pid,
        acquiredAt: existing.acquiredAt,
      };
    }

    // Stale or dead PID — clean up
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // Best effort
    }
  }

  const lockInfo: LockInfo = {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  writeFileSync(lockPath, JSON.stringify(lockInfo, null, 2), "utf-8");

  let released = false;
  return {
    acquired: true,
    release: () => {
      if (released) return;
      released = true;
      try {
        if (existsSync(lockPath)) {
          const current = readLock(lockPath);
          if (current?.pid === process.pid) {
            rmSync(lockPath, { force: true });
          }
        }
      } catch {
        // Best effort — don't crash on lock cleanup
      }
    },
  };
}
