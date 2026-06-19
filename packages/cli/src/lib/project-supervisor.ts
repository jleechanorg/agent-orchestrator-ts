import {
  loadConfig,
  findManagedConfigFile,
  ConfigNotFoundError,
  isTerminalSession,
  createCorrelationId,
  createProjectObserver,
  type OrchestratorConfig,
  type ProjectObserver,
  type Session,
} from "@jleechanorg/ao-core";
import { getSessionManager } from "./create-session-manager.js";
import {
  ensureLifecycleWorker,
  listLifecycleWorkers,
  stopLifecycleWorker,
} from "./lifecycle-service.js";
import { addProjectToRunning, removeProjectFromRunning } from "./running-state.js";

const DEFAULT_SUPERVISOR_INTERVAL_MS = 60_000;

interface SupervisorHandle {
  stop: () => void;
  reconcileNow: () => Promise<void>;
}

let activeSupervisor: SupervisorHandle | null = null;

type SupervisorConfigSource = "global" | "local-fallback";

interface LoadedSupervisorConfig {
  config: OrchestratorConfig;
  source: SupervisorConfigSource;
}

export interface ReconcileProjectSupervisorOptions {
  intervalMs?: number;
  configPath?: string;
}

export interface StartProjectSupervisorOptions {
  intervalMs?: number;
  configPath?: string;
}

function isMissingConfigError(error: unknown): boolean {
  if (error instanceof ConfigNotFoundError) return true;
  return (
    error instanceof Error &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "EISDIR")
  );
}

function loadSupervisorConfig(configPath?: string): LoadedSupervisorConfig {
  const globalConfigPath = findManagedConfigFile();
  try {
    if (!globalConfigPath) {
      throw new ConfigNotFoundError();
    }
    return { config: loadConfig(globalConfigPath), source: "global" };
  } catch (error) {
    if (error instanceof ConfigNotFoundError) {
      const config = configPath ? loadConfig(configPath) : loadConfig();
      return { config, source: "local-fallback" };
    }
    throw error;
  }
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
  const sessions: Session[] = await sm.list(projectId);
  return sessions.some((session) => !isTerminalSession(session));
}

export async function reconcileProjectSupervisor(
  options: ReconcileProjectSupervisorOptions = {},
): Promise<void> {
  const { config, source } = loadSupervisorConfig(options.configPath);
  const observer = createProjectObserver(config, "project-supervisor");
  const configuredProjectIds = new Set(Object.keys(config.projects));

  if (source === "global") {
    const activeProjectIds = new Set(listLifecycleWorkers());
    for (const projectId of activeProjectIds) {
      if (!configuredProjectIds.has(projectId)) {
        try {
          await stopLifecycleWorker(projectId);
          await removeProjectFromRunning(projectId);
        } catch (error) {
          reportProjectSupervisorError(
            observer,
            projectId,
            "Failed to detach lifecycle worker for removed project",
            error,
          );
        }
      }
    }
  }

  for (const projectId of configuredProjectIds) {
    try {
      const hasNonTerminalSession = await projectHasNonTerminalSession(config, projectId);
      const isAttached = listLifecycleWorkers().includes(projectId);

      if (hasNonTerminalSession) {
        if (!isAttached) {
          await ensureLifecycleWorker(config, projectId);
        }
        await addProjectToRunning(projectId);
      } else if (isAttached) {
        await stopLifecycleWorker(projectId);
        await removeProjectFromRunning(projectId);
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
  options: StartProjectSupervisorOptions | number = {},
): Promise<SupervisorHandle> {
  if (activeSupervisor) return activeSupervisor;

  const intervalMs = typeof options === "number" ? options : (options.intervalMs ?? DEFAULT_SUPERVISOR_INTERVAL_MS);
  const configPath = typeof options === "number" ? undefined : options.configPath;

  let reconciling = false;
  let pending = false;
  let stopped = false;
  let waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

  const run = async (runOptions: { swallowErrors?: boolean } = {}): Promise<void> => {
    if (stopped) return;
    if (reconciling) {
      pending = true;
      return new Promise<void>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    }

    reconciling = true;
    let err: unknown;
    try {
      do {
        pending = false;
        try {
          await reconcileProjectSupervisor({ intervalMs, configPath });
        } catch (error) {
          if (isMissingConfigError(error)) return;
          err = error;
          if (!runOptions.swallowErrors) throw error;
        }
      } while (pending && !stopped);
    } finally {
      reconciling = false;
      // Only reject callers who passed swallowErrors=false.
      // Callers who ran via interval timer (swallowErrors=true) get
      // resolved even when err is set — their caller already handled the
      // failure silently.
      const pendingWaiters = waiters;
      waiters = [];
      for (const w of pendingWaiters) {
        if (err && runOptions.swallowErrors === false) w.reject(err);
        else w.resolve();
      }
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
