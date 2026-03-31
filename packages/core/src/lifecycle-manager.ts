/**
 * Lifecycle Manager — state machine + polling loop + reaction engine.
 *
 * Periodically polls all sessions and:
 * 1. Detects state transitions (spawning → working → pr_open → etc.)
 * 2. Emits events on transitions
 * 3. Triggers reactions (auto-handle CI failures, review comments, etc.)
 * 4. Escalates to human notification when auto-handling fails
 *
 * Reference: scripts/claude-session-status, scripts/claude-review-check
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { logAoAction } from "./ao-action-log.js";
import { reapPostMergeCoWorkers } from "./fork-lifecycle-postmerge.js";
import {
  pruneStaleSessionIds,
  getLastSentMessageHash,
  setLastSentMessageHash,
  getLastSentHeadSha,
  setLastSentHeadSha,
  hashMessageContent,
} from "./dedup-head-sha-store.js";
import {
  SESSION_STATUS,
  PR_STATE,
  CI_STATUS,
  TERMINAL_STATUSES,
  isOrchestratorSession,
  type LifecycleManager,
  type SessionManager,
  type SessionId,
  type SessionStatus,
  type EventType,
  type OrchestratorEvent,
  type OrchestratorConfig,
  type ReactionConfig,
  type ReactionResult,
  type PluginRegistry,
  type Runtime,
  type Agent,
  type SCM,
  type Notifier,
  type Session,
  type EventPriority,
  type PRState,
  type ProjectConfig as _ProjectConfig,
} from "./types.js";
import { readMetadataRaw, updateMetadata } from "./metadata.js";
import { getSessionsDir } from "./paths.js";
import {
  clearProjectPause,
  detectAndApplyRateLimitPause,
} from "./fork-lifecycle-manager.js";
import { createCorrelationId, createProjectObserver } from "./observability.js";
import { resolveAgentSelection, resolveSessionRole } from "./agent-selection.js";
import type { OutcomeRecorder } from "./outcome-recorder.js";
import {
  checkStuckWorker,
  resetIdleCycles,
} from "./stuck-worker-detector.js";
import {
  capturePane as tmuxCapturePane,
  killSession as tmuxKillSession,
  sendKeys as tmuxSendKeys,
} from "./tmux.js";
import { buildReactionContext } from "./reaction-context.js";
import { validateAndEmitExitProof } from "./session-exit-proof.js";
import { isPRMerged } from "./fork-lifecycle-kki-override.js";
import { handleRequestMerge, handleParallelRetry } from "./fork-reaction-handlers.js";
import { handleRespawnForReview } from "./fork-reaction-rfr.js";
import { maybeDispatchReviewBacklog } from "./review-backlog.js";
import { updateSessionMetadataHelper } from "./fork-utils.js";
import { checkMergeGate, type MergeGateResult } from "./merge-gate.js";
import { GLOBAL_PAUSE_UNTIL_KEY, GLOBAL_PAUSE_REASON_KEY, parsePauseUntil } from "./global-pause.js";
import { isGhRateLimitError } from "./gh-rate-limit.js";
import { backfillUncoveredPRs } from "./backfill-extensions.js";
import { sweepOrphanTmuxSessions, DEFAULT_TMUX_SWEEPER_CONFIG } from "./tmux-session-sweeper.js";
import { drainTaskQueue } from "./task-queue.js";
import { applyDeadAgentOverride } from "./fork-dead-agent.js";
import {
  initMcpMailClient,
  getMcpMailClientConfig,
  pollMcpMailInbox,
  sendMcpMailHeartbeat,
  sendMcpMailSessionStart,
  sendMcpMailSessionEnd,
  type McpMailClientConfig,
} from "./mcp-mail.js";
import { runSkepticReviewReaction } from "./fork-skeptic-extension.js";
import { runClaimVerification } from "./fork-claim-verification.js";
import { runLocalSkepticCron } from "./skeptic-cron-local.js";
import { resolveReactionMaxRetries } from "./fork-reaction-retry-policy.js";

/**
 * verify6Green — explicit 6-green pre-merge verification (bd-mjtn)
 *
 * Enforces all six PR readiness conditions BEFORE any merge attempt:
 *   Gate 1: CI green (all checks SUCCESS)
 *   Gate 2: No merge conflicts (mergeable: MERGEABLE)
 *   Gate 3: CodeRabbit APPROVED (actionable reviews only — APPROVED/CHANGES_REQUESTED,
 *            COMMENTED/DISMISSED states are ignored)
 *   Gate 4: Bugbot clean (no error-severity cursor[bot] comments)
 *   Gate 5: All inline comments resolved (GraphQL reviewThreads.isResolved with
 *            REST fallback when GraphQL is exhausted; REST returns isResolved=false
 *            which blocks the gate until resolved — this is intentional fail-closed
 *            behaviour)
 *
 * Skeptic (Gate 6) and evidence-review (Gate 7) are NOT enforced here — those are
 * optional per-project gates controlled via MergeGateConfig.  Agents are expected
 * to have already run /er and posted the skeptic VERDICT: PASS comment before
 * posting the green signal.
 *
 * @param pr            - PR to verify
 * @param scm           - SCM plugin instance
 * @param projectMergeGate - Optional project-level MergeGateConfig.  When provided,
 *                           the project's `mergeGate.enabled` setting is respected so
 *                           that projects with mergeGate disabled still allow the
 *                           reaction to proceed (backward compat).  The skepticRequired
 *                           field is always forced to false to prevent the 7th gate
 *                           from being inadvertently activated.
 *
 * Call this in the approved-and-green reaction BEFORE calling scm.mergePR().
 * If any gate fails, the merge MUST be skipped — do NOT attempt to merge a
 * non-green PR.
 */
export async function verify6Green(
  pr: import("./types.js").PRInfo,
  scm: import("./types.js").SCM,
  projectMergeGate?: import("./types.js").MergeGateConfig,
): Promise<MergeGateResult> {
  const config: import("./types.js").MergeGateConfig = {
    // Respect the project's enabled setting so projects with mergeGate disabled
    // continue to work (backward compat).  When no project config is provided,
    // default to enabled so verify6Green is always on when called without config.
    enabled: projectMergeGate?.enabled ?? true,
    ...projectMergeGate,
    // Always force skepticRequired=false regardless of project config — Skeptic is
    // Gate 6 / an optional per-project gate, not part of the 6-green contract.
    skepticRequired: false,
  };
  return checkMergeGate(pr, config, scm);
}

/** Parse a duration string like "10m", "30s", "1h" to milliseconds. */
export function parseDuration(str: string): number {
  const match = str.match(/^(\d+)(s|m|h)$/);
  if (!match) return 0;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    default:
      return 0;
  }
}

/** Infer a reasonable priority from event type. */
function inferPriority(type: EventType): EventPriority {
  if (type.includes("stuck") || type.includes("needs_input") || type.includes("errored")) {
    return "urgent";
  }
  if (type.startsWith("summary.")) {
    return "info";
  }
  if (
    type.includes("approved") ||
    type.includes("ready") ||
    type.includes("merged") ||
    type.includes("completed")
  ) {
    return "action";
  }
  if (type.includes("fail") || type.includes("changes_requested") || type.includes("conflicts")) {
    return "warning";
  }
  return "info";
}

/** Create an OrchestratorEvent with defaults filled in. */
function createEvent(
  type: EventType,
  opts: {
    sessionId: SessionId;
    projectId: string;
    message: string;
    priority?: EventPriority;
    data?: Record<string, unknown>;
  },
): OrchestratorEvent {
  return {
    id: randomUUID(),
    type,
    priority: opts.priority ?? inferPriority(type),
    sessionId: opts.sessionId,
    projectId: opts.projectId,
    timestamp: new Date(),
    message: opts.message,
    data: opts.data ?? {},
  };
}

/** Determine which event type corresponds to a status transition. */
function statusToEventType(_from: SessionStatus | undefined, to: SessionStatus): EventType | null {
  switch (to) {
    case "spawning":
      return "session.spawned";
    case "working":
      return "session.working";
    case "pr_open":
      return "pr.created";
    case "ci_failed":
      return "ci.failing";
    case "review_pending":
      return "review.pending";
    case "changes_requested":
      return "review.changes_requested";
    case "approved":
      return "review.approved";
    case "mergeable":
      return "merge.ready";
    case "merge_conflicts":
      return "merge.conflicts";
    case "merged":
      return "merge.completed";
    case "needs_input":
      return "session.needs_input";
    case "stuck":
      return "session.stuck";
    case "errored":
      return "session.errored";
    case "killed":
      return "session.killed";
    case "terminated":
      return "session.exited";
    default:
      return null;
  }
}

/** Map event type to reaction config key. */
function eventToReactionKey(eventType: EventType): string | null {
  switch (eventType) {
    case "ci.failing":
      return "ci-failed";
    case "review.changes_requested":
      return "changes-requested";
    case "automated_review.found":
      return "bugbot-comments";
    case "merge.conflicts":
      return "merge-conflicts";
    case "merge.ready":
      return "approved-and-green";
    case "session.stuck":
      return "agent-stuck";
    case "session.needs_input":
      return "agent-needs-input";
    case "session.killed":
      return "agent-exited";
    case "summary.all_complete":
      return "all-complete";
    case "worker.signals_completion":
      return "worker-signals-completion";
    case "session.spawned":
      return "session-spawned";
    case "session.exited":
      return "session-exited";
    default:
      return null;
  }
}

function transitionLogLevel(status: SessionStatus): "info" | "warn" | "error" {
  const eventType = statusToEventType(undefined, status);
  if (!eventType) {
    return "info";
  }
  const priority = inferPriority(eventType);
  if (priority === "urgent") {
    return "error";
  }
  if (priority === "warning") {
    return "warn";
  }
  return "info";
}

export interface LifecycleManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
  /** When set, only poll sessions belonging to this project. */
  projectId?: string;
  /** Optional outcome recorder for tracking session results. */
  outcomeRecorder?: OutcomeRecorder;
  /** MCP mail client config — initialized from project config if not provided. */
  mcpMailConfig?: McpMailClientConfig;
}

/** Track attempt counts for reactions per session. */
interface ReactionTracker {
  attempts: number;
  firstTriggered: Date;
}

/**
 * Module-level skeptic trigger — extracted so tests can call the actual implementation.
 * Fires worker-signals-completion for a session, records the HEAD SHA on success,
 * then dispatches claim-verification. Returns true iff the reaction succeeded.
 *
 * The `executeReaction` and `observer` parameters must be provided by the caller
 * so this function is directly testable without a full LifecycleManager instance.
 */
export async function triggerSkepticReaction(
  session: Session,
  lastSkepticSha: Map<string, string>,
  correlationId: string,
  config: OrchestratorConfig,
  registry: PluginRegistry,
  executeReaction: (
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
    session?: Session,
    correlationId?: string,
  ) => Promise<ReactionResult>,
): Promise<boolean> {
  const project = config.projects[session.projectId];
  const globalReaction = config.reactions["worker-signals-completion"];
  const projectReaction = project?.reactions?.["worker-signals-completion"];
  const reactionConfig = projectReaction
    ? { ...globalReaction, ...projectReaction }
    : globalReaction;
  if (!reactionConfig?.action || reactionConfig.auto === false) {
    return false;
  }

  let reactionSuccess = false;
  try {
    const result = await executeReaction(
      session.id,
      session.projectId,
      "worker-signals-completion",
      reactionConfig,
      session,
      correlationId,
    );
    reactionSuccess = Boolean(result?.success);
  } catch {
    reactionSuccess = false;
  }

  if (reactionSuccess && session.pr) {
    const scm = project?.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
    if (scm?.getPRHeadSha) {
      try {
        const sha = await scm.getPRHeadSha(session.pr);
        if (sha) lastSkepticSha.set(session.id, sha);
      } catch {
        // Non-fatal — will re-trigger on next poll if SHA check fails
      }
    }

    // bd-jzan: also dispatch claim-verification after skeptic fires
    const claimGlobal = config.reactions["claim-verification"];
    const claimProject = project?.reactions?.["claim-verification"];
    const claimCfg = claimProject
      ? { ...claimGlobal, ...claimProject }
      : claimGlobal;
    if (claimCfg?.action && claimCfg.auto !== false) {
      try {
        await executeReaction(
          session.id,
          session.projectId,
          "claim-verification",
          claimCfg,
          session,
          "claim-verification",
        );
      } catch {
        // Non-fatal — claim verification failure does not block PR flow
      }
    }
  }

  return reactionSuccess;
}

/** Create a LifecycleManager instance. */
export function createLifecycleManager(deps: LifecycleManagerDeps): LifecycleManager {
  const {
    config,
    registry,
    sessionManager,
    projectId: scopedProjectId,
    outcomeRecorder,
    mcpMailConfig: providedMcpMailConfig,
  } = deps;
  const observer = createProjectObserver(config, "lifecycle-manager");

  // Initialize MCP mail client — prefer caller-supplied config, fall back to env var
  if (providedMcpMailConfig) {
    initMcpMailClient(providedMcpMailConfig);
  } else {
    const mcpEndpoint = process.env["MCP_AGENT_MAIL_URL"];
    if (mcpEndpoint) {
      const project = scopedProjectId ? config.projects[scopedProjectId] : undefined;
      const mcpMailCfg: McpMailClientConfig = {
        endpoint: mcpEndpoint,
        projectKey: scopedProjectId ?? project?.name ?? "global",
        agentId: scopedProjectId ? `lw-${scopedProjectId}` : "lw-global",
      };
      initMcpMailClient(mcpMailCfg);
    }
  }

  // Inbox poll state — separate timer so inbox polls run every 5 min
  // regardless of the session lifecycle poll interval
  let inboxPollTimer: ReturnType<typeof setInterval> | null = null;
  const INBOX_POLL_INTERVAL_MS = 5 * 60_000; // every 5 minutes

  // Productivity check state — separate 15-min interval for PR-level checks
  let productivityTimer: ReturnType<typeof setInterval> | null = null;
  let productivityRunning = false; // re-entrancy guard
  const PRODUCTIVITY_INTERVAL_MS = 15 * 60_000; // every 15 minutes

  /** Track current task per session (for heartbeat messaging). */
  const sessionCurrentTask = new Map<string, string>();

  /** Run all productivity checks for active sessions. */
  async function runProductivityCycle(): Promise<void> {
    if (productivityRunning) return;
    productivityRunning = true;
    try {
      const sessions = await sessionManager.list(scopedProjectId);

      // Mirror pollAll: build a snapshot of currently-paused projects so
      // productivity checks skip paused sessions (bd-nk7).
      const pausedProjects = new Map<string, Date>();
      for (const session of sessions) {
        if (!isOrchestratorSession(session)) continue;
        const until = parsePauseUntil(session.metadata[GLOBAL_PAUSE_UNTIL_KEY]);
        if (!until) continue;
        if (until.getTime() <= Date.now()) {
          // Pause has expired — clear it from disk.
          const project = config.projects[session.projectId];
          if (project && session.metadata[GLOBAL_PAUSE_REASON_KEY]) {
            clearProjectPause(config.configPath, project);
          }
          continue;
        }
        pausedProjects.set(session.projectId, until);
      }

      // Filter to active (non-terminal) sessions, excluding paused projects.
      const active = sessions.filter(
        (s: Session) =>
          !TERMINAL_STATUSES.has(s.status) &&
          !pausedProjects.has(s.projectId),
      );
      const tmux = await import("./tmux.js");
      const { runProductivityChecks } = await import("./productivity-checker.js");
      await runProductivityChecks(active, {
        config,
        sessionManager,
        capturePane: tmux.capturePane,
        killSession: tmux.killSession,
        sendKeys: tmux.sendKeys,
      });
    } catch (err) {
      // non-fatal — productivity check failure should not crash the main loop
      console.warn("[lifecycle-manager] productivity check failed:", err instanceof Error ? err.message : String(err));
    } finally {
      productivityRunning = false;
    }
  }

  function startProductivityChecking(): void {
    if (productivityTimer) return;
    productivityTimer = setInterval(() => void runProductivityCycle(), PRODUCTIVITY_INTERVAL_MS);
    productivityTimer.unref();
    // Run immediately on start
    void runProductivityCycle();
  }

  function startInboxPolling(): void {
    if (inboxPollTimer) return;
    inboxPollTimer = setInterval(async () => {
      // Re-entrancy guard: skip this poll if the previous one is still running
      if (inboxPolling) return;
      inboxPolling = true;
      try {
        if (getMcpMailClientConfig()) {
          await pollMcpMailInbox().catch(() => {/* non-fatal */});
        }
      } finally {
        inboxPolling = false;
      }
    }, INBOX_POLL_INTERVAL_MS);
    inboxPollTimer.unref();
  }

  const states = new Map<SessionId, SessionStatus>();
  const reactionTrackers = new Map<string, ReactionTracker>(); // "sessionId:reactionKey"
  const mergeRetryTimestamps = new Map<string, number>(); // "merge-retry-{sessionId}" → last attempt epoch
  const stuckRetryTimestamps = new Map<string, number>(); // "stuck-retry-{sessionId}" → last attempt epoch
  const stuckEntryTimestamps = new Map<string, number>(); // "stuck-entry-{sessionId}" → when session entered stuck
  // bd-qnj6: track the last HEAD SHA that triggered a skeptic evaluation per session.
  // When the SHA changes while session stays in pr_open, re-fire the skeptic reaction.
  const lastSkepticSha = new Map<string, string>(); // sessionId → last evaluated HEAD SHA
  // bd-qqm: track the last skeptic comment ID per session to detect new FAIL verdicts.
  // Initialized lazily (undefined = never fetched), compared against fetched comment IDs each poll.
  const lastSkepticCommentId = new Map<string, number>(); // sessionId → last known comment ID
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false; // re-entrancy guard
  let inboxPolling = false; // re-entrancy guard for concurrent inbox polls
  let allCompleteEmitted = false; // guard against repeated all_complete
  let everHadSessions = false; // tracks whether any sessions have ever been observed
  let lastSweepTime = 0; // timestamp of last orphan tmux sweep
  const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // run orphan sweep every 5 minutes

  /** Check if idle time exceeds the agent-stuck threshold. */
  function isIdleBeyondThreshold(session: Session, idleTimestamp: Date): boolean {
    const stuckReaction = getReactionConfigForSession(session, "agent-stuck");
    const thresholdStr = stuckReaction?.threshold;
    if (typeof thresholdStr !== "string") return false;
    const stuckThresholdMs = parseDuration(thresholdStr);
    if (stuckThresholdMs <= 0) return false;
    const idleMs = Date.now() - idleTimestamp.getTime();
    return idleMs > stuckThresholdMs;
  }

  /** Determine current status for a session by polling plugins. */
  async function determineStatus(session: Session): Promise<{ status: SessionStatus; agentDead: boolean }> {
    // bd-85r: Startup grace period — skip all liveness/activity probes for
    // sessions created within the grace window. Agent CLIs need time to
    // initialize; polling before they're ready sees "exited"/"idle" and kills
    // the session. During the grace period, we trust the session is starting up.
    const sessionAgeMs = Date.now() - session.createdAt.getTime();
    if (session.status === "spawning" && sessionAgeMs < (config.startupGracePeriodMs ?? 120_000)) {
      return { status: "spawning", agentDead: false };
    }

    // If workspace was deleted (e.g., worktree cleaned up), session is dead
    if (session.workspacePath && !existsSync(session.workspacePath)) {
      return { status: "killed", agentDead: true };
    }

    const project = config.projects[session.projectId];
    if (!project) return { status: session.status, agentDead: false };

    const agentName = resolveAgentSelection({
      role: resolveSessionRole(session.id, session.metadata),
      project,
      defaults: config.defaults,
      persistedAgent: session.metadata["agent"],
    }).agentName;
    const agent = registry.get<Agent>("agent", agentName);
    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;

    const runtime = session.runtimeHandle
      ? registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime)
      : null;

    // Track activity state across steps so stuck detection can run after PR checks
    let detectedIdleTimestamp: Date | null = null;

    // Track whether agent is dead so we can return "killed" AFTER PR checks
    // (bd-ara auto-merge fix: agent exit must not mask a mergeable PR)
    let agentDead = false;

    // bd-6jc: Consecutive SCM failure counter. Prevents worktree destruction on
    // transient SCM failures (network blip, rate limit). Count is persisted in
    // session metadata so it survives across poll cycles. Resets to 0 on any
    // successful SCM call; only kills after 3 consecutive SCM failures.
    const SCM_FAILURE_THRESHOLD = 3;
    const rawCount = session.metadata["scmFailureCount"];
    let scmFailureCount =
      typeof rawCount === "string" ? parseInt(rawCount, 10) : Number(rawCount);
    if (Number.isNaN(scmFailureCount)) scmFailureCount = 0;
    // bd-6jc: tracks whether an SCM error was caught; used in finally to decide
    // whether to reset the counter (only reset on genuine SCM success).
    let scmErrorOccurred = false;

    // 1. Check if runtime is alive — but skip probes for sessions still
    // within the startup grace period. A false negative from isAlive during
    // agent CLI init would kill the session before it ever gets a chance to
    // write its first activity marker.
    if (
      session.runtimeHandle &&
      runtime &&
      (session.status !== "spawning" || sessionAgeMs >= (config.startupGracePeriodMs ?? 120_000))
    ) {
      const alive = await runtime.isAlive(session.runtimeHandle).catch(() => true);
      if (!alive) {
        // Don't return "killed" yet — if the session has a PR (or might have
        // one discoverable via branch-based auto-detect in step 3), check PR
        // state first so auto-merge can fire for green PRs with exited agents.
        if (!scm) return { status: "killed", agentDead: true };
        agentDead = true;
      }

      if (!agentDead) {
        await detectAndApplyRateLimitPause(config.configPath, session, project, runtime, sessionManager);
      }
    }

    // 2. Check agent activity — prefer JSONL-based detection (runtime-agnostic)
    if (!agentDead && agent && session.runtimeHandle) {
      try {
        // Try JSONL-based activity detection first (reads agent's session files directly)
        const activityState = await agent.getActivityState(session, config.readyThresholdMs);
        if (activityState) {
          if (activityState.state === "waiting_input") return { status: "needs_input", agentDead: false };
          if (activityState.state === "exited") {
            // Don't return "killed" yet — defer to step 3 (branch-based PR
            // auto-detect) and step 4 (PR state checks) before giving up.
            if (!scm) return { status: "killed", agentDead: true };
            agentDead = true;
          }

          if (
            !agentDead &&
            (activityState.state === "idle" || activityState.state === "blocked") &&
            activityState.timestamp
          ) {
            detectedIdleTimestamp = activityState.timestamp;
          }

          // active/ready/idle (below threshold)/blocked (below threshold) —
          // proceed to PR checks below
        } else {
          // getActivityState returned null — fall back to terminal output parsing
          const runtime = registry.get<Runtime>(
            "runtime",
            project.runtime ?? config.defaults.runtime,
          );
          const terminalOutput = runtime ? await runtime.getOutput(session.runtimeHandle, 10) : "";
          if (terminalOutput) {
            const activity = agent.detectActivity(terminalOutput);
            if (activity === "waiting_input") return { status: "needs_input", agentDead: false };

            const processAlive = await agent.isProcessRunning(session.runtimeHandle);
            if (!processAlive) {
              if (!scm) return { status: "killed", agentDead: true };
              agentDead = true;
            }
          }
        }
      } catch {
        // On probe failure, preserve current stuck/needs_input state rather
        // than letting the fallback at the bottom coerce them to "working"
        if (
          session.status === SESSION_STATUS.STUCK ||
          session.status === SESSION_STATUS.NEEDS_INPUT
        ) {
          return { status: session.status, agentDead: false };
        }
      }
    }

    // 3. Auto-detect PR by branch if metadata.pr is missing.
    //    This is critical for agents without auto-hook systems (Codex, Aider,
    //    OpenCode) that can't reliably write pr=<url> to metadata on their own.
    //    Skip orchestrator sessions — they sit on the base branch (e.g. master)
    //    and should never own a PR.
    if (
      !session.pr &&
      scm &&
      session.branch &&
      session.metadata["prAutoDetect"] !== "off" &&
      session.metadata["role"] !== "orchestrator" &&
      !session.id.endsWith("-orchestrator")
    ) {
      try {
        const detectedPR = await scm.detectPR(session, project);
        if (detectedPR) {
          session.pr = detectedPR;
          // Persist PR URL so subsequent polls don't need to re-query.
          // Don't write status here — step 4 below will determine the
          // correct status (merged, ci_failed, etc.) on this same cycle.
          const sessionsDir = getSessionsDir(config.configPath, project.path);
          updateMetadata(sessionsDir, session.id, { pr: detectedPR.url });
        }
      } catch {
        // bd-6jc: detectPR threw — this SCM failure counts toward the consecutive-
        // failure threshold just like step 4 SCM failures. Increment and persist so
        // repeated detectPR blips accumulate across polls (e.g. network glitch).
        scmErrorOccurred = true;
        scmFailureCount++;
        session.metadata["scmFailureCount"] = String(scmFailureCount);
        const sessionsDir = getSessionsDir(config.configPath, project.path);
        updateMetadata(sessionsDir, session.id, { scmFailureCount: String(scmFailureCount) });
        if (agentDead && scmFailureCount >= SCM_FAILURE_THRESHOLD) {
          // Threshold reached — same killConfirmed pattern as step 4 catch.
          session.metadata["killConfirmed"] = "true";
          updateMetadata(sessionsDir, session.id, { killConfirmed: "true" });
          return { status: "killed", agentDead: true };
        }
      } finally {
        // bd-6jc: detectPR succeeded — reset counter so a transient detectPR error
        // doesn't indefinitely block the no-PR kill path. scmErrorOccurred is scoped
        // to step-3's try/catch/finally (step-4 has its own), so a true value here
        // means step-3's catch ran and the counter should NOT be reset.
        if (!scmErrorOccurred && scmFailureCount !== 0) {
          scmFailureCount = 0;
          session.metadata["scmFailureCount"] = "0";
          const sessionsDir = getSessionsDir(config.configPath, project.path);
          updateMetadata(sessionsDir, session.id, { scmFailureCount: "0" });
        }
      }
    }

    // 4. Check PR state if PR exists
    if (session.pr && scm) {
      try {
        // bd-att: Use batch query when available (~1 gh call instead of ~6).
        // If batch fails, fall back to individual calls rather than silently
        // preserving stale status.
        let usedBatch = false;
        if (scm.getBatchPRStatus) {
          try {
            const batch = await scm.getBatchPRStatus(session.pr);
            usedBatch = true;
            // bd-s4t.2: persist PR state so the session-reaper can detect zombies
            // without SCM access. Only update if state has changed.
            const prevPrState = session.pr?.state;
            if (batch.state !== prevPrState) {
              persistPrState({ session, state: batch.state, projectPath: project.path });
            }
            if (batch.state === PR_STATE.MERGED) {
              logAoAction({
                ts: new Date().toISOString(),
                session: session.id,
                action: "pr_merge",
                pr: session.pr?.number,
                repo: session.pr ? `${session.pr.owner}/${session.pr.repo}` : undefined,
                reason: "merged-transition",
              });
              return { status: "merged", agentDead };
            }
            if (batch.state === PR_STATE.CLOSED) return { status: "killed", agentDead };
            if (batch.ciStatus === CI_STATUS.FAILING) return { status: "ci_failed", agentDead };
            if (batch.reviewDecision === "changes_requested") return { status: "changes_requested", agentDead };
            if (batch.reviewDecision === "approved" || batch.reviewDecision === "none") {
              if (batch.mergeReadiness.mergeable) return { status: "mergeable", agentDead };
              if (!batch.mergeReadiness.noConflicts) return { status: "merge_conflicts", agentDead };
              if (batch.reviewDecision === "approved") return { status: "approved", agentDead };
            }
            if (batch.reviewDecision === "pending") return { status: "review_pending", agentDead };
            // bd-fisn: batch.reviewDecision is null when CR was DISMISSED (no outstanding request).
            // Fall through to individual calls below, which have the bd-fisn null→CR-reviews fix.
          } catch (err) {
            // bd-att: If batch failed due to a GitHub API rate limit (or network error),
            // DO NOT fall back. Rethrow so determineStatus exits immediately.
            // Failing back would cause an immediate 4-5x thundering herd of individual queries!
            if (isGhRateLimitError(err)) throw err;
            // Otherwise, batch failed (e.g. unsupported) — fall through to individual calls
          }
        }
        if (!usedBatch) {
          // Fallback: individual calls (no batch support or batch failed)
          const prState = await scm.getPRState(session.pr);
          // bd-s4t.2: persist PR state so the session-reaper can detect zombies
          const prevPrState = session.pr?.state;
          if (prState !== prevPrState) {
            persistPrState({ session, state: prState, projectPath: project.path });
          }
          if (prState === PR_STATE.MERGED) {
            logAoAction({
              ts: new Date().toISOString(),
              session: session.id,
              action: "pr_merge",
              pr: session.pr?.number,
              repo: session.pr ? `${session.pr.owner}/${session.pr.repo}` : undefined,
              reason: "merged-transition",
            });
            return { status: "merged", agentDead };
          }
          if (prState === PR_STATE.CLOSED) return { status: "killed", agentDead };

          const ciStatus = await scm.getCISummary(session.pr);
          if (ciStatus === CI_STATUS.FAILING) return { status: "ci_failed", agentDead };

          // Check reviews
          const reviewDecision = await scm.getReviewDecision(session.pr);
          // bd-n039 fix: Persist reviewDecision on session so the verdict gate (below in
          // checkSession) can read it without calling getReviewDecision again. Calling SCM
          // twice in the same poll causes the verdict gate to see a different decision than
          // determineStatus did (e.g. when the mock alternates return values).
          session.metadata["_reviewDecision"] = reviewDecision;
          if (reviewDecision === "changes_requested") return { status: "changes_requested", agentDead };
          if (reviewDecision === "approved" || reviewDecision === "none") {
            // bd-wg5: Skip getMergeability when CI is pending
            if (ciStatus === CI_STATUS.PENDING) {
              if (reviewDecision === "approved") return { status: "approved", agentDead };
              return { status: "pr_open", agentDead };
            }
            const mergeReady = await scm.getMergeability(session.pr);
            if (mergeReady.mergeable) return { status: "mergeable", agentDead };
            if (!mergeReady.noConflicts) return { status: "merge_conflicts", agentDead };
            if (reviewDecision === "approved") return { status: "approved", agentDead };
          }
          if (reviewDecision === "pending") return { status: "review_pending", agentDead };
          // bd-fisn: reviewDecision is null when CR has been DISMISSED (no outstanding review
          // request). This does NOT mean "no review" — it means "review was dismissed".
          // Check CR's reviews directly: if CR approved the current head SHA, treat as approved
          // so approved-and-green fires. SCM normalizes state to lowercase ("APPROVED"→"approved").
          // Restrict to current head commit via getPRHeadSha to avoid stale approvals.
          if (reviewDecision === null && scm) {
            try {
              const rawReviews = await scm.getReviews(session.pr);
              const reviews: Array<{ author?: string; state?: string; commit_id?: string }> = rawReviews;
              const crReviews = reviews.filter((r) => String(r.author ?? "").endsWith("coderabbitai[bot]"));
              // bd-rfr: SCM normalizes state to lowercase; use toLowerCase() for safety.
              let crApproved = crReviews.some((r) => (r.state ?? "").toLowerCase() === "approved");
              // Restrict to current head SHA if SCM supports it and at least one CR approval exists.
              if (crApproved && scm.getPRHeadSha) {
                const headSha = await scm.getPRHeadSha(session.pr);
                crApproved = crReviews.some(
                  (r) => (r.state ?? "").toLowerCase() === "approved" && r.commit_id === headSha,
                );
              }
              if (crApproved) {
                if (ciStatus === CI_STATUS.PENDING) return { status: "approved", agentDead };
                const mergeReady = await scm.getMergeability(session.pr);
                if (mergeReady.mergeable) return { status: "mergeable", agentDead };
                if (!mergeReady.noConflicts) return { status: "merge_conflicts", agentDead };
                return { status: "approved", agentDead };
              }
            } catch {
              // Fail open: if we can't fetch CR reviews, fall through to pr_open
            }
          }
        }

        // 4b. Post-PR stuck detection: agent has a PR open but is idle beyond
        // threshold. This catches the case where step 2's stuck check was
        // bypassed (getActivityState returned null) or the idle timestamp
        // wasn't available during step 2 but the session has been at pr_open
        // for a long time. Without this, sessions get stuck at "pr_open" forever.
        if (detectedIdleTimestamp && isIdleBeyondThreshold(session, detectedIdleTimestamp)) {
          return { status: "stuck", agentDead: false };
        }

        // Agent is dead but PR isn't in a merge-ready state.
        // bd-6jc: If SCM succeeded (scmFailureCount=0 from try block), return
        // "pr_open" immediately — SCM confirmed the PR won't auto-merge so there's
        // no reason to defer. The consecutive-failure threshold only applies when
        // SCM throws; the catch block below handles that case.
        if (agentDead) return { status: "pr_open", agentDead: true };

        return { status: "pr_open", agentDead: false };
      } catch {
        // bd-6jc: SCM threw — increment consecutive failure counter, persist, and
        // check threshold.  The finally only resets the counter on SCM success
        // (when scmErrorOccurred stays false); on catch, the counter accumulates.
        scmErrorOccurred = true;
        scmFailureCount++;
        session.metadata["scmFailureCount"] = String(scmFailureCount);
        const sessionsDir = getSessionsDir(config.configPath, project.path);
        updateMetadata(sessionsDir, session.id, { scmFailureCount: String(scmFailureCount) });

        if (agentDead && scmFailureCount >= SCM_FAILURE_THRESHOLD) {
          // Threshold reached — mark killConfirmed so checkSession's bd-kki skips
          // its secondary SCM absorption re-check (which could throw on a session
          // whose PR state is stale).  Update both in-memory and on-disk so the
          // guard activates within the same poll cycle.
          session.metadata["killConfirmed"] = "true";
          updateMetadata(sessionsDir, session.id, { killConfirmed: "true" });
          return { status: "killed", agentDead: true };
        }
      } finally {
        // bd-6jc: SCM succeeded (scmErrorOccurred=false) — reset counter if non-zero.
        // On catch (scmErrorOccurred=true): do NOT reset — counter should accumulate.
        if (!scmErrorOccurred && scmFailureCount !== 0) {
          session.metadata["scmFailureCount"] = "0"; // bd-6jc: sync in-memory so next poll reads 0
          const sessionsDir = getSessionsDir(config.configPath, project.path);
          updateMetadata(sessionsDir, session.id, { scmFailureCount: "0" });
        }
      }
    }

    // bd-ara + bd-6jc: If agent is dead and there is no PR or SCM, kill immediately —
    // there is nothing to wait for. The scmFailureCount guard was removed: counter
    // accumulation from detectPR errors is now reset by step-3's finally on any
    // successful detectPR call, so stale non-zero counts no longer block this path.
    if (agentDead && !(session.pr && scm)) return { status: "killed", agentDead: true };

    // 5. Post-all stuck detection: if we detected idle in step 2 but had no PR,
    // still check stuck threshold. This handles agents that finish without creating a PR.
    if (!agentDead && detectedIdleTimestamp && isIdleBeyondThreshold(session, detectedIdleTimestamp)) {
      return { status: "stuck", agentDead: false };
    }

    // bd-6jc fallback: if agentDead is true but no earlier return fired (e.g. SCM
    // threw below the failure threshold and neither guard fired), preserve the dead-agent
    // signal. Without this, the defaults below return agentDead=false, which causes
    // the caller to treat a dead session as alive and send spurious reactions.
    if (agentDead) return { status: "killed", agentDead: true };

    // 6. Default: if agent is active, it's working
    if (
      session.status === "spawning" ||
      session.status === SESSION_STATUS.STUCK ||
      session.status === SESSION_STATUS.NEEDS_INPUT
    ) {
      return { status: "working", agentDead: false };
    }
    return { status: session.status, agentDead: false };
  }

  /**
   * Shared skeptic-reaction helper — delegates to the module-level implementation.
   * Kept as a thin closure so existing call sites do not change.
   */
  async function triggerSkepticReaction(
    session: Session,
    lastSkepticSha: Map<string, string>,
    correlationId: string,
  ): Promise<boolean> {
    return triggerSkepticReactionImpl(
      session,
      lastSkepticSha,
      createCorrelationId(correlationId),
      config,
      registry,
      executeReaction,
    );
  }

  /** Execute a reaction for a session. */
  async function executeReaction(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
    session?: Session,
    correlationId?: string,
    isPeriodic = false,
    /** Treats undefined as dead — intended for retry dispatch paths where the caller's
     *  determineStatus result is unavailable. Backlog callers pass agentDead explicitly. */
    agentDead?: boolean,
  ): Promise<ReactionResult> {
    const reactionCorrelationId = correlationId ?? createCorrelationId("reaction");
    // bd-5nxx: resolve action type before computing maxRetries so the cap applies to
    // send-to-agent by default. Log the resolved action (not raw config) for observability.
    // bd-sbr.periodic-cap: periodic invocations (e.g., agent-stuck nudge retry) pass
    // isPeriodic=true so resolveReactionMaxRetries returns Infinity — periodic nudges
    // are bounded by their own cooldown timer, not the transition cap.
    const action = reactionConfig.action ?? "notify";
    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "lifecycle.reaction.start",
      outcome: "info",
      correlationId: reactionCorrelationId,
      projectId,
      sessionId,
      data: { reactionKey, action, auto: reactionConfig.auto, isPeriodic },
      level: "info",
    });

    const trackerKey = `${sessionId}:${reactionKey}`;
    let tracker = reactionTrackers.get(trackerKey);

    if (!tracker) {
      tracker = { attempts: 0, firstTriggered: new Date() };
      reactionTrackers.set(trackerKey, tracker);
    }

    // bd-n039: message-content hash dedup for send-to-agent.
    // bd-1178: also dedup by PR head SHA — if the SHA changed, send even if message content is
    // identical (e.g. new CI failure on same failure type). Only skip when BOTH message hash AND
    // SHA are unchanged.
    // cursor[bot] High (bd-n039): call buildReactionContext ONCE and reuse the result
    // in both the dedup check and the send block. Previously it was called twice
    // (once here for hashing, once in the send-to-agent case), which could produce
    // different output if SCM data changed between the two async calls.
    // FIX 3002442133 / cursor#3002258060: moved after send (was before send, blocking retry).
    let deduped = false;
    let dedupedMessageHash: string | undefined;
    let dedupContext: string | undefined;
    if (reactionConfig.action === "send-to-agent" && reactionConfig.message && session) {
      try {
        if (reactionConfig.message.includes("{{context}}")) {
          dedupContext = await buildReactionContext(reactionKey, session, projectId, config, registry);
        }
        const finalMessage = dedupContext !== undefined
          ? reactionConfig.message.replace(/\{\{context\}\}/g, () => dedupContext!)
          : reactionConfig.message;
        const messageHash = await hashMessageContent(finalMessage);

        // bd-1178: SHA-based dedup — skip only when BOTH message hash AND SHA are unchanged.
        // If SHA changed (new commit), send even if message content is the same.
        let currentSha: string | undefined;
        const project = config.projects[session.projectId];
        const scm = project?.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
        if (scm?.getPRHeadSha && session.pr) {
          try {
            currentSha = await scm.getPRHeadSha(session.pr);
          } catch {
            // SHA fetch failed — fall back to message-hash-only dedup
          }
        }
        const lastSha = getLastSentHeadSha(projectId, sessionId, reactionKey);
        const shaUnchanged = currentSha !== undefined
          ? (lastSha !== undefined && currentSha === lastSha)
          : true; // SHA unavailable — fall back to message-hash-only dedup
        const messageUnchanged = getLastSentMessageHash(projectId, sessionId, reactionKey) === messageHash;

        if (shaUnchanged && messageUnchanged) {
          deduped = true;
          observer.recordOperation({
            metric: "lifecycle_poll",
            operation: "lifecycle.reaction.deduped",
            outcome: "info",
            reason: "message_and_sha_unchanged",
            correlationId: reactionCorrelationId,
            projectId,
            sessionId,
            data: { reactionKey, messageHash, currentSha },
            level: "debug",
          });
          // Do NOT return — fall through to escalation checks (Fix 3002095878)
        } else {
          dedupedMessageHash = messageHash; // capture for post-send recording
        }
      } catch {
        // Hashing failed — proceed with send (don't block on dedup check)
      }
    }

    // Increment attempts only when we actually attempt the action (not on dedup skip)
    if (!deduped) tracker.attempts++;

    // Check if we should escalate.
    // FIX 3002095878: retry/attempt-based escalation is suppressed on deduped polls
    // (no actual send was made, so counting it toward attempts would be wrong).
    // Duration-based escalation still fires on deduped polls — if nothing has happened
    // for X time, escalate regardless of whether SHA changed.
    // bd-5nxx: send-to-agent is non-idempotent — cap retries at 3 by default to prevent
    // repeated delivery of the same message on every poll cycle for stable states.
    // bd-sbr.periodic-cap: periodic invocations (agent-stuck nudge retry) pass isPeriodic=true
    // so resolveReactionMaxRetries returns Infinity — periodic nudges are bounded by their
    // own cooldown timer (STUCK_RETRY_COOLDOWN_MS), not the transition cap.
    // Fork policy isolated in fork-reaction-retry-policy.ts to minimize upstream diff.
    const maxRetries = resolveReactionMaxRetries(action, reactionConfig, isPeriodic);
    const escalateAfter = reactionConfig.escalateAfter;
    let shouldEscalate = false;

    if (!deduped && tracker.attempts > maxRetries) {
      shouldEscalate = true;
    }

    // Duration-based escalation: fires on both sent and deduped polls.
    // This is intentional — a stalled session should escalate even when SHA is unchanged.
    if (typeof escalateAfter === "string") {
      const durationMs = parseDuration(escalateAfter);
      if (durationMs > 0 && Date.now() - tracker.firstTriggered.getTime() > durationMs) {
        shouldEscalate = true;
      }
    }

    if (!deduped && typeof escalateAfter === "number" && tracker.attempts > escalateAfter) {
      shouldEscalate = true;
    }

    if (shouldEscalate) {
      // Escalate to human
      const event = createEvent("reaction.escalated", {
        sessionId,
        projectId,
        message: `Reaction '${reactionKey}' escalated after ${tracker.attempts} attempts`,
        data: { reactionKey, attempts: tracker.attempts },
      });
      await notifyHuman(event, reactionConfig.priority ?? "urgent");
      return {
        reactionType: reactionKey,
        success: true,
        action: "escalated",
        escalated: true,
      };
    }

    // Execute the reaction action

    switch (action) {
      case "send-to-agent": {
        if (reactionConfig.message) {
          if (deduped) {
            return {
              reactionType: reactionKey,
              success: true,
              action: "send-to-agent",
              escalated: false,
            };
          }

          // dedupedMessageHash is pre-computed above using the same dedupContext
          // (called once at the top of this block — not here, fixing cursor[bot] High).
          try {
            // Inject context if message contains {{context}} placeholder.
            // dedupContext was built once at the top of this block — reuse it.
            const finalMessage = dedupContext !== undefined
              ? reactionConfig.message.replace(/\{\{context\}\}/g, () => dedupContext!)
              : reactionConfig.message;
            await sessionManager.send(sessionId, finalMessage);

            // Record message content hash and SHA after successful send.
            // FIX 3002442133 / cursor#3002258060: moved after send (was before send, blocking retry).
            // FIX cursor#3002173123: deduped guard above ensures no send on unchanged SHA.
            // bd-n039: uses message content hash (dedupedMessageHash).
            // bd-1178: also records PR head SHA for SHA-based dedup.
            // bd-n039 fix: keyed by projectId:sessionId:reactionKey for cross-project isolation.
            if (dedupedMessageHash) {
              try {
                setLastSentMessageHash(projectId, sessionId, reactionKey, dedupedMessageHash);
              } catch {
                // Non-fatal — hash tracking is best-effort
              }
            }
            // bd-1178: Record current SHA after successful send. Used by the dedup block above to
            // bypass message-hash dedup when the SHA changed (new commit on the PR).
            if (session) {
              try {
                const project = config.projects[session.projectId];
                const scm = project?.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
                if (scm?.getPRHeadSha && session.pr) {
                  const sha = await scm.getPRHeadSha(session.pr);
                  setLastSentHeadSha(projectId, sessionId, reactionKey, sha);
                }
              } catch {
                // Non-fatal — SHA tracking is best-effort
              }
            }

            return {
              reactionType: reactionKey,
              success: true,
              action: "send-to-agent",
              message: finalMessage,
              escalated: false,
            };
          } catch (sendErr) {
            // Send failed — allow retry on next poll cycle (don't escalate immediately)
            const sendErrMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
            observer.recordOperation({
              metric: "lifecycle_poll",
              operation: "lifecycle.reaction.send_failed",
              outcome: "failure",
              reason: sendErrMsg,
              correlationId: reactionCorrelationId,
              projectId,
              sessionId,
              data: { reactionKey, error: sendErrMsg },
              level: "warn",
            });
            return {
              reactionType: reactionKey,
              success: false,
              action: "send-to-agent",
              escalated: false,
            };
          }
        }
        break;
      }

      case "notify": {
        const event = createEvent("reaction.triggered", {
          sessionId,
          projectId,
          message: `Reaction '${reactionKey}' triggered notification`,
          data: { reactionKey },
        });
        await notifyHuman(event, reactionConfig.priority ?? "info");
        return {
          reactionType: reactionKey,
          success: true,
          action: "notify",
          escalated: false,
        };
      }

      case "request-merge": {
        return handleRequestMerge(sessionId, projectId, reactionKey, reactionConfig, {
          sessionManager, config, registry, notifyHuman, createEvent,
        });
      }

      case "auto-merge": {
        // Get fresh session state for SCM operations
        const freshSession = await sessionManager.get(sessionId);
        if (!freshSession) {
          return {
            reactionType: reactionKey,
            success: false,
            action,
            escalated: false,
          };
        }

        const project = config.projects[freshSession.projectId];
        if (!project) {
          return {
            reactionType: reactionKey,
            success: false,
            action,
            escalated: false,
          };
        }

        // Get SCM plugin
        const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
        if (!scm || !freshSession.pr) {
          // No SCM or no PR - just notify
          const event = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Reaction '${reactionKey}' triggered ${action} (no SCM/PR available)`,
            data: { reactionKey, action },
          });
          await notifyHuman(event, "action");
          return {
            reactionType: reactionKey,
            success: true,
            action,
            escalated: false,
          };
        }

        // verify6Green enforces the 6 core PR readiness gates (bd-mjtn):
        //   Gate 1: CI green
        //   Gate 2: No merge conflicts
        //   Gate 3: CodeRabbit APPROVED (actionable reviews only)
        //   Gate 4: Bugbot clean
        //   Gate 5: All inline comments resolved
        // Skeptic (Gate 6) and evidence-review (Gate 7) are per-project optional gates
        // controlled via project.mergeGate.skepticRequired / requiredChecks.
        // Pass project.mergeGate so the project's enabled setting is respected.
        const gateResult = await verify6Green(freshSession.pr, scm, project.mergeGate);
        if (!gateResult.passed) {
          const event = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Reaction '${reactionKey}' triggered ${action} but merge gate failed: ${gateResult.blockers.join(", ")}`,
            data: { reactionKey, action, blockers: gateResult.blockers, checks: gateResult.checks },
          });
          await notifyHuman(event, "action");
          return {
            reactionType: reactionKey,
            success: false,
            action,
            escalated: false,
            blockers: gateResult.blockers,
          };
        }

        // Auto-merge: execute merge. When autoMergeWaitSeconds is set, uses GitHub's
        // native --auto flag which waits for required status checks before completing the
        // merge — handles the race where PR transitions to mergeable while CI is still
        // completing (bd-5gl: workers post green but nothing merges).
        const mergeMethod =
          reactionConfig.mergeMethod ??
          project?.autoMerge?.mergeMethod ??
          config.autoMerge?.mergeMethod ??
          config.defaults.autoMerge?.mergeMethod ??
          "squash";
        const autoWaitSeconds =
          reactionConfig.autoMergeWaitSeconds ??
          project?.autoMerge?.waitSeconds ??
          config.autoMerge?.waitSeconds ??
          config.defaults.autoMerge?.waitSeconds ??
          0;
        const autoMergeEnabled =
          project?.autoMerge?.enabled ??
          config.autoMerge?.enabled ??
          config.defaults.autoMerge?.enabled ??
          true;
        if (autoMergeEnabled === false) {
          // Auto-merge is disabled — notify humans rather than silently skipping.
          const disabledEvent = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Reaction '${reactionKey}' skipped: auto-merge is disabled for this project`,
            data: { reactionKey, action },
          });
          await notifyHuman(disabledEvent, reactionConfig.priority ?? "warning");
          return {
            reactionType: reactionKey,
            success: false,
            action,
            escalated: true,
          };
        }
        try {
          await scm.mergePR(freshSession.pr, mergeMethod, autoWaitSeconds);

          const autoLabel = autoWaitSeconds > 0 ? " (--auto)" : "";
          const successEvent = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Reaction '${reactionKey}' completed ${action}${autoLabel} (${mergeMethod})`,
            data: { reactionKey, action, mergeMethod, autoWaitSeconds },
          });
          await notifyHuman(successEvent, "action");
          return {
            reactionType: reactionKey,
            success: true,
            action,
            escalated: false,
          };
        } catch (error) {
          const errorEvent = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Reaction '${reactionKey}' failed: ${error instanceof Error ? error.message : String(error)}`,
            data: { reactionKey, action, error: error instanceof Error ? error.message : String(error) },
          });
          await notifyHuman(errorEvent, "action");
          return {
            reactionType: reactionKey,
            success: false,
            action,
            escalated: false,
          };
        }
      }

      case "parallel-retry": {
        return handleParallelRetry(sessionId, projectId, reactionKey, reactionConfig, {
          sessionManager, config, registry, notifyHuman, createEvent,
        });
      }

      // bd-skp2: skeptic-review — implementation in fork-skeptic-extension
      case "skeptic-review": {
        if (!session) {
          return {
            reactionType: reactionKey,
            success: false,
            action: "skeptic-review",
            escalated: false,
          };
        }
        return runSkepticReviewReaction({
          session: session!,
          reactionKey,
          reactionConfig,
        });
      }

      // bd-upxh: claim-verification — deterministic check of skeptic-gate chain.
      // Fails-closed: ambiguous → INSUFFICIENT/FAIL — agents cannot claim 'working'.
      // Validates: precheck → trigger → poll → comment chain + SHA binding.
      case "claim-verification": {
        if (!session) {
          return {
            reactionType: reactionKey,
            success: false,
            action: "claim-verification",
            escalated: false,
          };
        }
        return runClaimVerification({
          session: session!,
          reactionKey,
          reactionConfig,
        });
      }

      // bd-rfr: Delegate to fork-reaction-rfr.ts — extracted for upstream isolation
      case "respawn-for-review": {
        return handleRespawnForReview(sessionId, projectId, reactionKey, reactionConfig, session!, agentDead, reactionCorrelationId, {
          sessionManager,
          config,
          registry,
          notifyHuman,
          createEvent,
          observer,
        });
      }

      default: {
        // Log warning for unknown reaction action types
        console.warn(`Unknown reaction action type: ${action}`);
        return {
          reactionType: reactionKey,
          success: false,
          action,
          escalated: false,
        };
      }
    }

    return {
      reactionType: reactionKey,
      success: false,
      action,
      escalated: false,
    };
  }

  function clearReactionTracker(sessionId: SessionId, reactionKey: string): void {
    reactionTrackers.delete(`${sessionId}:${reactionKey}`);
    // Note: clearLastSentHeadSha(sessionId) intentionally NOT called here.
    // FIX 3002095873 / cursor#3001685342: DedupHeadShaStore is a SEPARATE Map
    // (dedup-head-sha-store.ts) — SHA is NOT stored inside ReactionTracker.
    // Calling clearReactionTracker clears the tracker, NOT the dedup SHA.
    // Pruning: headShaStore entries for dead sessions are cleaned up in pollAll's
    // stale-session loop via pruneStaleSessionIds(currentSessionIds).
  }

  function getReactionConfigForSession(
    session: Session,
    reactionKey: string,
  ): ReactionConfig | null {
    const project = config.projects[session.projectId];
    const globalReaction = config.reactions[reactionKey];
    const projectReaction = project?.reactions?.[reactionKey];
    const reactionConfig = projectReaction
      ? { ...globalReaction, ...projectReaction }
      : globalReaction;
    if (!reactionConfig) return null;

    // Centralized auto-merge override: when autoMerge.enabled is true (global or per-project),
    // the approved-and-green reaction automatically merges instead of notifying.
    // Only override if the project did not explicitly configure this reaction
    // (projectReaction is absent) AND the global config did not declare it
    // (_hasExplicitGlobalReaction tracks raw user input before .partial() stripping).
    // Only transform when the action is still the default "notify" — explicit actions
    // like "request-merge" must not be overridden.
    const autoMergeEnabled =
      project?.autoMerge?.enabled ??
      config.autoMerge?.enabled ??
      config.defaults.autoMerge?.enabled ??
      true;
    if (
      autoMergeEnabled &&
      reactionKey === "approved-and-green" &&
      reactionConfig.action === "notify" &&
      !projectReaction &&
      !(config._hasExplicitGlobalReaction?.[reactionKey])
    ) {
      return { ...(reactionConfig as ReactionConfig), action: "auto-merge", auto: true };
    }

    return reactionConfig as ReactionConfig;
  }

  function updateSessionMetadata(session: Session, updates: Partial<Record<string, string>>): void {
    updateSessionMetadataHelper(session, updates, config);
  }

  /**
   * Persist GitHub PR state to the session metadata file + in-memory session object.
   * Owns its own best-effort try/catch and warn-level logging so callers stay
   * straight-line. Returns true on success, false if the metadata write failed.
   */
  function persistPrState({ session, state, projectPath }: {
    session: Session;
    state: PRState;
    projectPath: string;
  }): boolean {
    try {
      const sessionsDir = getSessionsDir(config.configPath, projectPath);
      // bd-s4t.2: write metadata first, then update in-memory — prevents using stale
      // in-memory state as the persistence retry gate (failure leaves in-memory unchanged)
      updateMetadata(sessionsDir, session.id, { prState: state });
      session.metadata["prState"] = state;
      if (session.pr) {
        session.pr.state = state;
      }
      return true;
    } catch (err) {
      console.warn(
        `[lifecycle-manager] persistPrState: failed to persist prState=${state} ` +
        `for session=${session.id} — best-effort, continuing: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }


  /** Send a notification to all configured notifiers. */
  async function notifyHuman(event: OrchestratorEvent, priority: EventPriority): Promise<void> {
    const eventWithPriority = { ...event, priority };
    const notifierNames = (config.notificationRouting[priority]?.length ?? 0) > 0
      ? config.notificationRouting[priority]!
      : config.defaults.notifiers;
    for (const name of notifierNames) {
      const notifier = registry.get<Notifier>("notifier", name);
      if (notifier) {
        try {
          await notifier.notify(eventWithPriority);
        } catch {
          // Notifier failed — not much we can do
        }
      }
    }
  }

  /** Poll a single session and handle state transitions. */
  async function checkSession(session: Session): Promise<void> {
    // Use tracked state if available; otherwise use the persisted metadata status
    // (not session.status, which list() may have already overwritten for dead runtimes).
    // This ensures transitions are detected after a lifecycle manager restart.
    const tracked = states.get(session.id);
    const oldStatus =
      tracked ?? ((session.metadata?.["status"] as SessionStatus | undefined) || session.status);
    const { status: determinedStatus, agentDead } = await determineStatus(session);
    let newStatus: SessionStatus = determinedStatus;
    let transitionReaction: { key: string; result: ReactionResult | null } | undefined;

    // bd-kki: check if PR is merged before recording "killed" status.
    // If the SCM call fails (transient error), the session stays in its previous
    // state and will be retried on the next poll — avoiding zombie tmux sessions
    // caused by a failed SCM check locking in a terminal "killed" state.
    // bd-6jc: skip this absorption when killConfirmed is already set — the kill
    // was confirmed by the consecutive-failure counter in determineStatus and should
    // not be re-checked (re-querying SCM could throw or absorb on a stale PR).
    if (
      newStatus === "killed" &&
      session.pr &&
      !session.metadata["killConfirmed"]
    ) {
      try {
        const merged = await isPRMerged(session, config, registry);
        if (merged) {
          newStatus = "merged";
          logAoAction({
            ts: new Date().toISOString(),
            session: session.id,
            action: "pr_merge",
            pr: session.pr?.number,
            repo: session.pr ? `${session.pr.owner}/${session.pr.repo}` : undefined,
            reason: "killed-merged-absorption",
          });
        }
      } catch {
        // SCM unreachable — same as the absorb path below: keep prior status and retry next poll
        newStatus = oldStatus;
      }
    }

    // Track current task for MCP mail heartbeat messaging — update when task changes,
    // delete when it clears or session exits so heartbeats never send stale work
    const task = typeof session.metadata?.["task"] === "string"
      ? session.metadata["task"]
      : undefined;
    if (task) {
      sessionCurrentTask.set(session.id, task);
    } else if (newStatus === "merged" || newStatus === "killed") {
      sessionCurrentTask.delete(session.id);
    }

    // MCP mail: send session-start when a session resumes from a terminal state
    // into active work. Uses tracked state (last seen) when available so the guard
    // fires exactly once per resume rather than on every poll.
    if (
      getMcpMailClientConfig() &&
      tracked !== undefined &&
      TERMINAL_STATUSES.has(oldStatus!) &&
      !TERMINAL_STATUSES.has(newStatus)
    ) {
      await sendMcpMailSessionStart(task).catch(() => {/* non-fatal */});
    }
    if (newStatus !== oldStatus) {
      const correlationId = createCorrelationId("lifecycle-transition");

      // bd-kki: when transitioning to killed and session has a PR, verify the PR is
      // actually merged before persisting the killed state — the runtime/activity check
      // in determineStatus may have fired before the SCM PR-state check.  If SCM is
      // unreachable, skip persisting so the next poll can retry.
      let effectiveStatus = newStatus;
      // mergedConfirmed is set by the SCM check below and reused in the terminal-block
      // belt-and-suspenders section to avoid a second getPRState() call.
      let mergedConfirmed = false;
      if (
        newStatus === "killed" &&
        session.pr &&
        !session.metadata["killConfirmed"]
      ) {
        const project = config.projects[session.projectId];
        const scm = project?.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
        if (scm) {
          try {
            const prState = await scm.getPRState(session.pr);
            mergedConfirmed = prState === PR_STATE.MERGED;
            if (prState === PR_STATE.OPEN) {
              // PR still open — agent died but PR is alive; skip persisting
              // killed so next poll can re-check PR state for auto-merge.
              effectiveStatus = oldStatus;
            }
            // PR is merged or closed — proceed with killed transition
          } catch {
            // SCM unreachable — skip persisting killed, retry next poll
            effectiveStatus = oldStatus;
          }
        }
      }

      // bd-5o1: when agent is dead and the transition would trigger a send-to-agent
      // reaction that can't be delivered, override to "killed" for terminal cleanup.
      // Without this, dead-agent sessions stay in non-terminal states (e.g.
      // "changes_requested") forever, getting polled every cycle with the reaction
      // skipped but never cleaned up.  SCM-only reactions (auto-merge, notify,
      // request-merge) don't require a live agent and proceed normally.
      // Extracted to fork-dead-agent.ts per CR (bd-5o1).
      const override = await applyDeadAgentOverride(agentDead, effectiveStatus, oldStatus, newStatus, session, {
        statusToEventType,
        eventToReactionKey,
        getReactionConfigForSession,
      });
      effectiveStatus = override.effectiveStatus;
      newStatus = override.newStatus;

      // Skip persisting if bd-kki check absorbed the killed transition — keep session
      // in oldStatus so the next poll can retry the SCM check.
      if (effectiveStatus !== oldStatus) {
        // State transition detected — reset stuck-worker idle counter since the
        // session made progress. (bd-stuck-probe)
        resetIdleCycles(session.id);
        states.set(session.id, effectiveStatus);
        updateSessionMetadata(session, { status: effectiveStatus });
      } else {
        // Preserve oldStatus so the next poll can re-evaluate the SCM check.
        // Bugbot bd-25aa4f11: storing newStatus ("killed") caused the next poll
        // to see oldStatus="killed" matching newStatus="killed", breaking retry.
        states.set(session.id, oldStatus);
        // CR (bd-xxx): still dispatch review backlog on absorbed polls so steady-state
        // PR sessions continue receiving comment notifications even when the killed
        // transition is absorbed and no status change is persisted.
        await maybeDispatchReviewBacklog(session, oldStatus, effectiveStatus, {
          config,
          registry,
          clearReactionTracker,
          getReactionConfigForSession,
          executeReaction,
          agentDead: true, // killed-status absorbed block: agent is confirmed dead
        }, undefined);
        return;
      }

      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.transition",
        outcome: "success",
        correlationId,
        projectId: session.projectId,
        sessionId: session.id,
        data: { oldStatus, newStatus },
        level: transitionLogLevel(newStatus),
      });

      // Reset allCompleteEmitted when any session becomes active again (bd-e4t)
      if (!TERMINAL_STATUSES.has(newStatus)) {
        allCompleteEmitted = false;
      }

      // Clear reaction trackers for the old status so retries reset on state changes
      const oldEventType = statusToEventType(undefined, oldStatus);
      if (oldEventType) {
        const oldReactionKey = eventToReactionKey(oldEventType);
        if (oldReactionKey) {
          clearReactionTracker(session.id, oldReactionKey);
        }
      }

      // Handle transition: notify humans and/or trigger reactions
      const eventType = statusToEventType(oldStatus, newStatus);

      // bd-skk2: emit worker.signals_completion when worker creates a PR.
      // Triggering only on pr_open avoids duplicate skeptic evaluations if a PR
      // later transitions to approved (or bounces back and forth between states).
      // Re-triggering on approved is unnecessary since the PR content hasn't changed.
      let completionReactionHandledNotify = false;
      if (newStatus === "pr_open") {
        // bd-lg7i: triggerSkepticReaction records SHA and fires claim-verification
        // on success. completionReactionHandledNotify feeds the pr.created notification
        // guard below — skip duplicate notification when skeptic reaction already fired.
        completionReactionHandledNotify = await triggerSkepticReaction(
          session,
          lastSkepticSha,
          "skeptic-trigger",
        );
      }

      // bd-jzan: fire skeptic immediately when CR approves on same SHA (no new push).
      // The SHA-change block above only triggers on currentSha !== previousSha.
      // When CR approves on the same commit (e.g. after review fixes), there is no SHA
      // change so skeptic waits up to 30 min for skeptic-cron. This block fires it now.
      // Dedup guard: if lastSkepticSha already has this SHA, skeptic already ran.
      // Additional guard: if a VERDICT comment already exists for this SHA, skip.
      if (newStatus === "approved" && oldStatus !== "approved" && session.pr) {
        const skepticProject = config.projects[session.projectId];
        const skepticScm = skepticProject?.scm
          ? registry.get<SCM>("scm", skepticProject.scm.plugin)
          : null;
        if (skepticScm?.getPRHeadSha && skepticScm?.getSkepticComments) {
          try {
            const currentSha = await skepticScm.getPRHeadSha(session.pr);
            if (currentSha) {
              const alreadyEvaluated = lastSkepticSha.get(session.id) === currentSha;
              // Also check: if a VERDICT comment already exists for this SHA, skip.
              // This covers the case where lastSkepticSha was cleared (restart) but
              // skeptic already ran and posted a VERDICT for this SHA.
              // bd-jzan CR fix: SHA must appear INSIDE the HTML comment (not any HTML comment).
              const existingComments = await skepticScm.getSkepticComments(session.pr);
              const shaPrefix = currentSha.slice(0, 7);
              const hasVerdictForSha = existingComments.some((c) => {
                if (!/VERDICT:/i.test(c.body)) return false;
                if (c.body.includes(currentSha)) return true;
                // Check if SHA prefix appears inside an HTML comment marker
                // e.g. <!-- skeptic-gate-trigger-abc1234 --> contains "abc1234"
                const htmlMatch = c.body.match(/<!--[^>]*-->/);
                return Boolean(htmlMatch && htmlMatch[0].includes(shaPrefix));
              });
              if (!alreadyEvaluated && !hasVerdictForSha) {
                observer.recordOperation({
                  metric: "lifecycle_poll",
                  operation: "lifecycle.skeptic_cr_approval_trigger",
                  outcome: "info",
                  correlationId: createCorrelationId("skeptic-cr-approval"),
                  projectId: session.projectId,
                  sessionId: session.id,
                  data: { currentSha: currentSha.slice(0, 7) },
                  level: "info",
                });
                // Uses shared helper: fires reaction, records SHA, then dispatches claim-verification.
                await triggerSkepticReaction(session, lastSkepticSha, "skeptic-cr-approval");
              }
            }
          } catch {
            // getPRHeadSha or getSkepticComments failed — skip this cycle
          }
        }
      }

      // bd-5o1: skip reactions for dead agents — ao send to a dead session wastes
      // resources and generates spurious escalation notifications. The PR state check
      // in determineStatus already handles bd-kki (preserves oldStatus for open PRs
      // when agent is dead), so dead agents that have open PRs stay in their prior
      // state and won't reach this block via a killed transition. This guard catches
      // other transitions (e.g. mergeable→something) for sessions where the agent died
      // between polls.
      if (eventType) {
        let reactionHandledNotify = completionReactionHandledNotify;
        const reactionKey = eventToReactionKey(eventType);

        if (reactionKey) {
          const reactionConfig = getReactionConfigForSession(session, reactionKey);

          if (reactionConfig && reactionConfig.action) {
            // bd-5o1: skip send-to-agent reactions for dead agents — ao send to a dead
            // session wastes resources and generates spurious escalation notifications.
            // All other reactions (auto-merge, notify, request-merge, parallel-retry,
            // skeptic-review) are SCM/API operations that don't require a live agent.
            const skipForDead = agentDead && reactionConfig.action === "send-to-agent";

            // bd-rfr: Gate changes-requested transition reaction on CR's latest verdict.
            // CR posts inline suggestions under COMMENTED (no formal verdict) before optionally
            // posting CHANGES_REQUESTED. Inline suggestions persist after dismissal.
            // Suppress the transition reaction when verdict is COMMENTED or DISMISSED — the backlog
            // path (which has the same gate) handles fresh CHANGES_REQUESTED alerts via fingerprint.
            // Default to true (allow reaction) so non-changes-requested reactions are unaffected.
            // Only set to false when verdict is explicitly COMMENTED or DISMISSED.
            let skipVerdictGate = true;
            try {
              if (reactionKey === "changes-requested" && session.pr) {
                // bd-n039 fix: Read the reviewDecision that was already computed and stored
                // by determineStatus — do NOT call getReviewDecision again (the SCM call would
                // consume the next call from an alternating mock, causing the verdict gate to
                // see a different decision than determineStatus did).
                const cachedDecision = session.metadata["_reviewDecision"];
                if (cachedDecision !== null && cachedDecision !== undefined) {
                  // CR verdict gate: block only on COMMENTED or DISMISSED.
                  // These states mean CR has posted inline suggestions but no formal CHANGES_REQUESTED.
                  // Allow all other states (null, CHANGES_REQUESTED, APPROVED, etc.) — fail open.
                  skipVerdictGate = cachedDecision !== "commented" && cachedDecision !== "dismissed";
                } else {
                  // Fallback for code paths that bypass determineStatus (e.g. direct executeReaction calls).
                  // In normal poll-cycle operation, cachedDecision is always set by determineStatus.
                  const verdictProject = config.projects[session.projectId];
                  const verdictScm = verdictProject?.scm
                    ? registry.get<SCM>("scm", verdictProject.scm.plugin)
                    : null;
                  if (verdictScm) {
                    const rawReviews = await verdictScm.getReviews(session.pr);
                    const reviews: Array<{ author?: string; state?: string }> = rawReviews;
                    const crReviews = reviews.filter((r) => String(r.author ?? "").endsWith("coderabbitai[bot]"));
                    const crVerdict = crReviews[crReviews.length - 1]?.state ?? null;
                    skipVerdictGate = crVerdict === null || (crVerdict !== "commented" && crVerdict !== "dismissed");
                  }
                }
              }
            } catch (verdictErr) {
              // Fail open: any error fetching CR verdict should not block the reaction.
              // bd-n039: explicitly set skipVerdictGate=true in catch — previously the variable
              // was undefined after a throw (inside if(verdictScm) before let declaration), which
              // caused the verdict gate to incorrectly block reactions.
              skipVerdictGate = true;
              console.warn(
                `[lifecycle-manager] verdict gate getReviews failed for session=${session.id}: ` +
                `${verdictErr instanceof Error ? verdictErr.message : String(verdictErr)} — allowing reaction`,
              );
            }

            // auto: false skips automated agent actions but still allows notifications
            if (
              (reactionConfig.auto !== false || reactionConfig.action === "notify") &&
              !skipForDead &&
              skipVerdictGate
            ) {
              // Reaction will execute
              const reactionResult = await executeReaction(
                session.id,
                session.projectId,
                reactionKey,
                reactionConfig,
                session,
                correlationId,
                agentDead,
              );
              transitionReaction = { key: reactionKey, result: reactionResult };
              // Seed stuck retry cooldown from the initial transition nudge (bd-sbr.2)
              if (reactionKey === "agent-stuck") {
                const key = `stuck-retry-${session.id}`;
                const now = Date.now();
                stuckRetryTimestamps.set(key, now);
                stuckEntryTimestamps.set(session.id, now);
              }
              observer.recordOperation({
                metric: "lifecycle_poll",
                operation: "lifecycle.reaction.result",
                outcome: reactionResult?.success ? "success" : "failure",
                correlationId,
                projectId: session.projectId,
                sessionId: session.id,
                data: {
                  reactionKey,
                  action: reactionResult?.action,
                  escalated: reactionResult?.escalated,
                  success: reactionResult?.success,
                  ...(reactionResult?.blockers && { blockers: reactionResult.blockers }),
                },
                level: reactionResult?.success ? "info" : "warn",
              });
              // Reaction is handling this event — suppress immediate human notification.
              // "send-to-agent" retries + escalates on its own; "notify"/"auto-merge"
              // already call notifyHuman internally. Notifying here would bypass the
              // delayed escalation behaviour configured via retries/escalateAfter.
              reactionHandledNotify = true;
            } else {
              observer.recordOperation({
                metric: "lifecycle_poll",
                operation: "lifecycle.reaction.skipped",
                outcome: "success",
                correlationId,
                projectId: session.projectId,
                sessionId: session.id,
                data: skipForDead
                  ? { reactionKey, reason: "agent_dead", auto: reactionConfig.auto, action: reactionConfig.action }
                  : { reactionKey, reason: "auto_disabled", auto: reactionConfig.auto, action: reactionConfig.action },
                level: "info",
              });
            }
          } else {
            observer.recordOperation({
              metric: "lifecycle_poll",
              operation: "lifecycle.reaction.skipped",
              outcome: "success",
              correlationId,
              projectId: session.projectId,
              sessionId: session.id,
              data: { reactionKey, reason: "no_action", hasConfig: !!reactionConfig, action: reactionConfig?.action },
              level: "info",
            });
          }
        } else {
          observer.recordOperation({
            metric: "lifecycle_poll",
            operation: "lifecycle.reaction.skipped",
            outcome: "success",
            correlationId,
            projectId: session.projectId,
            sessionId: session.id,
            data: { eventType, reason: "no_reaction_key" },
            level: "info",
          });
        }

        // For transitions not already notified by a reaction, notify humans.
        // All priorities (including "info") are routed through notificationRouting
        // so the config controls which notifiers receive each priority level.
        if (!reactionHandledNotify) {
          const priority = inferPriority(eventType);
          const event = createEvent(eventType, {
            sessionId: session.id,
            projectId: session.projectId,
            message: `${session.id}: ${oldStatus} → ${newStatus}`,
            data: { oldStatus, newStatus },
          });
          await notifyHuman(event, priority);
        }
      }

      await maybeDispatchReviewBacklog(session, oldStatus, effectiveStatus, {
        config,
        registry,
        clearReactionTracker,
        getReactionConfigForSession,
        executeReaction,
        agentDead,
      }, transitionReaction);

      // Session exit reconciliation (bd-uxs.6): validate commits and emit proof on terminal states
      if (TERMINAL_STATUSES.has(effectiveStatus) && !TERMINAL_STATUSES.has(oldStatus)) {
        await validateAndEmitExitProof(session, effectiveStatus, {
          config,
          registry,
          observer,
          notifyHuman,
          createEvent,
        });

        // Record outcome for strategy learning (bd-nig)
        // Guarded: disk errors must not break session lifecycle checks
        if (outcomeRecorder) {
          try {
            const success = effectiveStatus === "merged";
            outcomeRecorder.record({
              sessionId: session.id,
              projectId: session.projectId,
              trigger: session.metadata["trigger"] ?? "unknown",
              action: session.metadata["action"] ?? "unknown",
              strategy: session.metadata["strategy"],
              errorClass: session.metadata["errorClass"],
              success,
              durationMs: Date.now() - new Date(session.createdAt).getTime(),
              error: !success ? `Session ended with status: ${effectiveStatus}` : undefined,
              prNumber: session.pr?.number,
              recordedAt: new Date().toISOString(),
            });
          } catch (recordErr) {
            console.warn(
              `Failed to record outcome for session ${session.id}:`,
              recordErr instanceof Error ? recordErr.message : String(recordErr),
            );
          }
        }

        // bd-s4t.1 + bd-e4t + bd-kki: when a session reaches ANY terminal state,
        // proactively clean up runtime and worktree. Without this, dead sessions
        // leave orphaned worktrees that lock branches and block future spawns.
        // Orchestrator sessions are excluded: killing the orchestrator would clear
        // its rate-limit pause metadata, breaking the pause mechanism.
        if (TERMINAL_STATUSES.has(effectiveStatus) && !isOrchestratorSession(session)) {
          try {
            await sessionManager.kill(session.id);
            // Only log session_kill after successful kill — a false entry for a
            // failed kill would misrepresent session state in the audit trail.
            logAoAction({
              ts: new Date().toISOString(),
              session: session.id,
              action: "session_kill",
              pr: session.pr?.number,
              repo: session.pr ? `${session.pr.owner}/${session.pr.repo}` : undefined,
              reason: `terminal:${effectiveStatus}`,
            });
          } catch (killErr) {
            observer.recordOperation({
              metric: "lifecycle_poll",
              operation: "lifecycle.terminal_cleanup",
              outcome: "failure",
              correlationId: createCorrelationId("lifecycle-cleanup"),
              projectId: session.projectId,
              sessionId: session.id,
              data: { error: killErr instanceof Error ? killErr.message : String(killErr) },
              level: "warn",
            });
          }
        }

      }

      // bd-kki: belt-and-suspenders. When the first absorb check ran (non-terminal
      // oldStatus) and confirmed merged=true, mergedConfirmed is already set so no
      // second SCM call is needed.  When oldStatus was already terminal the absorb
      // check did not run — re-check SCM once and call kill() if merged.
      // Placed OUTSIDE the !TERMINAL_STATUSES.has(oldStatus) guard so it can fire
      // for terminal→killed transitions (e.g. errored→killed).
      if (effectiveStatus === "killed" && session.pr) {
        if (mergedConfirmed) {
          // Absorb check confirmed merged — kill using cached result
          await sessionManager.kill(session.id);
        } else if (TERMINAL_STATUSES.has(oldStatus)) {
          // Terminal→killed transition: re-check SCM once to catch merged PRs
          const project = config.projects[session.projectId];
          const scm = project?.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
          if (scm) {
            try {
              if ((await scm.getPRState(session.pr)) === PR_STATE.MERGED) {
                await sessionManager.kill(session.id);
              }
            } catch {
              // SCM unreachable — skip kill; next poll will retry if status changes
            }
          }
        }
      }

      // bd-kki: early isPRMerged can upgrade killed→merged while oldStatus is already
      // terminal (e.g. errored + missing workspace). The block above only runs exit proof +
      // kill when !TERMINAL_STATUSES.has(oldStatus), so merge cleanup would be skipped.
      if (
        effectiveStatus === "merged" &&
        TERMINAL_STATUSES.has(oldStatus) &&
        oldStatus !== "merged" &&
        !isOrchestratorSession(session)
      ) {
        try {
          await sessionManager.kill(session.id);
        } catch (killErr) {
          observer.recordOperation({
            metric: "lifecycle_poll",
            operation: "lifecycle.terminal_cleanup",
            outcome: "failure",
            correlationId: createCorrelationId("lifecycle-cleanup"),
            projectId: session.projectId,
            sessionId: session.id,
            data: { error: killErr instanceof Error ? killErr.message : String(killErr) },
            level: "warn",
          });
        }
      }
    } else {
      // No transition but track current state
      states.set(session.id, newStatus);

      // Shared project lookup for the blocks below (bd-nk7: hoisted so the
      // auto-merge retry block also has access when newStatus === "mergeable").
      const project = config.projects[session.projectId];

      // bd-qnj6: re-trigger skeptic evaluation when HEAD SHA changes on an
      // already-open PR. The pr_open transition fires skeptic once, but subsequent
      // pushes (GHA synchronize events) don't cause a status transition — the
      // session stays in its current state. Without this, GHA posts a trigger
      // comment, polls for VERDICT, and times out because lifecycle-manager never
      // re-fires skeptic.
      // bd-lg7i: also re-triggers for review_pending — determineStatus can hold a
      // session in review_pending after a synchronize event, which would also timeout.
      if (
        (
          newStatus === "pr_open" ||
          newStatus === "review_pending" ||
          newStatus === "changes_requested" ||
          newStatus === "approved" ||
          newStatus === "mergeable"
        ) &&
        session.pr
      ) {
        const scm = project?.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
        if (scm?.getPRHeadSha) {
          try {
            const currentSha = await scm.getPRHeadSha(session.pr);
            const previousSha = lastSkepticSha.get(session.id);
            if (currentSha && previousSha && currentSha !== previousSha) {
              // HEAD SHA changed — re-trigger skeptic evaluation
              const completionReactionKey = "worker-signals-completion";
              const completionReactionConfig = getReactionConfigForSession(session, completionReactionKey);
              if (completionReactionConfig?.action && completionReactionConfig.auto !== false) {
                observer.recordOperation({
                  metric: "lifecycle_poll",
                  operation: "lifecycle.skeptic_retrigger",
                  outcome: "info",
                  correlationId: createCorrelationId("skeptic-retrigger"),
                  projectId: session.projectId,
                  sessionId: session.id,
                  data: { previousSha: previousSha.slice(0, 7), currentSha: currentSha.slice(0, 7) },
                  level: "info",
                });
                // bd-lg7i: only mark the SHA handled when skeptic dispatch succeeded.
                // Setting lastSkepticSha unconditionally would suppress retries on failure.
                let reactionSuccess: boolean;
                try {
                  const result = await executeReaction(
                    session.id,
                    session.projectId,
                    completionReactionKey,
                    completionReactionConfig,
                    session,
                    createCorrelationId("skeptic-retrigger"),
                  );
                  reactionSuccess = Boolean(result?.success);
                } catch {
                  reactionSuccess = false;
                }
                if (reactionSuccess) {
                  lastSkepticSha.set(session.id, currentSha);

                  // bd-upxh: also dispatch claim-verification after SHA-change skeptic retest
                  const claimReactionKey = "claim-verification";
                  const claimReactionConfig = getReactionConfigForSession(session, claimReactionKey);
                  if (claimReactionConfig?.action && claimReactionConfig.auto !== false) {
                    try {
                      await executeReaction(
                        session.id,
                        session.projectId,
                        claimReactionKey,
                        claimReactionConfig,
                        session,
                        createCorrelationId("claim-verification-retrigger"),
                      );
                    } catch {
                      // Non-fatal
                    }
                  }
                }
              }
            } else if (currentSha && !previousSha) {
              // First time seeing this session's SHA in the no-transition path.
              // The pr_open transition may have already fired skeptic and recorded the SHA,
              // but if that dispatch failed (or the process restarted), lastSkepticSha is empty.
              // Trigger skeptic to cover the missed-initial-dispatch case; if skeptic already
              // ran for this SHA, the reaction's own dedup will handle it.
              const completionReactionKey2 = "worker-signals-completion";
              const completionReactionConfig2 = getReactionConfigForSession(session, completionReactionKey2);
              if (completionReactionConfig2?.action && completionReactionConfig2.auto !== false) {
                let success = false;
                try {
                  const r = await executeReaction(
                    session.id,
                    session.projectId,
                    completionReactionKey2,
                    completionReactionConfig2,
                    session,
                    createCorrelationId("skeptic-catchup"),
                  );
                  success = Boolean(r?.success);
                } catch {
                  // dispatch failed — don't record SHA so we retry next cycle
                }
                if (success) {
                  lastSkepticSha.set(session.id, currentSha);
                }
              } else {
                // No reaction configured — just record SHA to avoid re-checking
                lastSkepticSha.set(session.id, currentSha);
              }
            }
          } catch {
            // getPRHeadSha failed — skip retrigger this cycle
          }
        }
      }

      // bd-qqm: skeptic-advice — detect new skeptic FAIL comments and fire the reaction.
      // Works by comparing the highest comment ID seen in the current fetch against the
      // last known ID stored in lastSkepticCommentId. Fires on any session with a PR.
      // Uses dedup (SHA-based) via the standard executeReaction path so retries are capped.
      if (session.pr) {
        const project = config.projects[session.projectId];
        const scm = project?.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
        if (scm?.getSkepticComments) {
          const reactionKey = "skeptic-advice";
          const reactionConfig = getReactionConfigForSession(session, reactionKey);
          if (reactionConfig?.action && reactionConfig.auto !== false) {
            try {
              const skepticComments = await scm.getSkepticComments(session.pr);
              if (skepticComments.length > 0) {
                // Find the highest comment ID
                const latestId = Math.max(...skepticComments.map((c) => c.id));
                const previousId = lastSkepticCommentId.get(session.id);
                if (previousId === undefined || latestId > previousId) {
                  // New skeptic comment(s) detected — fire the reaction
                  const result = await executeReaction(
                    session.id,
                    session.projectId,
                    reactionKey,
                    reactionConfig,
                    session,
                    createCorrelationId("skeptic-advice-trigger"),
                  );
                  if (result?.success) {
                    lastSkepticCommentId.set(session.id, latestId);
                  }
                }
              } else {
                // No skeptic comments yet — record 0 so we detect the first one
                if (!lastSkepticCommentId.has(session.id)) {
                  lastSkepticCommentId.set(session.id, 0);
                }
              }
            } catch {
              // Non-fatal: skip this cycle
            }
          }
        }
      }

      // Retry auto-merge when status stays "mergeable" — the approved-and-green
      // reaction fires on transition but may fail (e.g., merge gate fails due to
      // GraphQL rate limit treating all comments as unresolved). Re-attempt on
      // subsequent polls so transient gate failures don't permanently block merge.
      // Cooldown: only retry once per 5 minutes to avoid notification spam and
      // reaction budget exhaustion (bd-ara CR feedback).
      // bd-5o1 cursor fix: do NOT skip retry for dead agents — bd-ara's intent was
      // that "auto-merge can fire for green PRs with exited agents". The retry handles
      // transient failures (network, rate limits). If the failure is persistent (branch
      // protection), the merge gate will fail again and the next-cycle notifyHuman call
      // will alert humans rather than retrying forever.
      if (newStatus === "mergeable") {
        const reactionKey = "approved-and-green";
        const reactionConfig = getReactionConfigForSession(session, reactionKey);
        if (
          reactionConfig?.action === "auto-merge" &&
          reactionConfig.auto !== false
        ) {
          const MERGE_RETRY_COOLDOWN_MS = 5 * 60_000;
          const lastAttemptKey = `merge-retry-${session.id}`;
          const now = Date.now();
          const lastAttempt = (mergeRetryTimestamps as Map<string, number>).get(lastAttemptKey) ?? 0;
          if (now - lastAttempt >= MERGE_RETRY_COOLDOWN_MS) {
            // Guard: skip merge retry if auto-merge is disabled at any config level.
            const autoMergeEnabled =
              project?.autoMerge?.enabled ??
              config.autoMerge?.enabled ??
              config.defaults.autoMerge?.enabled ??
              true;
            if (autoMergeEnabled === false) {
              const disabledEvent = createEvent("reaction.triggered", {
                sessionId: session.id,
                projectId: session.projectId,
                message: `Reaction '${reactionKey}' skipped: auto-merge is disabled for this project`,
                data: { reactionKey, action: "auto-merge" },
              });
              await notifyHuman(disabledEvent, reactionConfig.priority ?? "warning");
              return;
            }
            (mergeRetryTimestamps as Map<string, number>).set(lastAttemptKey, now);
            const result = await executeReaction(
              session.id,
              session.projectId,
              reactionKey,
              reactionConfig,
              session,
              undefined,
              false, // isPeriodic: not a periodic/agent-stuck retry path
              undefined, // agentDead: approved PR, agent is alive
            );
            if (result?.success) {
              transitionReaction = { key: reactionKey, result };
            }
          }
        }
      }

      // Retry agent-stuck nudge when status stays "stuck" — the agent-stuck reaction
      // fires on the working→stuck transition but only once. If the agent doesn't
      // respond (e.g., stuck ruminating), the session stays "stuck" forever with no
      // further nudges. Re-send on a cooldown matching the configured threshold so
      // persistent stuck sessions get periodic recovery attempts. (bd-sbr)
      //
      // Only retry custom project-level agent-stuck reactions (bd-sbr.1), not the
      // global default notify-human nudge — repeatedly notifying humans is disruptive.
      // Skip timestamps that pre-date the current stuck entry (bd-sbr.3) to avoid
      // a stale timestamp from a prior stuck period blocking retries on re-entry.
      if (newStatus === "stuck") {
        const project = config.projects[session.projectId];
        const isCustomReaction = !!project?.reactions?.["agent-stuck"];
        if (isCustomReaction) {
          const reactionKey = "agent-stuck";
          const reactionConfig = getReactionConfigForSession(session, reactionKey);
          if (reactionConfig?.action && reactionConfig.action !== "notify" && reactionConfig.auto !== false) {
            const thresholdMs =
              typeof reactionConfig.threshold === "string"
                ? parseDuration(reactionConfig.threshold)
                : 15 * 60_000;
            const STUCK_RETRY_COOLDOWN_MS = thresholdMs > 0 ? thresholdMs : 15 * 60_000;
            const lastAttemptKey = `stuck-retry-${session.id}`;
            const now = Date.now();
            let lastAttempt = stuckRetryTimestamps.get(lastAttemptKey) ?? 0;
            // Skip if timestamp predates current stuck entry (stale from prior stuck period)
            const stuckEntry = stuckEntryTimestamps.get(session.id) ?? 0;
            if (lastAttempt < stuckEntry) {
              // Timestamp is stale — clear it and treat as no prior attempt
              stuckRetryTimestamps.delete(lastAttemptKey);
              lastAttempt = 0;
            }
            if (now - lastAttempt >= STUCK_RETRY_COOLDOWN_MS) {
              stuckRetryTimestamps.set(lastAttemptKey, now);
              const result = await executeReaction(
                session.id,
                session.projectId,
                reactionKey,
                reactionConfig,
                session,
                undefined, // correlationId — periodic retry has no dedicated correlation
                true, // isPeriodic: agent-stuck nudge retry bounded by STUCK_RETRY_COOLDOWN_MS, not transition cap
                undefined, // agentDead
              );
              if (result?.success) {
                transitionReaction = { key: reactionKey, result };
              }
            }
          }
        }
      }

      // Stuck worker probe: after 3+ consecutive idle polls with no status change,
      // capture tmux pane content to detect exited/stuck agents. tmux has-session
      // returns true even when the agent CLI exited (bash shell stays alive), so
      // this deep pane inspection catches false-liveness. (bd-stuck-probe)
      if (
        !TERMINAL_STATUSES.has(newStatus) &&
        !isOrchestratorSession(session) &&
        session.runtimeHandle
      ) {
        try {
          const probeResult = await checkStuckWorker({
            sessionName: session.runtimeHandle.id,
            sessionId: session.id,
            hasNewPRs: false, // no status change ⇒ no new PRs this cycle
            capturePane: tmuxCapturePane,
            killSession: async (name: string) => {
              await tmuxKillSession(name);
              // Mark session as killed so next poll picks up the transition
              updateSessionMetadata(session, { status: "killed", killConfirmed: "stuck-probe" });
            },
            sendKeys: tmuxSendKeys,
          });
          if (probeResult.inspected && probeResult.verdict) {
            observer.recordOperation({
              metric: "lifecycle_poll",
              operation: "lifecycle.stuck_probe",
              outcome: probeResult.actionTaken ? "success" : "info",
              correlationId: createCorrelationId("stuck-probe"),
              projectId: session.projectId,
              sessionId: session.id,
              data: {
                action: probeResult.verdict.action,
                reason: probeResult.verdict.reason,
                idleCycles: probeResult.idleCycleCount,
              },
              level: probeResult.actionTaken ? "warn" : "info",
            });
          }
        } catch (probeErr) {
          observer.recordOperation({
            metric: "lifecycle_poll",
            operation: "lifecycle.stuck_probe",
            outcome: "failure",
            correlationId: createCorrelationId("stuck-probe"),
            projectId: session.projectId,
            sessionId: session.id,
            reason: probeErr instanceof Error ? probeErr.message : String(probeErr),
            level: "warn",
          });
        }
      }
    }

    await maybeDispatchReviewBacklog(session, oldStatus, newStatus, {
      config,
      registry,
      clearReactionTracker,
      getReactionConfigForSession,
      executeReaction,
      agentDead,
    }, transitionReaction);

    // MCP mail: notify when session becomes blocked waiting for human input (non-terminal state)
    // Fires on the transition INTO needs_input so the global inbox gets alerted promptly.
    if (
      newStatus === "needs_input" &&
      oldStatus !== "needs_input" &&
      getMcpMailClientConfig()
    ) {
      // Send session-start if this is the first time seeing this session (no prior tracked state)
      // so the inbox gets a coherent start→blocked lifecycle rather than orphan end messages.
      if (tracked === undefined) {
        await sendMcpMailSessionStart(task).catch(() => {/* non-fatal */});
      }
      const blockedTask = sessionCurrentTask.get(session.id);
      await sendMcpMailSessionEnd(blockedTask, "human input").catch(() => {/* non-fatal */});
    }

    // Session exit reconciliation (bd-uxs.6): validate commits and emit proof on terminal states
    if (TERMINAL_STATUSES.has(newStatus) && !TERMINAL_STATUSES.has(oldStatus)) {
      // MCP mail: send session-end to global inbox before exit proof
      if (getMcpMailClientConfig()) {
        const doneTask = sessionCurrentTask.get(session.id);
        await sendMcpMailSessionEnd(doneTask).catch(() => {/* non-fatal */});
        sessionCurrentTask.delete(session.id);
      }

      await validateAndEmitExitProof(session, newStatus, {
        config,
        registry,
        observer,
        notifyHuman,
        createEvent,
      });

      // Record outcome for strategy learning (bd-nig)
      // Guarded: disk errors must not break session lifecycle checks
      if (outcomeRecorder) {
        try {
          const success = newStatus === "merged";
          outcomeRecorder.record({
            sessionId: session.id,
            projectId: session.projectId,
            trigger: session.metadata["trigger"] ?? "unknown",
            action: session.metadata["action"] ?? "unknown",
            strategy: session.metadata["strategy"],
            errorClass: session.metadata["errorClass"],
            success,
            durationMs: Date.now() - new Date(session.createdAt).getTime(),
            error: !success ? `Session ended with status: ${newStatus}` : undefined,
            prNumber: session.pr?.number,
            recordedAt: new Date().toISOString(),
          });
        } catch (recordErr) {
          console.warn(
            `Failed to record outcome for session ${session.id}:`,
            recordErr instanceof Error ? recordErr.message : String(recordErr),
          );
        }
      }

      // bd-s4t.1 + bd-e4t: when a session reaches ANY terminal state (merged,
      // killed, etc.), proactively clean up runtime and worktree. Without this,
      // dead sessions leave orphaned worktrees that lock branches and block
      // future `ao spawn --claim-pr` calls (git refuses to checkout a branch
      // already checked out in another worktree). Placed after exit proof
      // validation and outcome recording so the worktree is still available
      // for commit validation in validateAndEmitExitProof.
      // Orchestrator sessions are excluded: killing the orchestrator would clear
      // its rate-limit pause metadata, breaking the pause mechanism.
      if (TERMINAL_STATUSES.has(newStatus) && !isOrchestratorSession(session)) {
        try {
          await sessionManager.kill(session.id);
          // On PR merge, immediately reap co-workers that have no PR and have
          // been idle for 5+ minutes — they finished their work and are waiting
          // for direction that will never come.
          // Fork companion (fork-lifecycle-postmerge.ts): project-scoped + idle-gated
          // so a merge in one project does not reap sessions from other projects,
          // and active sessions that are simply old are not killed prematurely.
          // Non-fatal: reap failures are warning-only so they never block session cleanup.
          if (newStatus === "merged") {
            // orch-s66: pass exit proof deps so reaped co-workers emit session.exited
            // notifications. Without this, Slack thread terminal updates are skipped for
            // co-workers cleaned up by the post-merge sweep.
            await reapPostMergeCoWorkers(session, sessionManager, observer, {
              config,
              registry,
              observer,
              notifyHuman,
              createEvent,
            });
          }
        } catch (killErr) {
          // kill() may fail if session is already partially cleaned up; reapPostMergeCoWorkers
          // may fail if the reaper is unreachable. Both are non-fatal — log and continue.
          observer.recordOperation({
            metric: "lifecycle_poll",
            operation: "lifecycle.terminal_cleanup",
            outcome: "failure",
            correlationId: createCorrelationId("lifecycle-cleanup"),
            projectId: session.projectId,
            sessionId: session.id,
            data: { error: killErr instanceof Error ? killErr.message : String(killErr) },
            level: "warn",
          });
        }
      }

    }
  }

  /** Run one polling cycle across all sessions. */
  async function pollAll(): Promise<void> {
    const correlationId = createCorrelationId("lifecycle-poll");
    const startedAt = Date.now();
    // Re-entrancy guard: skip if previous poll is still running
    if (polling) return;
    polling = true;

    try {
      const sessions = await sessionManager.list(scopedProjectId);

      const pausedProjects = new Map<string, Date>();
      for (const session of sessions) {
        if (!isOrchestratorSession(session)) continue;
        const until = parsePauseUntil(session.metadata[GLOBAL_PAUSE_UNTIL_KEY]);
        if (!until) continue;
        if (until.getTime() <= Date.now()) {
          // Only clear REASON if still set; UNTIL is intentionally preserved for the
          // grace-window check in detectAndApplyRateLimitPause (avoids repeated disk writes).
          const project = config.projects[session.projectId];
          if (project && session.metadata[GLOBAL_PAUSE_REASON_KEY]) {
            clearProjectPause(config.configPath, project);
          }
          continue;
        }
        pausedProjects.set(session.projectId, until);
      }

      // Track whether any sessions have been observed across all poll cycles.
      // list() only returns active (non-terminal) sessions, so when all sessions
      // reach a terminal state sessions.length drops to 0. We need this flag to
      // distinguish "never had sessions" (startup) from "all sessions completed".
      if (sessions.length > 0) {
        everHadSessions = true;
      }

      // Include sessions that are active OR whose status changed from what we last saw
      // (e.g., list() detected a dead runtime and marked it "killed" — we need to
      // process that transition even though the new status is terminal).
      // Do NOT pre-filter paused projects here: pause state may clear mid-cycle, and
      // excluded sessions can never be restored within the same poll tick.
      const sessionsToCheck = sessions.filter((s) => {
        // Skip terminal statuses only if we've already seen and processed this session.
        // If tracked is undefined (e.g., after lifecycle manager restart), allow it
        // through once so exit proof and outcome can be emitted (bd-e4t).
        if (TERMINAL_STATUSES.has(s.status)) {
          const tracked = states.get(s.id);
          return tracked === undefined || tracked !== s.status;
        }
        return true;
      });

      // bd-wse: Poll sessions sequentially instead of concurrently.
      // Concurrent polling (Promise.allSettled) fires N×4 GitHub API calls in parallel,
      // exhausting the 5000/hr GraphQL rate limit when many sessions exist.
      // Sequential checks run back-to-back within one poll cycle (no pacing between
      // sessions). With many sessions, the cycle can exceed the configured interval;
      // the re-entrancy guard above then skips overlapping ticks until the cycle finishes.
      for (const s of sessionsToCheck) {
        // Pre-refresh: reload pause state from disk at the top of each iteration so
        // this session sees pauses set OR cleared by orchestrators or earlier sessions
        // in the same cycle. This ensures a mid-cycle pause clear immediately unblocks
        // subsequent workers without waiting for the next poll tick.
        const project = config.projects[s.projectId];
        if (project) {
          const sessionsDir = getSessionsDir(config.configPath, project.path);
          const orchId = `${project.sessionPrefix}-orchestrator`;
          const raw = readMetadataRaw(sessionsDir, orchId);
          const until = raw ? parsePauseUntil(raw[GLOBAL_PAUSE_UNTIL_KEY]) : null;
          if (until && until.getTime() > Date.now()) {
            pausedProjects.set(s.projectId, until);
          } else {
            pausedProjects.delete(s.projectId);
          }
        }
        // Skip non-orchestrator sessions if project is currently paused.
        // Terminal sessions bypass so exit proof, outcome recording, and cleanup
        // are not delayed (bd-e4t).
        if (pausedProjects.has(s.projectId) && !isOrchestratorSession(s) && !TERMINAL_STATUSES.has(s.status)) {
          continue;
        }
        await checkSession(s).catch((err) => {
          const errorReason = err instanceof Error ? err.message : String(err);
          observer.recordOperation({
            metric: "lifecycle_poll",
            operation: "lifecycle.session.check",
            outcome: "failure",
            correlationId,
            projectId: s.projectId,
            sessionId: s.id,
            durationMs: 0,
            reason: errorReason,
            level: "error",
            data: { sessionId: s.id },
          });
        });
      }

      // Prune stale entries from states and reactionTrackers for sessions
      // that no longer appear in the session list (e.g., after kill/cleanup)
      const currentSessionIds = new Set(sessions.map((s) => s.id));
      for (const trackedId of states.keys()) {
        if (!currentSessionIds.has(trackedId)) {
          states.delete(trackedId);
        }
      }
      for (const trackerKey of reactionTrackers.keys()) {
        const sessionId = trackerKey.split(":")[0];
        if (sessionId && !currentSessionIds.has(sessionId)) {
          reactionTrackers.delete(trackerKey);
        }
      }
      // bd-1178: prune dedup SHA store entries for sessions no longer tracked.
      // CR 3002468214: pass currentSessionIds so pruning is scoped to this LM's sessions.
      if (scopedProjectId) {
        pruneStaleSessionIds(scopedProjectId, currentSessionIds);
      }
      for (const retryKey of mergeRetryTimestamps.keys()) {
        const sessionId = retryKey.replace("merge-retry-", "");
        if (!currentSessionIds.has(sessionId)) {
          mergeRetryTimestamps.delete(retryKey);
        }
      }
      for (const retryKey of stuckRetryTimestamps.keys()) {
        const sessionId = retryKey.replace("stuck-retry-", "");
        if (!currentSessionIds.has(sessionId)) {
          stuckRetryTimestamps.delete(retryKey);
        }
      }
      for (const sessionId of stuckEntryTimestamps.keys()) {
        if (!currentSessionIds.has(sessionId)) {
          stuckEntryTimestamps.delete(sessionId);
        }
      }
      // bd-lg7i: lastSkepticSha entries for dead sessions must be pruned to avoid
      // unbounded growth and stale SHA comparisons when a session ID is recycled.
      for (const sessionId of lastSkepticSha.keys()) {
        if (!currentSessionIds.has(sessionId)) {
          lastSkepticSha.delete(sessionId);
        }
      }
      // bd-qqm: also prune lastSkepticCommentId for dead sessions
      for (const sessionId of lastSkepticCommentId.keys()) {
        if (!currentSessionIds.has(sessionId)) {
          lastSkepticCommentId.delete(sessionId);
        }
      }

      const activeSessions = sessions.filter((s) => !TERMINAL_STATUSES.has(s.status));

      // backfillAllPRs: spawn sessions for open PRs that have no active session.
      // Replaces the old orchestrator-session-based PR discovery (bd-awq) with a
      // deterministic loop inside the lifecycle-worker itself.
      let backfillSpawned = false;
      if (scopedProjectId) {
        const project = config.projects[scopedProjectId];
        if (project?.backfillAllPRs) {
          backfillSpawned = await backfillUncoveredPRs(
            { registry, sessionManager, observer },
            { projectId: scopedProjectId, project, activeSessions, correlationId, worktreeDir: (config as { worktreeDir?: string }).worktreeDir },
          );
          // If we just spawned a session, skip all_complete — more work exists.
          if (backfillSpawned) {
            allCompleteEmitted = false;
          }
        }
      }

      // bd-skp2-cron: Local skeptic cron — evaluates open PRs using locally-available
      // LLM tools (Codex/Claude). Replaces the broken GHA-based execution where no
      // API keys exist. Throttled internally to run every 10 minutes.
      // Fire-and-forget so a long-running LLM evaluation does not block the poll loop.
      if (scopedProjectId) {
        const skepticProject = config.projects[scopedProjectId];
        if (skepticProject?.backfillAllPRs) {
          void runLocalSkepticCron(
            { registry, sessionManager, observer },
            { projectId: scopedProjectId, project: skepticProject, activeSessions, correlationId },
          ).catch(skepticCronErr => {
            console.error(
              `[skeptic-cron] failed: ${skepticCronErr instanceof Error ? skepticCronErr.message : String(skepticCronErr)}`,
            );
          });
        }
      }

      // bd-bsu: Task queue drainer — spawns sessions for queued beads up to maxConcurrent.
      // Runs independently of backfillAllPRs; both can co-exist.
      if (scopedProjectId) {
        const project = config.projects[scopedProjectId];
        if (project?.taskQueue?.enabled) {
          const tqSpawned = await drainTaskQueue(
            { registry, sessionManager, observer },
            { projectId: scopedProjectId, project, configPath: config.configPath ?? "", activeSessions, correlationId },
          );
          if (tqSpawned > 0) {
            allCompleteEmitted = false;
          }
        }
      }

      // bd-jo6: tmux orphan sweep — runs every SWEEP_INTERVAL_MS to prevent tmux
      // session accumulation. Sessions with tmux names matching the AO pattern
      // {12-hex-hash}-{prefix}-{num} (where prefix ∈ project session prefixes)
      // that exist in tmux but have no AO DB record and are idle >orphanIdleThresholdMs
      // are killed. This unblocks the spawn gate (>15 sessions threshold).
      const nowMs = Date.now();
      if (nowMs - lastSweepTime >= SWEEP_INTERVAL_MS) {
        lastSweepTime = nowMs;
        try {
          // Collect all unique session prefixes from configured projects so the
          // sweeper can identify orphaned sessions regardless of which project they belong to
          const projectPrefixes = new Set(
            Object.values(config.projects)
              .map((p) => p.sessionPrefix)
              .filter(Boolean),
          );
          const sweepConfig = {
            ...DEFAULT_TMUX_SWEEPER_CONFIG,
            aoSessionPrefixes: projectPrefixes.size > 0 ? projectPrefixes : DEFAULT_TMUX_SWEEPER_CONFIG.aoSessionPrefixes,
          };
          const sweepResult = await sweepOrphanTmuxSessions(sweepConfig, { sessionManager });
          if (sweepResult.killed.length > 0) {
            console.log(
              `[tmux-sweeper] killed ${sweepResult.killed.length} orphan tmux session(s): ${sweepResult.killed.map((s) => s.tmuxName).join(", ")}`,
            );
          }
          if (sweepResult.errors.length > 0) {
            console.warn(
              `[tmux-sweeper] errors: ${sweepResult.errors.map((e) => `${e.tmuxName}: ${e.error}`).join("; ")}`,
            );
          }
        } catch (sweepErr) {
          // Sweep failures must not break the main poll cycle
          console.error(
            `[tmux-sweeper] sweep failed: ${sweepErr instanceof Error ? sweepErr.message : String(sweepErr)}`,
          );
        }
      }

      // Check if all sessions are complete (trigger reaction only once).
      // Use everHadSessions to avoid spurious all_complete on startup when no
      // sessions have ever existed. Since list() filters out terminal sessions,
      // sessions.length === 0 after all work is done — everHadSessions guards
      // against the empty-at-startup case.
      // Skip when backfillSpawned is true: activeSessions is stale (computed
      // before the spawn) and would incorrectly trigger all_complete.
      if (!backfillSpawned && everHadSessions && activeSessions.length === 0 && !allCompleteEmitted) {
        allCompleteEmitted = true;

        // Execute all-complete reaction if configured
        const reactionKey = eventToReactionKey("summary.all_complete");
        if (reactionKey) {
          const reactionConfig = config.reactions[reactionKey];
          if (reactionConfig && reactionConfig.action) {
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              await executeReaction(
                "system",
                "all",
                reactionKey,
                reactionConfig as ReactionConfig,
                undefined,
              );
            }
          }
        }
      }
      // MCP mail: send periodic worker heartbeat listing active sessions
      if (getMcpMailClientConfig()) {
        const activeTasks = Array.from(sessionCurrentTask.values()).filter(Boolean);
        const heartbeatBody = activeTasks.length > 0
          ? `Active sessions (${activeTasks.length}): ${activeTasks.join("; ")}`
          : "No active sessions";
        await sendMcpMailHeartbeat(heartbeatBody).catch(() => {/* non-fatal */});
      }

      if (scopedProjectId) {
        observer.recordOperation({
          metric: "lifecycle_poll",
          operation: "lifecycle.poll",
          outcome: "success",
          correlationId,
          projectId: scopedProjectId,
          durationMs: Date.now() - startedAt,
          data: { sessionCount: sessions.length, activeSessionCount: activeSessions.length },
          level: "info",
        });
        observer.setHealth({
          surface: "lifecycle.worker",
          status: "ok",
          projectId: scopedProjectId,
          correlationId,
          details: {
            projectId: scopedProjectId,
            sessionCount: sessions.length,
            activeSessionCount: activeSessions.length,
          },
        });
      }
    } catch (err) {
      const errorReason = err instanceof Error ? err.message : String(err);
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.poll",
        outcome: "failure",
        correlationId,
        projectId: scopedProjectId,
        durationMs: Date.now() - startedAt,
        reason: errorReason,
        level: "error",
      });
      observer.setHealth({
        surface: "lifecycle.worker",
        status: "error",
        projectId: scopedProjectId,
        correlationId,
        reason: errorReason,
        details: scopedProjectId ? { projectId: scopedProjectId } : { projectScope: "all" },
      });
    } finally {
      polling = false;
    }
  }

  return {
    start(intervalMs = 30_000): void {
      if (pollTimer) return; // Already running
      pollTimer = setInterval(() => void pollAll(), intervalMs);
      // Start MCP mail inbox polling (separate 5-min interval)
      if (getMcpMailClientConfig()) {
        startInboxPolling();
      }
      // Start productivity checking (separate 15-min interval)
      startProductivityChecking();
      // Run immediately on start
      void pollAll();
    },

    stop(): void {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (inboxPollTimer) {
        clearInterval(inboxPollTimer);
        inboxPollTimer = null;
      }
      if (productivityTimer) {
        clearInterval(productivityTimer);
        productivityTimer = null;
      }
    },

    getStates(): Map<SessionId, SessionStatus> {
      return new Map(states);
    },

    async check(sessionId: SessionId): Promise<void> {
      const session = await sessionManager.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      await checkSession(session);
    },

    // Exposed for unit testing — allows direct invocation of executeReaction to test
    // the retry cap without depending on REVIEW_BACKLOG_INTERVAL throttle timing.
    _testing: {
      executeReaction,
      getReactionConfigForSession,
    },
  } as LifecycleManager & { _testing: { executeReaction: typeof executeReaction; getReactionConfigForSession: typeof getReactionConfigForSession } };
}