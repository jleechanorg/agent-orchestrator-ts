/**
 * Task Queue Drainer — bd-bsu
 *
 * Automatically processes beads from a config-driven task queue by spawning sessions
 * up to `maxConcurrent`. Dispatched beads are tracked in session metadata so the
 * lifecycle-worker knows which beads are already in-flight and won't re-spawn them.
 *
 * Interaction with backfillAllPRs:
 * - Task queue sessions are separate from backfill sessions.
 * - Both can run simultaneously. The maxConcurrent limit only applies to
 *   queue-spawned sessions (counted by checking `queuedBeadId` in metadata).
 * - Completion detection: a queued session is "done" when its status is terminal
 *   (merged, completed, errored, killed, etc.). On failure, log and move on.
 *
 * Config mutation: We do NOT mutate the YAML config at runtime. Instead, we track
 * which beads are in-flight via `queuedBeadId` in session metadata. The next poll
 * loop iteration will count active queue sessions and spawn the next bead if slots
 * are available.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  TERMINAL_STATUSES,
  type PluginRegistry,
  type SessionManager,
  type Session,
  type ProjectConfig,
} from "./types.js";
import type { ProjectObserver } from "./observability.js";
import { updateMetadata } from "./metadata.js";
import { getSessionsDir } from "./paths.js";

// ---- module-level throttle state (keyed by projectId) ----
const lastDrainTimeByProject = new Map<string, number>();
const DRAIN_INTERVAL_MS = 30_000; // 30 seconds between drain attempts
const MAX_SPAWN_RETRIES = 3;

/** Reset throttle state — exposed for testing only. */
export function _resetDrainTimer(): void {
  lastDrainTimeByProject.clear();
}

// ---- Persistent queue state (survives across poll cycles) ----

interface QueueState {
  /** Bead IDs that have been successfully dispatched and completed. */
  dispatched: string[];
  /** Bead IDs that failed to spawn, mapped to their retry count. */
  failed: Record<string, number>;
}

function getQueueStatePath(configPath: string, projectId: string): string {
  const sessionsDir = getSessionsDir(configPath, "");
  // Place state file alongside sessions dir so both use identical hashing.
  return join(sessionsDir, `queue-state-${projectId}.json`);
}

function loadQueueState(configPath: string, projectId: string): QueueState {
  const statePath = getQueueStatePath(configPath, projectId);
  try {
    if (existsSync(statePath)) {
      return JSON.parse(readFileSync(statePath, "utf-8")) as QueueState;
    }
  } catch {
    // Corrupt state file — start fresh
  }
  return { dispatched: [], failed: {} };
}

function saveQueueState(configPath: string, projectId: string, state: QueueState): void {
  const statePath = getQueueStatePath(configPath, projectId);
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // Non-fatal: state file write failure shouldn't block queue processing
  }
}

// ---- Default task template ----
const DEFAULT_TASK_TEMPLATE = (
  beadId: string,
  title: string,
  description: string,
) =>
  `Work on bead ${beadId}: ${title}\n\n${description}\n\nCreate a PR for this fix. After completing work, run /learn to capture patterns.`;

// ---- Bead resolution ----

/**
 * Resolve bead title and description via `br show <beadId>`.
 * Returns `{ title, description }` with safe fallbacks if `br` is unavailable.
 */
export function resolveBead(beadId: string): { title: string; description: string } {
  try {
    const raw = execFileSync("br", ["show", beadId], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    // br show output is typically: title on first line, description after blank line
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    const title = lines[0] ?? beadId;
    const description = lines.slice(1).join(" ").trim() || `Bead ${beadId}`;
    return { title, description };
  } catch {
    return { title: beadId, description: `Bead ${beadId}` };
  }
}

// ---- Dependencies ----

export interface TaskQueueDeps {
  registry: PluginRegistry;
  sessionManager: SessionManager;
  observer: ProjectObserver;
}

// ---- Parameters ----

export interface TaskQueueParams {
  projectId: string;
  project: ProjectConfig;
  /** Root config path — passed explicitly since project.configPath is optional and never populated. */
  configPath: string;
  activeSessions: Session[];
  correlationId: string;
}

// ---- Core drain function ----

/**
 * Drain the task queue for a project, spawning sessions up to `maxConcurrent`.
 *
 * Returns the number of newly spawned sessions (0 or 1 per call to avoid
 * thundering-herd — one spawn per poll cycle).
 */
export async function drainTaskQueue(
  deps: TaskQueueDeps,
  params: TaskQueueParams,
): Promise<number> {
  const { registry: _registry, sessionManager, observer } = deps;
  const { projectId, project, configPath, activeSessions, correlationId } = params;

  const tq = project.taskQueue;
  if (!tq || !tq.enabled || tq.beads.length === 0) {
    return 0;
  }

  const now = Date.now();
  const lastDrainTime = lastDrainTimeByProject.get(projectId) ?? 0;
  if (now - lastDrainTime < DRAIN_INTERVAL_MS) {
    return 0;
  }
  lastDrainTimeByProject.set(projectId, now);

  // Count active queue-spawned sessions (those with queuedBeadId in metadata)
  const queueSlotsUsed = activeSessions.filter(
    (s) => !TERMINAL_STATUSES.has(s.status) && Boolean(s.metadata["queuedBeadId"]),
  ).length;

  const maxConcurrent = tq.maxConcurrent ?? 4;
  if (queueSlotsUsed >= maxConcurrent) {
    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "lifecycle.task_queue.slots_full",
      outcome: "success",
      correlationId,
      projectId,
      data: { queueSlotsUsed, maxConcurrent },
      level: "debug",
    });
    return 0;
  }

  // Build set of already-dispatched bead IDs:
  // - In-flight: active sessions with queuedBeadId (excludes terminal sessions)
  // - Persisted: loaded from queue-state file so completed sessions aren't re-dispatched
  const queueState = loadQueueState(configPath, projectId);
  const dispatched = new Set<string>(queueState.dispatched);
  for (const s of activeSessions) {
    const beadId = s.metadata["queuedBeadId"];
    if (beadId) dispatched.add(beadId);
  }

  // Find the first bead not yet dispatched and not permanently failed
  const nextBead = tq.beads.find(
    (b) =>
      !dispatched.has(b) &&
      (queueState.failed[b] ?? 0) < MAX_SPAWN_RETRIES,
  );
  if (!nextBead) {
    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "lifecycle.task_queue.all_dispatched",
      outcome: "success",
      correlationId,
      projectId,
      data: { total: tq.beads.length, dispatched: dispatched.size },
      level: "debug",
    });
    return 0;
  }

  // Resolve bead metadata
  const { title, description } = resolveBead(nextBead);

  // Build task prompt from template
  const rawTemplate = tq.taskTemplate ?? DEFAULT_TASK_TEMPLATE(nextBead, title, description);
  const prompt = rawTemplate
    .replace(/\{beadId\}/g, nextBead)
    .replace(/\{beadTitle\}/g, title)
    .replace(/\{beadDescription\}/g, description);

  let session: Session;
  try {
    session = await sessionManager.spawn({
      projectId,
      issueId: nextBead,
      prompt,
    });
  } catch (err) {
    // Increment retry count so repeated failures are eventually skipped
    queueState.failed[nextBead] = (queueState.failed[nextBead] ?? 0) + 1;
    saveQueueState(configPath, projectId, queueState);
    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "lifecycle.task_queue.spawn_failed",
      outcome: "failure",
      correlationId,
      projectId,
      data: {
        beadId: nextBead,
        retryCount: queueState.failed[nextBead],
        maxRetries: MAX_SPAWN_RETRIES,
        error: err instanceof Error ? err.message : String(err),
      },
      level: "warn",
    });
    return 0;
  }

  // Tag the session with the queued bead ID so we can track it
  try {
    const sessionsDir = getSessionsDir(configPath, project.path);
    updateMetadata(sessionsDir, session.id, { queuedBeadId: nextBead });
  } catch (err) {
    // Metadata write failure is independent of spawn success — log but don't
    // report as spawn_failed since the session is already running.
    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "lifecycle.task_queue.metadata_write_failed",
      outcome: "failure",
      correlationId,
      projectId,
      sessionId: session.id,
      data: {
        beadId: nextBead,
        error: err instanceof Error ? err.message : String(err),
      },
      level: "warn",
    });
  }

  // Persist bead as dispatched so it won't be re-spawned after session completes
  if (!queueState.dispatched.includes(nextBead)) {
    queueState.dispatched.push(nextBead);
  }
  Reflect.deleteProperty(queueState.failed, nextBead);
  saveQueueState(configPath, projectId, queueState);

  observer.recordOperation({
    metric: "lifecycle_poll",
    operation: "lifecycle.task_queue.spawned",
    outcome: "success",
    correlationId,
    projectId,
    sessionId: session.id,
    data: { beadId: nextBead, beadTitle: title },
    level: "info",
  });

  return 1;
}
