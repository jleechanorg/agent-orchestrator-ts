import { backfillUncoveredPRs } from "./backfill-extensions.js";
import { drainSpawnQueue } from "./spawn-queue.js";
import { drainTaskQueue } from "./task-queue.js";
import type {
  OrchestratorConfig,
  OrchestratorEvent,
  EventPriority,
  PluginRegistry,
  ProjectConfig,
  SCM,
  Session,
  SessionManager,
} from "./types.js";
import type { ProjectObserver } from "./observability.js";

export interface LifecycleProjectCronDeps {
  registry: PluginRegistry;
  sessionManager: SessionManager;
  observer: ProjectObserver;
  notifyHuman?: (event: OrchestratorEvent, priority: EventPriority) => Promise<void>;
}

export interface LifecycleProjectCronParams {
  projectId: string;
  project: ProjectConfig;
  config: OrchestratorConfig;
  activeSessions: Session[];
  correlationId: string;
  nowMs: number;
  lastBackfillWarnTimeByProject: Map<string, number>;
  backfillWarnIntervalMs: number;
}

export interface LifecycleProjectCronResult {
  spawned: boolean;
}

type CronName = "spawn_queue" | "backfill" | "backfill_warning" | "task_queue";

async function runCron<T>(
  deps: Pick<LifecycleProjectCronDeps, "observer">,
  params: Pick<LifecycleProjectCronParams, "projectId" | "correlationId">,
  name: CronName,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    deps.observer.recordOperation({
      metric: "lifecycle_poll",
      operation: `lifecycle.${name}.cron_failed`,
      outcome: "failure",
      correlationId: params.correlationId,
      projectId: params.projectId,
      data: { error: error instanceof Error ? error.message : String(error) },
      level: "warn",
    });
    return fallback;
  }
}

export async function runLifecycleProjectCrons(
  deps: LifecycleProjectCronDeps,
  params: LifecycleProjectCronParams,
): Promise<LifecycleProjectCronResult> {
  const queuedSpawned = await runCron(
    deps,
    params,
    "spawn_queue",
    () => drainSpawnQueue(
      { sessionManager: deps.sessionManager, observer: deps.observer },
      {
        projectId: params.projectId,
        project: params.project,
        configPath: params.config.configPath ?? "",
        activeSessions: params.activeSessions,
        correlationId: params.correlationId,
      },
    ),
    0,
  );

  let spawned = queuedSpawned > 0;
  if (queuedSpawned > 0) {
    return { spawned };
  }

  const backfillEnabled = params.project.backfillAllPRs === true;
  if (backfillEnabled) {
    const backfillSpawned = await runCron(
      deps,
      params,
      "backfill",
      () => backfillUncoveredPRs(
        {
          registry: deps.registry,
          sessionManager: deps.sessionManager,
          observer: deps.observer,
          notifyHuman: deps.notifyHuman,
        },
        {
          projectId: params.projectId,
          project: params.project,
          activeSessions: params.activeSessions,
          correlationId: params.correlationId,
          worktreeDir: (params.config as { worktreeDir?: string }).worktreeDir,
          configPath: params.config.configPath ?? "",
        },
      ),
      false,
    );
    spawned = spawned || backfillSpawned;
  } else if (params.project.backfillAllPRs === false) {
    await runCron(
      deps,
      params,
      "backfill_warning",
      () => maybeWarnBackfillDisabledWithOpenPRs({
        projectId: params.projectId,
        project: params.project,
        nowMs: params.nowMs,
        correlationId: params.correlationId,
        observer: deps.observer,
        registry: deps.registry,
        lastBackfillWarnTimeByProject: params.lastBackfillWarnTimeByProject,
        BACKFILL_WARN_INTERVAL_MS: params.backfillWarnIntervalMs,
      }),
      undefined,
    );
  }

  if (params.project.taskQueue?.enabled) {
    const taskQueueSpawned = await runCron(
      deps,
      params,
      "task_queue",
      () => drainTaskQueue(
        { registry: deps.registry, sessionManager: deps.sessionManager, observer: deps.observer },
        {
          projectId: params.projectId,
          project: params.project,
          configPath: params.config.configPath ?? "",
          activeSessions: params.activeSessions,
          correlationId: params.correlationId,
        },
      ),
      0,
    );
    spawned = spawned || taskQueueSpawned > 0;
  }

  return { spawned };
}

/**
 * maybeWarnBackfillDisabledWithOpenPRs — throttled warning when backfill is explicitly disabled.
 * Surface open-PR leakage risk for operator visibility. Throttled to reduce SCM API load.
 */
export async function maybeWarnBackfillDisabledWithOpenPRs(args: {
  projectId: string;
  project: ProjectConfig;
  nowMs: number;
  correlationId: string;
  observer: ProjectObserver;
  registry: PluginRegistry;
  lastBackfillWarnTimeByProject: Map<string, number>;
  BACKFILL_WARN_INTERVAL_MS: number;
}): Promise<void> {
  const lastWarn = args.lastBackfillWarnTimeByProject.get(args.projectId) ?? 0;
  if (args.nowMs - lastWarn < args.BACKFILL_WARN_INTERVAL_MS) {
    return;
  }

  const scmPlugin = args.project.scm ? args.registry.get<SCM>("scm", args.project.scm.plugin) : null;
  const listOpenPRs = scmPlugin?.listOpenPRs?.bind(scmPlugin);
  if (!listOpenPRs) return;

  try {
    const openPRs = await listOpenPRs(args.project);
    const nonDraftOpen = openPRs.filter((pr) => !pr.isDraft).length;
    if (nonDraftOpen > 0) {
      args.observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.backfill.disabled_with_open_prs",
        outcome: "failure",
        correlationId: args.correlationId,
        projectId: args.projectId,
        data: { nonDraftOpenPRs: nonDraftOpen },
        level: "warn",
      });
    }
  } catch {
    /* fail-open: skip warning on list error */
  } finally {
    args.lastBackfillWarnTimeByProject.set(args.projectId, args.nowMs);
  }
}
