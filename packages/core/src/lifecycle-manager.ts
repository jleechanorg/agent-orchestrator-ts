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
  type ProjectConfig as _ProjectConfig,
  type MergeGateConfig,
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
import { buildReactionContext } from "./reaction-context.js";
import { validateAndEmitExitProof } from "./session-exit-proof.js";
import { handleRequestMerge, handleParallelRetry } from "./fork-reaction-handlers.js";
import { maybeDispatchReviewBacklog } from "./review-backlog.js";
import { updateSessionMetadataHelper } from "./fork-utils.js";
import { checkMergeGate } from "./merge-gate.js";
import { GLOBAL_PAUSE_UNTIL_KEY, GLOBAL_PAUSE_REASON_KEY, parsePauseUntil } from "./global-pause.js";
import { isGhRateLimitError } from "./gh-rate-limit.js";

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
}

/** Track attempt counts for reactions per session. */
interface ReactionTracker {
  attempts: number;
  firstTriggered: Date;
}

/** Create a LifecycleManager instance. */
export function createLifecycleManager(deps: LifecycleManagerDeps): LifecycleManager {
  const { config, registry, sessionManager, projectId: scopedProjectId, outcomeRecorder } = deps;
  const observer = createProjectObserver(config, "lifecycle-manager");

  const states = new Map<SessionId, SessionStatus>();
  const reactionTrackers = new Map<string, ReactionTracker>(); // "sessionId:reactionKey"
  const mergeRetryTimestamps = new Map<string, number>(); // "merge-retry-{sessionId}" → last attempt epoch
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false; // re-entrancy guard
  let allCompleteEmitted = false; // guard against repeated all_complete
  let everHadSessions = false; // tracks whether any sessions have ever been observed

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
  async function determineStatus(session: Session): Promise<SessionStatus> {
    // If workspace was deleted (e.g., worktree cleaned up), session is dead
    if (session.workspacePath && !existsSync(session.workspacePath)) {
      return "killed";
    }

    const project = config.projects[session.projectId];
    if (!project) return session.status;

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

    // 1. Check if runtime is alive
    if (session.runtimeHandle && runtime) {
      const alive = await runtime.isAlive(session.runtimeHandle).catch(() => true);
      if (!alive) {
        // Don't return "killed" yet — if the session has a PR (or might have
        // one discoverable via branch-based auto-detect in step 3), check PR
        // state first so auto-merge can fire for green PRs with exited agents.
        if (!scm) return "killed";
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
          if (activityState.state === "waiting_input") return "needs_input";
          if (activityState.state === "exited") {
            // Don't return "killed" yet — defer to step 3 (branch-based PR
            // auto-detect) and step 4 (PR state checks) before giving up.
            if (!scm) return "killed";
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
            if (activity === "waiting_input") return "needs_input";

            const processAlive = await agent.isProcessRunning(session.runtimeHandle);
            if (!processAlive) {
              if (!scm) return "killed";
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
          return session.status;
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
        // SCM detection failed — will retry next poll
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
            if (batch.state === PR_STATE.MERGED) return "merged";
            if (batch.state === PR_STATE.CLOSED) return "killed";
            if (batch.ciStatus === CI_STATUS.FAILING) return "ci_failed";
            if (batch.reviewDecision === "changes_requested") return "changes_requested";
            if (batch.reviewDecision === "approved" || batch.reviewDecision === "none") {
              if (batch.mergeReadiness.mergeable) return "mergeable";
              if (!batch.mergeReadiness.noConflicts) return "merge_conflicts";
              if (batch.reviewDecision === "approved") return "approved";
            }
            if (batch.reviewDecision === "pending") return "review_pending";
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
          if (prState === PR_STATE.MERGED) return "merged";
          if (prState === PR_STATE.CLOSED) return "killed";

          const ciStatus = await scm.getCISummary(session.pr);
          if (ciStatus === CI_STATUS.FAILING) return "ci_failed";

          // Check reviews
          const reviewDecision = await scm.getReviewDecision(session.pr);
          if (reviewDecision === "changes_requested") return "changes_requested";
          if (reviewDecision === "approved" || reviewDecision === "none") {
            // bd-wg5: Skip getMergeability when CI is pending
            if (ciStatus === CI_STATUS.PENDING) {
              if (reviewDecision === "approved") return "approved";
              return "pr_open";
            }
            const mergeReady = await scm.getMergeability(session.pr);
            if (mergeReady.mergeable) return "mergeable";
            if (!mergeReady.noConflicts) return "merge_conflicts";
            if (reviewDecision === "approved") return "approved";
          }
          if (reviewDecision === "pending") return "review_pending";
        }

        // 4b. Post-PR stuck detection: agent has a PR open but is idle beyond
        // threshold. This catches the case where step 2's stuck check was
        // bypassed (getActivityState returned null) or the idle timestamp
        // wasn't available during step 2 but the session has been at pr_open
        // for a long time. Without this, sessions get stuck at "pr_open" forever.
        if (detectedIdleTimestamp && isIdleBeyondThreshold(session, detectedIdleTimestamp)) {
          return "stuck";
        }

        // Agent is dead but PR isn't in a merge-ready state — kill the session
        if (agentDead) return "killed";

        return "pr_open";
      } catch {
        // SCM check failed — keep current status so next poll can retry.
        // Don't kill dead-agent sessions on transient SCM failures; they
        // may still have a mergeable PR once the SCM recovers.
      }
    }

    // bd-ara: If agent is dead but we had no PR branch to check, kill
    if (agentDead) return "killed";

    // 5. Post-all stuck detection: if we detected idle in step 2 but had no PR,
    // still check stuck threshold. This handles agents that finish without creating a PR.
    if (detectedIdleTimestamp && isIdleBeyondThreshold(session, detectedIdleTimestamp)) {
      return "stuck";
    }

    // 6. Default: if agent is active, it's working
    if (
      session.status === "spawning" ||
      session.status === SESSION_STATUS.STUCK ||
      session.status === SESSION_STATUS.NEEDS_INPUT
    ) {
      return "working";
    }
    return session.status;
  }

  /** Execute a reaction for a session. */
  async function executeReaction(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
    session?: Session,
  ): Promise<ReactionResult> {
    const trackerKey = `${sessionId}:${reactionKey}`;
    let tracker = reactionTrackers.get(trackerKey);

    if (!tracker) {
      tracker = { attempts: 0, firstTriggered: new Date() };
      reactionTrackers.set(trackerKey, tracker);
    }

    // Increment attempts before checking escalation
    tracker.attempts++;

    // Check if we should escalate
    const maxRetries = reactionConfig.retries ?? Infinity;
    const escalateAfter = reactionConfig.escalateAfter;
    let shouldEscalate = false;

    if (tracker.attempts > maxRetries) {
      shouldEscalate = true;
    }

    if (typeof escalateAfter === "string") {
      const durationMs = parseDuration(escalateAfter);
      if (durationMs > 0 && Date.now() - tracker.firstTriggered.getTime() > durationMs) {
        shouldEscalate = true;
      }
    }

    if (typeof escalateAfter === "number" && tracker.attempts > escalateAfter) {
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
    const action = reactionConfig.action ?? "notify";

    switch (action) {
      case "send-to-agent": {
        if (reactionConfig.message) {
          try {
            // Inject context if message contains {{context}} placeholder
            let finalMessage = reactionConfig.message;
            if (session && reactionConfig.message.includes("{{context}}")) {
              const context = await buildReactionContext(reactionKey, session, projectId, config, registry);
              finalMessage = reactionConfig.message.replace(/\{\{context\}\}/g, () => context);
            }
            await sessionManager.send(sessionId, finalMessage);

            return {
              reactionType: reactionKey,
              success: true,
              action: "send-to-agent",
              message: finalMessage,
              escalated: false,
            };
          } catch {
            // Send failed — allow retry on next poll cycle (don't escalate immediately)
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

        // Build MergeGateConfig with sensible defaults: enabled: true, all conditions required
        const mergeGateConfig: MergeGateConfig = {
          enabled: true,
          requiredChecks: ["evidence-review"],
          ...project.mergeGate,
        };

        // Check all merge gate conditions before attempting auto-merge
        const gateResult = await checkMergeGate(freshSession.pr, mergeGateConfig, scm);
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
          };
        }

        // Auto-merge: execute merge immediately
        const mergeMethod = reactionConfig.mergeMethod ?? "squash";
        try {
          await scm.mergePR(freshSession.pr, mergeMethod);

          const successEvent = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Reaction '${reactionKey}' completed ${action} (${mergeMethod})`,
            data: { reactionKey, action, mergeMethod },
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
    return reactionConfig ? (reactionConfig as ReactionConfig) : null;
  }

  function updateSessionMetadata(session: Session, updates: Partial<Record<string, string>>): void {
    updateSessionMetadataHelper(session, updates, config);
  }


  /** Send a notification to all configured notifiers. */
  async function notifyHuman(event: OrchestratorEvent, priority: EventPriority): Promise<void> {
    const eventWithPriority = { ...event, priority };
    const notifierNames = config.notificationRouting[priority] ?? config.defaults.notifiers;

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
    const newStatus = await determineStatus(session);
    let transitionReaction: { key: string; result: ReactionResult | null } | undefined;

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
        TERMINAL_STATUSES.has(oldStatus) === false &&
        session.pr
      ) {
        const project = config.projects[session.projectId];
        const scm = project?.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
        if (scm) {
          try {
            const prState = await scm.getPRState(session.pr);
            mergedConfirmed = prState === PR_STATE.MERGED;
            if (!mergedConfirmed) {
              // PR is not merged — skip persisting killed, retry next poll
              effectiveStatus = oldStatus;
            }
          } catch {
            // SCM unreachable — skip persisting killed, retry next poll
            effectiveStatus = oldStatus;
          }
        }
      }

      // Skip persisting if bd-kki check absorbed the killed transition — keep session
      // in oldStatus so the next poll can retry the SCM check.
      if (effectiveStatus !== oldStatus) {
        // State transition detected
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
        await maybeDispatchReviewBacklog(session, oldStatus, newStatus, {
          config,
          registry,
          clearReactionTracker,
          getReactionConfigForSession,
          executeReaction,
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
      if (eventType) {
        let reactionHandledNotify = false;
        const reactionKey = eventToReactionKey(eventType);

        if (reactionKey) {
          const reactionConfig = getReactionConfigForSession(session, reactionKey);

          if (reactionConfig && reactionConfig.action) {
            // auto: false skips automated agent actions but still allows notifications
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              const reactionResult = await executeReaction(
                session.id,
                session.projectId,
                reactionKey,
                reactionConfig,
                session,
              );
              transitionReaction = { key: reactionKey, result: reactionResult };
              // Reaction is handling this event — suppress immediate human notification.
              // "send-to-agent" retries + escalates on its own; "notify"/"auto-merge"
              // already call notifyHuman internally. Notifying here would bypass the
              // delayed escalation behaviour configured via retries/escalateAfter.
              reactionHandledNotify = true;
            }
          }
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

        // bd-kki: belt-and-suspenders. When the first absorb check ran (non-terminal
        // oldStatus) and confirmed merged=true, mergedConfirmed is already set so no
        // second SCM call is needed.  When oldStatus was already terminal the absorb
        // check did not run — re-check SCM once and call kill() if merged.
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
      }
    } else {
      // No transition but track current state
      states.set(session.id, newStatus);

      // Retry auto-merge when status stays "mergeable" — the approved-and-green
      // reaction fires on transition but may fail (e.g., merge gate fails due to
      // GraphQL rate limit treating all comments as unresolved). Re-attempt on
      // subsequent polls so transient gate failures don't permanently block merge.
      // Cooldown: only retry once per 5 minutes to avoid notification spam and
      // reaction budget exhaustion (bd-ara CR feedback).
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
            (mergeRetryTimestamps as Map<string, number>).set(lastAttemptKey, now);
            const result = await executeReaction(
              session.id,
              session.projectId,
              reactionKey,
              reactionConfig,
              session,
            );
            if (result?.success) {
              transitionReaction = { key: reactionKey, result };
            }
          }
        }
      }
    }

    await maybeDispatchReviewBacklog(session, oldStatus, newStatus, {
      config,
      registry,
      clearReactionTracker,
      getReactionConfigForSession,
      executeReaction,
    }, transitionReaction);

    // Session exit reconciliation (bd-uxs.6): validate commits and emit proof on terminal states
    if (TERMINAL_STATUSES.has(newStatus) && !TERMINAL_STATUSES.has(oldStatus)) {
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
        } catch (killErr) {
          // kill() may fail if session is already partially cleaned up.
          // Log so operators can see cleanup failures rather than silently losing them.
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
      for (const retryKey of mergeRetryTimestamps.keys()) {
        const sessionId = retryKey.replace("merge-retry-", "");
        if (!currentSessionIds.has(sessionId)) {
          mergeRetryTimestamps.delete(retryKey);
        }
      }

      // bd-awq: PR poller disabled — the orchestrator session handles PR discovery
      // and worker spawning via `ao spawn --claim-pr`. The poller was spawning
      // generic sessions without PR claims, causing duplicates and sessions on
      // wrong branches. See bd-b02 for the full analysis.
      const activeSessions = sessions.filter((s) => !TERMINAL_STATUSES.has(s.status));

      // Check if all sessions are complete (trigger reaction only once).
      // Use everHadSessions to avoid spurious all_complete on startup when no
      // sessions have ever existed. Since list() filters out terminal sessions,
      // sessions.length === 0 after all work is done — everHadSessions guards
      // against the empty-at-startup case.
      if (everHadSessions && activeSessions.length === 0 && !allCompleteEmitted) {
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
      // Run immediately on start
      void pollAll();
    },

    stop(): void {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
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
  };
}
