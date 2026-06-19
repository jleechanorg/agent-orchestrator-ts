/**
 * Lifecycle service — in-process polling for project session lifecycles.
 *
 * Replaces the old subprocess-based model (deleted with the `lifecycle-worker`
 * CLI command in PR #712). The in-process pattern mirrors upstream
 * `AgentWrapper/agent-orchestrator` PR #1186: a single `Map<projectId,
 * ActiveLoop>` holds active polling handles for the current `ao start`
 * process. There is no PID file, no lock file, no subprocess, and no
 * `tmux list-sessions` ps-scan.
 *
 * API is intentionally compatible with the previous subprocess-based surface
 * (`ensureLifecycleWorker`, `stopLifecycleWorker`, `listLifecycleWorkers`) so
 * existing callers in `project-supervisor.ts`, `start.ts`, `spawn.ts`, and
 * `shutdown.ts` need no caller-side migration.
 */
import {
  createCorrelationId,
  createProjectObserver,
  type LifecycleManager,
  type OrchestratorConfig,
} from "@jleechanorg/ao-core";
import { getLifecycleManager } from "./create-session-manager.js";

const DEFAULT_INTERVAL_MS = 30_000;

interface ActiveLoop {
  lifecycle: LifecycleManager;
  stop: () => void;
}

const active = new Map<string, ActiveLoop>();

// Note: no SIGINT/SIGTERM listeners are installed here. Adding a listener for
// those signals removes Node.js's default "exit on signal" behavior, which
// would leave `ao start` hanging when `ao stop` sends SIGTERM (the setInterval
// keeps the event loop alive forever). Default signal handling terminates the
// process cleanly; the OS reclaims the interval timer. Callers that need to
// flush state explicitly before exit can call `stopAllLifecycleWorkers()`.

export interface LifecycleWorkerStatus {
  running: boolean;
  started: boolean;
}

export async function ensureLifecycleWorker(
  config: OrchestratorConfig,
  projectId: string,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): Promise<LifecycleWorkerStatus> {
  if (!config.projects[projectId]) {
    throw new Error(`Unknown project: ${projectId}`);
  }

  if (active.has(projectId)) {
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

  active.set(projectId, {
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

export function stopLifecycleWorker(projectId: string): void {
  const entry = active.get(projectId);
  if (!entry) return;

  try {
    entry.stop();
  } catch {
    // Best-effort
  }
  active.delete(projectId);
}

export function stopAllLifecycleWorkers(): void {
  for (const projectId of Array.from(active.keys())) {
    stopLifecycleWorker(projectId);
  }
}

export function isLifecycleWorkerRunning(projectId: string): boolean {
  return active.has(projectId);
}

export function listLifecycleWorkers(): string[] {
  return Array.from(active.keys());
}

/**
 * Test-only: clear the in-memory `active` map. Exported so unit tests can
 * reset state between cases. Do not call from production code.
 */
export function __resetLifecycleServiceForTesting(): void {
  for (const projectId of Array.from(active.keys())) {
    try {
      active.get(projectId)?.stop();
    } catch {
      // Best-effort
    }
    active.delete(projectId);
  }
}
