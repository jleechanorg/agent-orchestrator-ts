/**
 * Spawn Queue — bounded, persistent admission control for AO session spawns.
 *
 * Reuses the task-queue pattern: file-backed state, one drain per lifecycle poll,
 * and observer events instead of a separate daemon or in-memory scheduler.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  TERMINAL_STATUSES,
  isTerminalSession,
  type ProjectConfig,
  type Session,
  type SessionManager,
} from "./types.js";
import type { ProjectObserver } from "./observability.js";
import { getSessionsDir } from "./paths.js";
import { updateMetadata } from "./metadata.js";

const DEFAULT_MAX_ACTIVE_SESSIONS = 20;
const DRAIN_INTERVAL_MS = 30_000;
const MAX_SPAWN_RETRIES = 3;
const MAX_PENDING_REQUESTS = 100;

const lastDrainTimeByProject = new Map<string, number>();

/** Returns 1-minute load average, or null if unavailable. */
async function getLoadAvg1m(): Promise<number | null> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("sysctl", ["-n", "vm.loadavg"], { encoding: "utf8" });
      // format: "{ 1.23 4.56 7.89 }"
      const m = stdout.match(/\{\s*([\d.]+)/);
      const load = m?.[1] ? Number.parseFloat(m[1]) : Number.NaN;
      return Number.isFinite(load) ? load : null;
    } else {
      const { readFile } = await import("node:fs/promises");
      const content = await readFile("/proc/loadavg", "utf8");
      const token = content.trim().split(/\s+/)[0];
      const load = token ? Number.parseFloat(token) : Number.NaN;
      return Number.isFinite(load) ? load : null;
    }
  } catch {
    return null;
  }
}

interface QueuedSpawnRequest {
  id: string;
  issueId?: string;
  lineage?: string[];
  siblings?: string[];
  agent?: string;
  runtimeOverride?: string;
  claimPr?: string;
  assignOnGithub?: boolean;
  prompt?: string;
  queuedAt: string;
  attempts: number;
}

interface SpawnQueueState {
  pending: QueuedSpawnRequest[];
}

export interface SpawnQueueConfigResolved {
  enabled: boolean;
  maxActiveSessions: number;
}

export interface EnqueueSpawnRequestInput {
  issueId?: string;
  lineage?: string[];
  siblings?: string[];
  agent?: string;
  runtimeOverride?: string;
  claimPr?: string;
  assignOnGithub?: boolean;
  prompt?: string;
}

export interface DrainSpawnQueueDeps {
  sessionManager: SessionManager;
  observer: ProjectObserver;
  getLoadAvg?: () => Promise<number | null>;
}

export interface DrainSpawnQueueParams {
  projectId: string;
  project: ProjectConfig;
  configPath: string;
  activeSessions: Session[];
  correlationId: string;
}

function getSpawnQueueStatePath(configPath: string, projectId: string): string {
  const sessionsDir = getSessionsDir(configPath, "");
  return join(sessionsDir, `spawn-queue-${projectId}.json`);
}

function loadSpawnQueueState(configPath: string, projectId: string): SpawnQueueState {
  const statePath = getSpawnQueueStatePath(configPath, projectId);
  try {
    if (existsSync(statePath)) {
      return JSON.parse(readFileSync(statePath, "utf-8")) as SpawnQueueState;
    }
  } catch {
    // Corrupt state file — start fresh rather than blocking future spawns.
  }
  return { pending: [] };
}

function saveSpawnQueueState(configPath: string, projectId: string, state: SpawnQueueState): void {
  const statePath = getSpawnQueueStatePath(configPath, projectId);
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // Best effort only — queue state should not crash AO.
  }
}

function createRequestId(): string {
  return `sq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function _resetSpawnQueueTimer(): void {
  lastDrainTimeByProject.clear();
}

export function resolveSpawnQueueConfig(project?: ProjectConfig): SpawnQueueConfigResolved {
  return {
    enabled: project?.spawnQueue?.enabled ?? true,
    maxActiveSessions: project?.spawnQueue?.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS,
  };
}

export function countActiveSessions(sessions: Session[]): number {
  return sessions.filter((session) => !isTerminalSession(session)).length;
}

export function hasSpawnCapacity(activeSessions: Session[], project?: ProjectConfig): boolean {
  const queueConfig = resolveSpawnQueueConfig(project);
  if (!queueConfig.enabled) {
    return true;
  }
  return countActiveSessions(activeSessions) < queueConfig.maxActiveSessions;
}

export function enqueueSpawnRequest(
  configPath: string,
  projectId: string,
  input: EnqueueSpawnRequestInput,
): { requestId: string; position: number } {
  const state = loadSpawnQueueState(configPath, projectId);
  if (state.pending.length >= MAX_PENDING_REQUESTS) {
    throw new Error(
      `Spawn queue is full for project '${projectId}' (${MAX_PENDING_REQUESTS} pending requests)`,
    );
  }

  const requestId = createRequestId();
  state.pending.push({
    id: requestId,
    issueId: input.issueId,
    lineage: input.lineage,
    siblings: input.siblings,
    agent: input.agent,
    runtimeOverride: input.runtimeOverride,
    claimPr: input.claimPr,
    assignOnGithub: input.assignOnGithub,
    prompt: input.prompt,
    queuedAt: new Date().toISOString(),
    attempts: 0,
  });
  saveSpawnQueueState(configPath, projectId, state);
  return { requestId, position: state.pending.length };
}

export async function drainSpawnQueue(
  deps: DrainSpawnQueueDeps,
  params: DrainSpawnQueueParams,
): Promise<number> {
  const { sessionManager, observer } = deps;
  const { projectId, project, configPath, activeSessions, correlationId } = params;
  const queueConfig = resolveSpawnQueueConfig(project);

  if (!queueConfig.enabled) {
    return 0;
  }

  const now = Date.now();
  const lastDrainTime = lastDrainTimeByProject.get(projectId) ?? 0;
  if (now - lastDrainTime < DRAIN_INTERVAL_MS) {
    return 0;
  }
  lastDrainTimeByProject.set(projectId, now);

  const activeCount = countActiveSessions(activeSessions);
  if (activeCount >= queueConfig.maxActiveSessions) {
    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "lifecycle.spawn_queue.at_capacity",
      outcome: "success",
      correlationId,
      projectId,
      data: { activeCount, maxActiveSessions: queueConfig.maxActiveSessions },
      level: "debug",
    });
    return 0;
  }

  const load = await (async () => {
    try {
      return await (deps.getLoadAvg ?? getLoadAvg1m)();
    } catch {
      return null;
    }
  })();
  if (load !== null && load > 20) {
    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "lifecycle.spawn_queue.load_high",
      outcome: "success",
      correlationId,
      projectId,
      data: { load1m: load, threshold: 20 },
      level: "warn",
    });
    return 0;
  }

  const state = loadSpawnQueueState(configPath, projectId);
  const nextRequest = state.pending[0];
  if (!nextRequest) {
    return 0;
  }

  try {
    const session = await sessionManager.spawn({
      projectId,
      issueId: nextRequest.issueId,
      lineage: nextRequest.lineage,
      siblings: nextRequest.siblings,
      agent: nextRequest.agent,
      runtimeOverride: nextRequest.runtimeOverride,
      prompt: nextRequest.prompt,
    });

    if (nextRequest.claimPr) {
      await sessionManager.claimPR(session.id, nextRequest.claimPr, {
        assignOnGithub: nextRequest.assignOnGithub,
        sendInitialMessage: true,
      });
    }

    updateMetadata(getSessionsDir(configPath, project.path), session.id, {
      queuedSpawnRequestId: nextRequest.id,
    });

    state.pending.shift();
    saveSpawnQueueState(configPath, projectId, state);

    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "lifecycle.spawn_queue.spawned",
      outcome: "success",
      correlationId,
      projectId,
      data: {
        requestId: nextRequest.id,
        issueId: nextRequest.issueId,
        claimPr: nextRequest.claimPr,
        sessionId: session.id,
        remaining: state.pending.length,
      },
      level: "info",
    });
    return 1;
  } catch (error) {
    nextRequest.attempts += 1;
    const exhausted = nextRequest.attempts >= MAX_SPAWN_RETRIES;
    if (exhausted) {
      state.pending.shift();
    } else {
      state.pending[0] = nextRequest;
    }
    saveSpawnQueueState(configPath, projectId, state);

    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: exhausted
        ? "lifecycle.spawn_queue.dropped"
        : "lifecycle.spawn_queue.spawn_failed",
      outcome: "failure",
      correlationId,
      projectId,
      data: {
        requestId: nextRequest.id,
        issueId: nextRequest.issueId,
        claimPr: nextRequest.claimPr,
        attempts: nextRequest.attempts,
        error: error instanceof Error ? error.message : String(error),
      },
      level: exhausted ? "warn" : "error",
    });
    return 0;
  }
}
