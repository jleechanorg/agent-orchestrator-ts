import {
  loadConfig,
  isTerminalSession,
  createCorrelationId,
  createProjectObserver,
  type OrchestratorConfig,
  type ProjectObserver,
} from "@jleechanorg/ao-core";
import { getSessionManager } from "./create-session-manager.js";
import {
  ensureLifecycleWorker,
  stopLifecycleWorker,
} from "./lifecycle-service.js";

const DEFAULT_SUPERVISOR_INTERVAL_MS = 60_000;

interface SupervisorHandle {
  stop: () => void;
  reconcileNow: () => Promise<void>;
}

let activeSupervisor: SupervisorHandle | null = null;

export interface ReconcileProjectSupervisorOptions {
  intervalMs?: number;
}

function isMissingGlobalConfigError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Record<string, unknown>).code === "ENOENT"
  );
}

function reportProjectSupervisorError(
  observer: ProjectObserver,
  projectId: string,
  reason: string,
  error: unknown,
): void {
  observer.setHealth({
    surface: "project-supervisor.reconcile",
    status: "warn",
    projectId,
    correlationId: createCorrelationId("project-supervisor"),
    reason,
    details: {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    },
  });
}

async function projectHasNonTerminalSession(
  config: OrchestratorConfig,
  projectId: string,
): Promise<boolean> {
  const sm = await getSessionManager(config);
  const sessions = await sm.list(projectId);
  return sessions.some((session) => !isTerminalSession(session));
}

export async function reconcileProjectSupervisor(
  _options: ReconcileProjectSupervisorOptions = {},
): Promise<void> {
  const config = loadConfig();
  const observer = createProjectObserver(config, "project-supervisor");
  const configuredProjectIds = new Set(Object.keys(config.projects));

  for (const projectId of configuredProjectIds) {
    try {
      const hasNonTerminalSession = await projectHasNonTerminalSession(config, projectId);

      if (hasNonTerminalSession) {
        await ensureLifecycleWorker(config, projectId);
      } else {
        await stopLifecycleWorker(config, projectId);
      }
    } catch (error) {
      reportProjectSupervisorError(
        observer,
        projectId,
        "Failed to reconcile lifecycle worker for project",
        error,
      );
    }
  }
}

export async function startProjectSupervisor(
  intervalMs: number = DEFAULT_SUPERVISOR_INTERVAL_MS,
): Promise<SupervisorHandle> {
  if (activeSupervisor) return activeSupervisor;

  let reconciling = false;
  let pending = false;
  let stopped = false;
  let waiters: Array<() => void> = [];

  const run = async (options: { swallowErrors?: boolean } = {}): Promise<void> => {
    if (stopped) return;
    if (reconciling) {
      pending = true;
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }

    reconciling = true;
    try {
      do {
        pending = false;
        try {
          await reconcileProjectSupervisor({ intervalMs });
        } catch (error) {
          if (isMissingGlobalConfigError(error)) return;
          if (!options.swallowErrors) throw error;
        }
      } while (pending && !stopped);
    } finally {
      reconciling = false;
      const pendingWaiters = waiters;
      waiters = [];
      for (const resolve of pendingWaiters) resolve();
    }
  };

  const timer = setInterval(() => {
    void run({ swallowErrors: true });
  }, intervalMs);
  timer.unref?.();

  const handle: SupervisorHandle = {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      activeSupervisor = null;
    },
    reconcileNow: run,
  };
  activeSupervisor = handle;

  try {
    await run();
  } catch (error) {
    handle.stop();
    throw error;
  }
  return handle;
}

export function stopProjectSupervisor(): void {
  activeSupervisor?.stop();
}
