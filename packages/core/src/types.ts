import type { ObservabilityLevel } from "./observability.js";

/**
 * Agent Orchestrator — Core Type Definitions
 *
 * This file defines ALL interfaces and types that the system uses.
 * Every plugin, CLI command, and web API route builds against these.
 *
 * Architecture: 8 plugin slots + core services
 *   1. Runtime    — where sessions execute (tmux, docker, k8s, process)
 *   2. Agent      — AI coding tool (claude-code, codex, aider)
 *   3. Workspace  — code isolation (worktree, clone)
 *   4. Tracker    — issue tracking (github, linear, jira)
 *   5. SCM        — source platform + PR/CI/reviews (github, gitlab)
 *   6. Notifier   — push notifications (desktop, slack, webhook)
 *   7. Terminal   — human interaction UI (iterm2, web, none)
 *   8. Lifecycle Manager (core, not pluggable)
 */

// =============================================================================
// SESSION
// =============================================================================

/** Unique session identifier, e.g. "my-app-1", "backend-12" */
export type SessionId = string;

export type SessionKind = "worker" | "orchestrator";

export type CanonicalSessionState =
  | "not_started"
  | "working"
  | "idle"
  | "needs_input"
  | "stuck"
  | "detecting"
  | "done"
  | "terminated";

export type CanonicalSessionReason =
  | "spawn_requested"
  | "agent_acknowledged"
  | "task_in_progress"
  | "pr_created"
  | "pr_closed_waiting_decision"
  | "fixing_ci"
  | "resolving_review_comments"
  | "awaiting_user_input"
  | "awaiting_external_review"
  | "research_complete"
  | "merged_waiting_decision"
  | "manually_killed"
  | "pr_merged"
  | "auto_cleanup"
  | "runtime_lost"
  | "agent_process_exited"
  | "probe_failure"
  | "error_in_process";

export type CanonicalPRState = "none" | "open" | "merged" | "closed";

export type CanonicalPRReason =
  | "not_created"
  | "in_progress"
  | "ci_failing"
  | "review_pending"
  | "changes_requested"
  | "approved"
  | "merge_ready"
  | "merged"
  | "closed_unmerged"
  | "cleared_on_restore";

export type CanonicalRuntimeState = "unknown" | "alive" | "exited" | "missing" | "probe_failed";

export type CanonicalRuntimeReason =
  | "spawn_incomplete"
  | "process_running"
  | "process_missing"
  | "tmux_missing"
  | "manual_kill_requested"
  | "pr_merged_cleanup"
  | "auto_cleanup"
  | "probe_error";

export interface SessionStateRecord {
  kind: SessionKind;
  state: CanonicalSessionState;
  reason: CanonicalSessionReason;
  startedAt: string | null;
  completedAt: string | null;
  terminatedAt: string | null;
  lastTransitionAt: string;
}

export interface PRStateRecord {
  state: CanonicalPRState;
  reason: CanonicalPRReason;
  number: number | null;
  url: string | null;
  lastObservedAt: string | null;
}

export interface RuntimeStateRecord {
  state: CanonicalRuntimeState;
  reason: CanonicalRuntimeReason;
  lastObservedAt: string | null;
  handle: RuntimeHandle | null;
  tmuxName: string | null;
}

export interface CanonicalSessionLifecycle {
  version: 2;
  session: SessionStateRecord;
  pr: PRStateRecord;
  runtime: RuntimeStateRecord;
}

/** Session lifecycle states */
export type SessionStatus =
  | "spawning"
  | "working"
  | "detecting"
  | "pr_open"
  | "ci_failed"
  | "review_pending"
  | "changes_requested"
  | "approved"
  | "mergeable"
  | "merge_conflicts"
  | "merged"
  | "cleanup"
  | "needs_input"
  | "stuck"
  | "errored"
  | "killed"
  | "idle"
  | "done"
  | "terminated";

// =============================================================================
// TECHNIQUE SELECTION
// =============================================================================

/**
 * Coding technique used by AO workers.
 * Based on autor research: all 9 techniques converge within rubric noise (~80-85).
 * SR-prtype (84.45, n=16) is the safe default — no per-type routing is statistically justified.
 */
export type TechniqueType =
  | "SR-prtype"
  | "SR-fewshot"
  | "SR"
  | "ET"
  | "PRM"
  | "default";

/** PR-type taxonomy for technique routing (ZFC: delegated to model API) */
export type PrType =
  | "state-bool"
  | "data-norm"
  | "ci-workflow"
  | "typeddict-schema"
  | "large-arch-refactor"
  | "unknown";

export interface TechniqueConfig {
  default: TechniqueType;
  perType?: Partial<Record<PrType, TechniqueType>>;
  thresholds?: {
    minScoreDiff?: number;
    confidenceN?: number;
  };
}

export interface PrTypeClassification {
  type: PrType;
  confidence: "high" | "medium" | "low";
  reasoning?: string;
}

// =============================================================================
// ACTIVITY DETECTION
// =============================================================================

/** Activity state as detected by the agent plugin */
export type ActivityState =
  | "active"
  | "ready"
  | "idle"
  | "waiting_input"
  | "blocked"
  | "exited";

/** Activity state constants */
export const ACTIVITY_STATE = {
  ACTIVE: "active" as const,
  READY: "ready" as const,
  IDLE: "idle" as const,
  WAITING_INPUT: "waiting_input" as const,
  BLOCKED: "blocked" as const,
  EXITED: "exited" as const,
} satisfies Record<string, ActivityState>;

export type ActivitySignalState = "valid" | "stale" | "null" | "unavailable" | "probe_failure";

export type ActivitySignalSource = "native" | "terminal" | "runtime" | "none";

export interface ActivitySignal {
  state: ActivitySignalState;
  activity: ActivityState | null;
  timestamp?: Date;
  source: ActivitySignalSource;
  detail?: string;
}

/** Result of activity detection, carrying both the state and an optional timestamp. */
export interface ActivityDetection {
  state: ActivityState;
  timestamp?: Date;
}

/** A single entry in the AO activity JSONL log, written by agent plugins. */
export interface ActivityLogEntry {
  ts: string;
  state: ActivityState;
  source: "terminal" | "native";
  trigger?: string;
}

/** Default threshold (ms) before a "ready" session becomes "idle". */
export const DEFAULT_READY_THRESHOLD_MS = 300_000;

/** Default window (ms) for "active" state — activity newer than this is "active", older is "ready". */
export const DEFAULT_ACTIVE_WINDOW_MS = 30_000;

/** Session status constants */
export const SESSION_STATUS = {
  SPAWNING: "spawning" as const,
  WORKING: "working" as const,
  DETECTING: "detecting" as const,
  PR_OPEN: "pr_open" as const,
  CI_FAILED: "ci_failed" as const,
  REVIEW_PENDING: "review_pending" as const,
  CHANGES_REQUESTED: "changes_requested" as const,
  APPROVED: "approved" as const,
  MERGEABLE: "mergeable" as const,
  MERGE_CONFLICTS: "merge_conflicts" as const,
  MERGED: "merged" as const,
  CLEANUP: "cleanup" as const,
  NEEDS_INPUT: "needs_input" as const,
  STUCK: "stuck" as const,
  ERRORED: "errored" as const,
  IDLE: "idle" as const,
  KILLED: "killed" as const,
  DONE: "done" as const,
  TERMINATED: "terminated" as const,
} satisfies Record<string, SessionStatus>;

/** Statuses that indicate the session is in a terminal (dead) state. */
export const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "killed",
  "terminated",
  "done",
  "cleanup",
  "errored",
  "merged",
]);

/** Activity states that indicate the session is no longer running. */
export const TERMINAL_ACTIVITIES: ReadonlySet<ActivityState> = new Set(["exited"]);

/** Statuses that must never be restored (e.g. already merged). */
export const NON_RESTORABLE_STATUSES: ReadonlySet<SessionStatus> = new Set(["merged"]);

/** Check if a session is in a terminal (dead) state. */
export function isTerminalSession(session: {
  status: SessionStatus;
  activity: ActivityState | null;
  lifecycle?: CanonicalSessionLifecycle;
}): boolean {
  if (session.lifecycle) {
    return (
      session.lifecycle.session.state === "done" ||
      session.lifecycle.session.state === "terminated" ||
      session.lifecycle.pr.state === "merged" ||
      session.lifecycle.runtime.state === "missing" ||
      session.lifecycle.runtime.state === "exited"
    );
  }
  return (
    TERMINAL_STATUSES.has(session.status) ||
    (session.activity !== null && TERMINAL_ACTIVITIES.has(session.activity))
  );
}

/** Check if a session can be restored. */
export function isRestorable(session: {
  status: SessionStatus;
  activity: ActivityState | null;
  lifecycle?: CanonicalSessionLifecycle;
}): boolean {
  return isTerminalSession(session) && !NON_RESTORABLE_STATUSES.has(session.status);
}

/** A running agent session */
export interface Session {
  id: SessionId;

  tmuxName?: string;

  projectId: string;

  status: SessionStatus;

  activity: ActivityState | null;

  activitySignal: ActivitySignal;

  lifecycle: CanonicalSessionLifecycle;

  branch: string | null;

  issueId: string | null;

  pr: PRInfo | null;

  workspacePath: string | null;

  runtimeHandle: RuntimeHandle | null;

  agentInfo: AgentSessionInfo | null;

  createdAt: Date;

  lastActivityAt: Date;

  restoredAt?: Date;

  metadata: Record<string, string>;
}

export function isOrchestratorSession(
  session: { id: SessionId; metadata?: Record<string, string> },
  sessionPrefix?: string,
  allSessionPrefixes?: string[],
): boolean {
  if (session.metadata?.["role"] === "orchestrator") {
    return true;
  }
  if (!sessionPrefix) {
    return session.id.endsWith("-orchestrator");
  }
  const escaped = sessionPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (session.id === `${sessionPrefix}-orchestrator`) {
    return true;
  }
  if (!new RegExp(`^${escaped}-orchestrator-\\d+$`).test(session.id)) {
    return false;
  }
  if (allSessionPrefixes) {
    for (const prefix of allSessionPrefixes) {
      if (prefix === sessionPrefix) continue;
      if (
        new RegExp(
          `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+$`,
        ).test(session.id)
      ) {
        return false;
      }
    }
  }
  return true;
}

/** Config for creating a new session */
export interface SessionSpawnConfig {
  projectId: string;
  issueId?: string;
  branch?: string;
  prompt?: string;
  agent?: string;
  subagent?: string;
  lineage?: string[];
  siblings?: string[];
  runtimeOverride?: string;
  skipPrBoilerplate?: boolean;
}

/** Config for creating an orchestrator session */
export interface OrchestratorSpawnConfig {
  projectId: string;
  systemPrompt?: string;
  agent?: string;
}

// =============================================================================
// RUNTIME — Plugin Slot 1
// =============================================================================

export interface Runtime {
  readonly name: string;

  create(config: RuntimeCreateConfig): Promise<RuntimeHandle>;

  destroy(handle: RuntimeHandle): Promise<void>;

  sendMessage(handle: RuntimeHandle, message: string): Promise<void>;

  sendKeys?(handle: RuntimeHandle, key: string): Promise<void>;

  getOutput(handle: RuntimeHandle, lines?: number): Promise<string>;

  isAlive(handle: RuntimeHandle): Promise<boolean>;

  getMetrics?(handle: RuntimeHandle): Promise<RuntimeMetrics>;

  getAttachInfo?(handle: RuntimeHandle): Promise<AttachInfo>;

  getRestartCommand?(handle: RuntimeHandle): Promise<string>;

  preflight?(context: PreflightContext): Promise<void>;
}

export interface RuntimeCreateConfig {
  sessionId: SessionId;
  workspacePath: string;
  launchCommand: string;
  environment: Record<string, string>;
  onIdle?: (sessionId: SessionId) => void;
}

export interface RuntimeHandle {
  id: string;
  runtimeName: string;
  data: Record<string, unknown>;
}

export interface RuntimeMetrics {
  uptimeMs: number;
  memoryMb?: number;
  cpuPercent?: number;
}

export interface AttachInfo {
  type: "tmux" | "docker" | "ssh" | "web" | "process";
  target: string;
  command?: string;
}

// =============================================================================
// AGENT — Plugin Slot 2
// =============================================================================

export const PROCESS_PROBE_INDETERMINATE = "indeterminate" as const;

export type ProcessProbeResult = boolean | typeof PROCESS_PROBE_INDETERMINATE;

export function isProcessProbeIndeterminate(
  result: ProcessProbeResult,
): result is typeof PROCESS_PROBE_INDETERMINATE {
  return result === PROCESS_PROBE_INDETERMINATE;
}

export interface Agent {
  readonly name: string;

  readonly processName: string;

  readonly promptDelivery?: "inline" | "post-launch";

  readonly supportsSystemPromptFile?: boolean;

  getLaunchCommand(config: AgentLaunchConfig): string;

  getEnvironment(config: AgentLaunchConfig): Record<string, string>;

  detectActivity(terminalOutput: string): ActivityState;

  getActivityState(session: Session, readyThresholdMs?: number): Promise<ActivityDetection | null>;

  isProcessRunning(handle: RuntimeHandle): Promise<ProcessProbeResult>;

  getSessionInfo(session: Session): Promise<AgentSessionInfo | null>;

  getRestoreCommand?(session: Session, project: ProjectConfig): Promise<string | null>;

  preLaunchSetup?(workspacePath: string): Promise<void>;

  postLaunchSetup?(session: Session): Promise<void>;

  setupWorkspaceHooks?(workspacePath: string, config: WorkspaceHooksConfig): Promise<void>;

  recordActivity?(session: Session, terminalOutput: string): Promise<void>;

  preflight?(context: PreflightContext): Promise<void>;
}

export interface AgentLaunchConfig {
  sessionId: SessionId;
  projectConfig: ProjectConfig;
  workspacePath?: string;
  issueId?: string;
  prompt?: string;
  permissions?: AgentPermissionInput;
  model?: string;
  systemPrompt?: string;
  systemPromptFile?: string;
  subagent?: string;
}

export interface WorkspaceHooksConfig {
  dataDir: string;
  sessionId?: string;
}

export interface AgentSessionInfo {
  summary: string | null;
  summaryIsFallback?: boolean;
  agentSessionId: string | null;
  metadata?: Record<string, string>;
  cost?: CostEstimate;
}

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

// =============================================================================
// WORKSPACE — Plugin Slot 3
// =============================================================================

export interface Workspace {
  readonly name: string;

  create(config: WorkspaceCreateConfig): Promise<WorkspaceInfo>;

  destroy(workspacePath: string, repoPath?: string): Promise<void>;

  list(projectId: string): Promise<WorkspaceInfo[]>;

  findManagedWorkspace?(config: WorkspaceCreateConfig): Promise<WorkspaceInfo | null>;

  postCreate?(info: WorkspaceInfo, project: ProjectConfig): Promise<void>;

  exists?(workspacePath: string): Promise<boolean>;

  restore?(config: WorkspaceCreateConfig, workspacePath: string): Promise<WorkspaceInfo>;

  preflight?(context: PreflightContext): Promise<void>;
}

export interface WorkspaceCreateConfig {
  projectId: string;
  project: ProjectConfig;
  sessionId: SessionId;
  branch: string;
  worktreeDir?: string;
}

export interface WorkspaceInfo {
  path: string;
  branch: string;
  sessionId: SessionId;
  projectId: string;
  repoPath?: string;
}

// =============================================================================
// TRACKER — Plugin Slot 4
// =============================================================================

export interface Tracker {
  readonly name: string;

  getIssue(identifier: string, project: ProjectConfig): Promise<Issue>;

  isCompleted(identifier: string, project: ProjectConfig): Promise<boolean>;

  issueUrl(identifier: string, project: ProjectConfig): string;

  issueLabel?(url: string, project: ProjectConfig): string;

  branchName(identifier: string, project: ProjectConfig): string;

  generatePrompt(identifier: string, project: ProjectConfig): Promise<string>;

  listIssues?(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]>;

  updateIssue?(identifier: string, update: IssueUpdate, project: ProjectConfig): Promise<void>;

  createIssue?(input: CreateIssueInput, project: ProjectConfig): Promise<Issue>;

  preflight?(context: PreflightContext): Promise<void>;
}

export interface Issue {
  id: string;
  title: string;
  description: string;
  url: string;
  state: "open" | "in_progress" | "closed" | "cancelled";
  labels: string[];
  assignee?: string;
  priority?: number;
  branchName?: string;
}

export interface IssueFilters {
  state?: "open" | "closed" | "all";
  labels?: string[];
  assignee?: string;
  limit?: number;
}

export interface IssueUpdate {
  state?: "open" | "in_progress" | "closed";
  labels?: string[];
  removeLabels?: string[];
  assignee?: string;
  comment?: string;
}

export interface CreateIssueInput {
  title: string;
  description: string;
  labels?: string[];
  assignee?: string;
  priority?: number;
}

// =============================================================================
// SCM — Plugin Slot 5
// =============================================================================

export interface SCM {
  readonly name: string;

  verifyWebhook?(
    request: SCMWebhookRequest,
    project: ProjectConfig,
  ): Promise<SCMWebhookVerificationResult>;

  parseWebhook?(
    request: SCMWebhookRequest,
    project: ProjectConfig,
  ): Promise<SCMWebhookEvent | null>;

  listOpenPRs?(project: ProjectConfig): Promise<PRInfo[]>;

  detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null>;

  resolvePR?(reference: string, project: ProjectConfig): Promise<PRInfo>;

  assignPRToCurrentUser?(pr: PRInfo): Promise<void>;

  checkoutPR?(pr: PRInfo, workspacePath: string): Promise<boolean>;

  getPRState(pr: PRInfo): Promise<PRState>;

  getPRSummary?(pr: PRInfo): Promise<{
    state: PRState;
    title: string;
    additions: number;
    deletions: number;
  }>;

  mergePR(pr: PRInfo, method?: MergeMethod, autoWaitSeconds?: number): Promise<void>;

  closePR(pr: PRInfo): Promise<void>;

  getCIChecks(pr: PRInfo): Promise<CICheck[]>;

  getCIFailureSummary?(pr: PRInfo, failedChecks?: CICheck[]): Promise<CIFailureSummary | null>;

  getCISummary(pr: PRInfo): Promise<CIStatus>;

  getReviews(pr: PRInfo): Promise<Review[]>;

  getReviewDecision(pr: PRInfo): Promise<ReviewDecision>;

  getPRStateAndReview?(pr: PRInfo): Promise<{ state: PRState; reviewDecision: ReviewDecision }>;

  getPendingComments(pr: PRInfo): Promise<ReviewComment[]>;

  getReviewThreads?(pr: PRInfo): Promise<ReviewThreadsResult>;

  getAutomatedComments(pr: PRInfo): Promise<AutomatedComment[]>;

  getSkepticComments?(pr: PRInfo): Promise<Array<{ id: number; body: string; user: { login: string } }>>;

  listPRComments?(pr: PRInfo): Promise<Array<{ id: number; body: string; user: { login: string } }>>;

  resolveComment?(pr: PRInfo, commentId: string): Promise<void>;

  requestReview?(pr: PRInfo, reviewerLogin: string): Promise<void>;

  getPRHeadSha?(pr: PRInfo): Promise<string>;

  getMergeability(pr: PRInfo): Promise<MergeReadiness>;

  getBatchPRStatus?(pr: PRInfo): Promise<BatchPRStatus>;

  enrichSessionsPRBatch?(prs: PRInfo[], observer?: BatchObserver, repos?: string[]): Promise<Map<string, PREnrichmentData>>;

  getSkepticVerdict?(pr: PRInfo): Promise<"PASS" | "FAIL" | "SKIPPED">;

  validateCommits?(
    session: Session,
    project: ProjectConfig,
  ): Promise<{
    localCommits: string[];
    remoteCommits: string[];
    pushed: boolean;
  }>;

  preflight?(context: PreflightContext): Promise<void>;
}

export interface CIFailureSummary {
  failedJobs: Array<{
    name: string;
    failedStep?: string;
    runUrl: string;
    logTail?: string;
  }>;
}

// --- PR Types ---

export interface PRInfo {
  number: number;
  url: string;
  title: string;
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
  isDraft: boolean;
  state?: PRState;
  author?: string;
}

export type PRState = "open" | "merged" | "closed";

export const PR_STATE = {
  OPEN: "open" as const,
  MERGED: "merged" as const,
  CLOSED: "closed" as const,
} satisfies Record<string, PRState>;

export const VALID_PR_STATES = new Set<PRState>(["open", "merged", "closed"]);

export type MergeMethod = "merge" | "squash" | "rebase";

export interface SCMWebhookRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  rawBody?: Uint8Array;
  path?: string;
  query?: Record<string, string | string[] | undefined>;
}

export interface SCMWebhookVerificationResult {
  ok: boolean;
  reason?: string;
  deliveryId?: string;
  eventType?: string;
}

export type SCMWebhookEventKind = "pull_request" | "ci" | "review" | "comment" | "push" | "unknown";

export interface SCMWebhookEvent {
  provider: string;
  kind: SCMWebhookEventKind;
  action: string;
  rawEventType: string;
  deliveryId?: string;
  projectId?: string;
  repository?: {
    owner: string;
    name: string;
  };
  prNumber?: number;
  branch?: string;
  sha?: string;
  timestamp?: Date;
  data: Record<string, unknown>;
}

// --- CI Types ---

export interface CICheck {
  name: string;
  status: "pending" | "running" | "passed" | "failed" | "skipped";
  url?: string;
  conclusion?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export type CIStatus = "pending" | "passing" | "failing" | "none";

export const CI_STATUS = {
  PENDING: "pending" as const,
  PASSING: "passing" as const,
  FAILING: "failing" as const,
  NONE: "none" as const,
} satisfies Record<string, CIStatus>;

// --- Review Types ---

export interface Review {
  author: string;
  state: "approved" | "changes_requested" | "commented" | "dismissed" | "pending";
  body?: string;
  submittedAt: Date;
}

export type ReviewDecision = "approved" | "changes_requested" | "pending" | "none";

export interface ReviewComment {
  id: string;
  threadId?: string;
  author: string;
  body: string;
  path?: string;
  line?: number;
  isResolved: boolean;
  createdAt: Date;
  url: string;
  isBot?: boolean;
}

export interface ReviewSummary {
  author: string;
  state: string;
  body: string;
  submittedAt: Date;
}

export interface ReviewThreadsResult {
  threads: ReviewComment[];
  reviews: ReviewSummary[];
}

export interface AutomatedComment {
  id: string;
  botName: string;
  body: string;
  path?: string;
  line?: number;
  severity: "error" | "warning" | "info";
  createdAt: Date;
  url: string;
}

// --- Merge Readiness ---

export interface MergeReadiness {
  mergeable: boolean;
  ciPassing: boolean;
  approved: boolean;
  noConflicts: boolean;
  blockers: string[];
}

export interface BatchPRStatus {
  state: PRState;
  ciStatus: CIStatus;
  reviewDecision: ReviewDecision;
  mergeReadiness: MergeReadiness;
}

export interface PREnrichmentData {
  state: PRState;
  ciStatus: CIStatus;
  reviewDecision: ReviewDecision;
  mergeable: boolean;
  title?: string;
  additions?: number;
  deletions?: number;
  isDraft?: boolean;
  hasConflicts?: boolean;
  isBehind?: boolean;
  blockers?: string[];
  ciChecks?: CICheck[];
}

export interface BatchObserver {
  recordSuccess(data: {
    batchIndex: number;
    totalBatches: number;
    prCount: number;
    durationMs: number;
  }): void;
  recordFailure(data: {
    batchIndex: number;
    totalBatches: number;
    prCount: number;
    error: string;
    durationMs: number;
  }): void;
  log(level: ObservabilityLevel, message: string): void;
  reportPRListUnchangedRepos?(repos: Set<string>): void;
}

// =============================================================================
// NOTIFIER — Plugin Slot 6 (PRIMARY INTERFACE)
// =============================================================================

export interface Notifier {
  readonly name: string;

  notify(event: OrchestratorEvent): Promise<void>;

  notifyWithActions?(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void>;

  post?(message: string, context?: NotifyContext): Promise<string | null>;
}

export interface NotifyAction {
  label: string;
  url?: string;
  callbackEndpoint?: string;
}

export interface NotifyContext {
  sessionId?: SessionId;
  projectId?: string;
  prUrl?: string;
  channel?: string;
}

// =============================================================================
// POLLER — Plugin Slot 8 (bd-uxs.2)
// =============================================================================

export interface Poller {
  readonly name: string;

  poll(projectId: string): Promise<PollerWorkItem[]>;

  spawnSession(
    workItem: PollerWorkItem,
    projectId: string,
    config: SessionSpawnConfig,
  ): Promise<Session | null>;
}

export interface PollerWorkItem {
  id: string;
  type: string;
  title: string;
  url: string;
  priority?: number;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// TERMINAL — Plugin Slot 7
// =============================================================================

export interface Terminal {
  readonly name: string;

  openSession(session: Session): Promise<void>;

  openAll(sessions: Session[]): Promise<void>;

  isSessionOpen?(session: Session): Promise<boolean>;
}

// =============================================================================
// EVENTS
// =============================================================================

export type EventPriority = "urgent" | "action" | "warning" | "info";

export type EventType =
  | "session.spawn_started"
  | "session.spawned"
  | "session.working"
  | "session.exited"
  | "session.killed"
  | "session.idle"
  | "session.stuck"
  | "session.needs_input"
  | "session.errored"
  | "pr.created"
  | "pr.updated"
  | "pr.merged"
  | "pr.closed"
  | "ci.passing"
  | "ci.failing"
  | "ci.fix_sent"
  | "ci.fix_failed"
  | "review.pending"
  | "review.approved"
  | "review.changes_requested"
  | "review.comments_sent"
  | "review.comments_unresolved"
  | "automated_review.found"
  | "automated_review.fix_sent"
  | "merge.ready"
  | "merge.conflicts"
  | "merge.completed"
  | "merge.approval_requested"
  | "reaction.triggered"
  | "reaction.escalated"
  | "session.exit_validated"
  | "session.exit_failed"
  | "worker.signals_completion"
  | "worker.merge_conflict"
  | "summary.all_complete";

export interface OrchestratorEvent {
  id: string;
  type: EventType;
  priority: EventPriority;
  sessionId: SessionId;
  projectId: string;
  timestamp: Date;
  message: string;
  data: Record<string, unknown>;
}

export interface EventBus {
  emit(event: OrchestratorEvent): void;
  on(event: EventType | "*", handler: (event: OrchestratorEvent) => void): void;
  off(event: EventType | "*", handler: (event: OrchestratorEvent) => void): void;
  getHistory(filter?: EventFilter): OrchestratorEvent[];
}

export interface EventFilter {
  sessionId?: SessionId;
  projectId?: string;
  type?: EventType;
  priority?: EventPriority;
  since?: Date;
  limit?: number;
}

// =============================================================================
// REACTIONS
// =============================================================================

export interface ReactionConfig {
  auto: boolean;

  action: "send-to-agent" | "notify" | "auto-merge" | "request-merge" | "parallel-retry" | "skeptic-review" | "respawn-for-review" | "claim-verification" | "agent-fallback";

  message?: string;

  priority?: EventPriority;

  retries?: number;

  escalateAfter?: number | string;

  threshold?: string;

  includeSummary?: boolean;

  mergeMethod?: "merge" | "squash" | "rebase";

  autoMergeWaitSeconds?: number;

  failureBudget?: {
    max: number;
    window?: string;
  };

  onBudgetExhausted?: "escalate" | "disable" | "route-to" | "notify";
  routeToAgent?: string;

  parallelRetry?: {
    maxParallel: number;
    strategies: string[];
    killOnSuccess?: boolean;
  };

  skepticModel?: string;
  skepticPostComment?: boolean;
  skepticExcludePaths?: string[];
}

export interface ReactionResult {
  reactionType: string;
  success: boolean;
  action: string;
  message?: string;
  escalated: boolean;
  blockers?: string[];
}

export interface SessionExitProof {
  sessionId: SessionId;
  projectId: string;
  exitStatus: SessionStatus;
  commitsPushed: boolean;
  localCommits: string[];
  remoteCommits: string[];
  prUrl?: string;
  prMerged?: boolean;
  validatedAt: string;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface PowerConfig {
  preventIdleSleep: boolean;
}

export interface LifecycleConfig {
  autoCleanupOnMerge: boolean;
  mergeCleanupIdleGraceMs: number;
}

export type DashboardAttentionZoneMode = "simple" | "detailed";

export interface DashboardConfig {
  attentionZones?: DashboardAttentionZoneMode;
}

export interface DegradedProjectEntry {
  projectId: string;
  path: string;
  resolveError: string;
}

export interface LoadedConfig extends OrchestratorConfig {
  degradedProjects: Record<string, DegradedProjectEntry>;
}

export type ExternalPluginLocation =
  | { kind: "project"; projectId: string; configType: "tracker" | "scm" }
  | { kind: "notifier"; notifierId: string };

export interface ExternalPluginEntryRef {
  source: string;
  location: ExternalPluginLocation;
  slot: "tracker" | "scm" | "notifier";
  package?: string;
  path?: string;
  expectedPluginName?: string;
}

export type InstalledPluginSource = "registry" | "npm" | "local";

export interface InstalledPluginConfig {
  name: string;
  source: InstalledPluginSource;
  package?: string;
  version?: string;
  path?: string;
  enabled?: boolean;
}

/** Top-level orchestrator configuration (from agent-orchestrator.yaml) */
export interface OrchestratorConfig {
  "$schema"?: string;

  configPath: string;

  autoMerge?: AutoMergeConfig;

  _hasExplicitGlobalReaction?: Record<string, boolean>;

  _externalPluginEntries?: ExternalPluginEntryRef[];

  port?: number;

  terminalPort?: number;

  directTerminalPort?: number;

  readyThresholdMs: number;

  power?: PowerConfig;

  lifecycle?: LifecycleConfig;

  startupGracePeriodMs?: number;

  scmFailureThreshold?: number;

  defaults: DefaultPlugins;

  plugins?: InstalledPluginConfig[];

  projects: Record<string, ProjectConfig>;

  dashboard?: DashboardConfig;

  notifiers: Record<string, NotifierConfig>;

  notificationRouting: Record<EventPriority, string[]>;

  reactions: Record<string, ReactionConfig>;

  pollers?: Record<string, PollerConfig>;

  outcomes?: OutcomeConfig;

  envSource?: string[];

  worktreeDir?: string;
}

export interface AutoMergeConfig {
  enabled?: boolean;
  waitSeconds?: number;
  mergeMethod?: MergeMethod;
}

export interface DefaultPlugins {
  runtime: string;
  agent: string;
  workspace: string;
  notifiers: string[];
  agentConfig?: AgentSpecificConfig;
  modelByCli?: Record<string, CliModelDefaults>;
  fallbackAgents?: string[];
  orchestrator?: RoleAgentConfig;
  worker?: RoleAgentConfig;
  autoMerge?: AutoMergeConfig;
  scmFailureThreshold?: number;
  envSource?: string[];
}

export interface RoleAgentConfig {
  agent?: string;
  agentConfig?: AgentSpecificConfig;
}

export interface PollerConfig {
  type: string;
  enabled?: boolean;
  interval?: string;
  respawnCap?: {
    max: number;
    window: string;
  };
  agent?: string;
  promptTemplate?: string;
  [key: string]: unknown;
}

export interface OutcomeConfig {
  enabled?: boolean;
  storage?: string;
  patternSynthesis?: {
    minSamples: number;
    confidenceThreshold: number;
  };
}

export interface RecordedOutcome {
  sessionId: SessionId;
  projectId: string;
  trigger: string;
  action: string;
  strategy?: string;
  errorClass?: string;
  success: boolean;
  durationMs?: number;
  error?: string;
  prNumber?: number;
  recordedAt: string;
}

export interface ProjectConfig {
  name: string;

  repo?: string;

  path: string;

  configPath?: string;

  resolveError?: string;

  defaultBranch: string;

  sessionPrefix: string;

  enabled?: boolean;

  runtime?: string;

  agent?: string;

  defaultAgent?: string;

  fallbackAgents?: string[];

  workspace?: string;

  env?: Record<string, string>;

  tracker?: TrackerConfig;

  scm?: SCMConfig;

  symlinks?: string[];

  postCreate?: string[];

  agentConfig?: AgentSpecificConfig;
  modelByCli?: Record<string, CliModelDefaults>;

  orchestrator?: RoleAgentConfig;

  worker?: RoleAgentConfig;

  reactions?: Record<string, Partial<ReactionConfig>>;

  pollers?: Record<string, PollerConfig>;

  outcomes?: OutcomeConfig;

  agentRules?: string;

  agentRulesFile?: string;

  orchestratorRules?: string;

  orchestratorSessionStrategy?:
    | "reuse"
    | "delete"
    | "ignore"
    | "delete-new"
    | "ignore-new"
    | "kill-previous";

  opencodeIssueSessionStrategy?: "reuse" | "delete" | "ignore";

  decomposer?: {
    enabled: boolean;
    maxDepth: number;
    model: string;
    requireApproval: boolean;
  };

  autoMerge?: AutoMergeConfig;

  backfillAllPRs?: boolean;

  mergeGate?: MergeGateConfig;

  worktreeDir?: string;

  spawnQueue?: SpawnQueueConfig;

  scmFailureThreshold?: number;

  taskQueue?: TaskQueueConfig;

  evolveLoop?: EvolveLoopConfig;

  technique?: TechniqueConfig;
}

export interface MergeGateConfig {
  enabled: boolean;
  requiredLabels?: string[];
  blockedLabels?: string[];
  requiredChecks?: string[];
  minApprovals?: number;
  unchangedFiles?: string[];
  requiredFiles?: string[];
  preMergeWebhook?: string;
  webhookTimeout?: number;
  skepticRequired?: boolean;
  skepticBypassProjects?: string[];
}

export interface EvolveLoopConfig {
  enabled?: boolean;
  pollCadence?: "lightweight" | "standard";
  autonomousFixScopes?: string[];
  blockedScopes?: string[];
  knowledgeBaseDir?: string;
  zeroTouchWindow?: "24h" | "30d";
}

export interface TaskQueueConfig {
  enabled: boolean;
  maxConcurrent: number;
  beads: string[];
  taskTemplate?: string;
}

export interface SpawnQueueConfig {
  enabled: boolean;
  maxActiveSessions: number;
}

export interface TrackerConfig {
  plugin?: string;
  package?: string;
  path?: string;
  [key: string]: unknown;
}

export interface SCMConfig {
  plugin?: string;
  package?: string;
  path?: string;
  webhook?: SCMWebhookConfig;
  skipAutomatedCommentPolling?: boolean;
  [key: string]: unknown;
}

export interface SCMWebhookConfig {
  enabled?: boolean;
  path?: string;
  secretEnvVar?: string;
  signatureHeader?: string;
  eventHeader?: string;
  deliveryHeader?: string;
  maxBodyBytes?: number;
}

export interface NotifierConfig {
  plugin?: string;
  package?: string;
  path?: string;
  [key: string]: unknown;
}

export interface CliModelDefaults {
  model?: string;
  orchestratorModel?: string;
}

export interface AgentSpecificConfig {
  permissions?: AgentPermissionMode | LegacyAgentPermissionMode;
  model?: string;
  orchestratorModel?: string;
  [key: string]: unknown;
}

export interface OpenCodeAgentConfig extends AgentSpecificConfig {
  opencodeSessionId?: string;
}

export type AgentPermissionMode = "permissionless" | "default" | "auto-edit" | "suggest";

export type LegacyAgentPermissionMode = "skip" | "auto";

export type AgentPermissionInput = AgentPermissionMode | LegacyAgentPermissionMode;

export function normalizeAgentPermissionMode(
  mode: string | undefined,
): AgentPermissionMode | undefined {
  if (!mode) return undefined;
  if (mode === "skip" || mode === "auto") return "permissionless";
  if (
    mode !== "permissionless" &&
    mode !== "default" &&
    mode !== "auto-edit" &&
    mode !== "suggest"
  ) {
    return undefined;
  }
  return mode;
}

// =============================================================================
// PLUGIN SYSTEM
// =============================================================================

export type PluginSlot =
  | "runtime"
  | "agent"
  | "workspace"
  | "tracker"
  | "scm"
  | "notifier"
  | "terminal"
  | "poller";

export interface PluginManifest {
  name: string;
  slot: PluginSlot;
  description: string;
  version: string;
  displayName?: string;
}

export interface PluginModule<T = unknown> {
  manifest: PluginManifest;
  create(config?: Record<string, unknown>): T;
  detect?(): boolean;
}

export interface PreflightContext {
  project: ProjectConfig;
  intent: {
    role: "worker" | "orchestrator";
    willClaimExistingPR: boolean;
  };
}

// =============================================================================
// SESSION METADATA
// =============================================================================

export interface SessionMetadata {
  worktree: string;
  branch: string;
  status: string;
  lifecycle?: CanonicalSessionLifecycle;
  tmuxName?: string;
  issue?: string;
  issueTitle?: string;
  pr?: string;
  prAutoDetect?: boolean | "on" | "off";
  prState?: PRState;
  summary?: string;
  project?: string;
  agent?: string;
  action?: string;
  createdAt?: string;
  runtimeHandle?: RuntimeHandle | string;
  restoredAt?: string;
  role?: string;
  dashboard?: {
    port?: number;
    terminalWsPort?: number;
    directTerminalWsPort?: number;
  };
  dashboardPort?: number;
  terminalWsPort?: number;
  directTerminalWsPort?: number;
  opencodeSessionId?: string;
  claudeSessionUuid?: string;
  codexThreadId?: string;
  codexModel?: string;
  restoreFallbackReason?: string;
  repoPath?: string;
  pinnedSummary?: string;
  userPrompt?: string;
  requestedTask?: string;
  composedPromptPath?: string;
  displayName?: string;
  displayNameUserSet?: boolean | "on" | "off";
}

// =============================================================================
// SERVICE INTERFACES (core, not pluggable)
// =============================================================================

export type LifecycleKillReason = "manually_killed" | "pr_merged" | "auto_cleanup";

export interface KillResult {
  cleaned: boolean;
  alreadyTerminated: boolean;
}

export interface KillOptions {
  purgeOpenCode?: boolean;
  reason?: LifecycleKillReason;
}

/** Session manager — CRUD for sessions */
export interface SessionManager {
  spawn(config: SessionSpawnConfig): Promise<Session>;
  spawnOrchestrator(config: OrchestratorSpawnConfig): Promise<Session>;
  ensureOrchestrator(config: OrchestratorSpawnConfig): Promise<Session>;
  restore(sessionId: SessionId): Promise<Session>;
  list(projectId?: string): Promise<Session[]>;
  get(sessionId: SessionId): Promise<Session | null>;
  kill(sessionId: SessionId, options?: KillOptions): Promise<KillResult>;
  cleanup(
    projectId?: string,
    options?: { dryRun?: boolean; purgeOpenCode?: boolean },
  ): Promise<CleanupResult>;
  send(sessionId: SessionId, message: string): Promise<void>;
  claimPR(sessionId: SessionId, prRef: string, options?: ClaimPROptions): Promise<ClaimPRResult>;
}

/** OpenCode-specific session manager with remap capability */
export interface OpenCodeSessionManager extends SessionManager {
  remap(sessionId: SessionId, force?: boolean): Promise<string>;
  pruneStaleWorktrees(): Promise<void>;
  listCached(projectId?: string): Promise<Session[]>;
  invalidateCache(): void;
}

export interface ClaimPROptions {
  assignOnGithub?: boolean;
  takeover?: boolean;
  sendInitialMessage?: boolean;
}

export interface ClaimPRResult {
  sessionId: SessionId;
  projectId: string;
  pr: PRInfo;
  branchChanged: boolean;
  githubAssigned: boolean;
  githubAssignmentError?: string;
  takenOverFrom: SessionId[];
}

export function isOpenCodeSessionManager(sm: SessionManager): sm is OpenCodeSessionManager {
  return typeof (sm as OpenCodeSessionManager).remap === "function";
}

export interface CleanupResult {
  killed: string[];
  skipped: string[];
  errors: Array<{ sessionId: string; error: string }>;
}

/** Lifecycle manager — state machine + reaction engine */
export interface LifecycleManager {
  start(intervalMs?: number): void;
  stop(): void;
  getStates(): Map<SessionId, SessionStatus>;
  check(sessionId: SessionId): Promise<void>;
}

/** Plugin registry — discovery + loading */
export interface PluginRegistry {
  register(plugin: PluginModule, config?: Record<string, unknown>): void;
  get<T>(slot: PluginSlot, name: string): T | null;
  list(slot: PluginSlot): PluginManifest[];
  loadBuiltins(
    config?: OrchestratorConfig,
    importFn?: (pkg: string) => Promise<unknown>,
    fallbackImportFn?: (pkg: string, selfUrl: string) => Promise<unknown>,
  ): Promise<void>;
  loadFromConfig(
    config: OrchestratorConfig,
    importFn?: (pkg: string) => Promise<unknown>,
    fallbackImportFn?: (pkg: string, selfUrl: string) => Promise<unknown>,
  ): Promise<void>;
}

// =============================================================================
// ERROR DETECTION HELPERS
// =============================================================================

export function isIssueNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const message = (err as Error).message?.toLowerCase() || "";

  return (
    (message.includes("issue") &&
      (message.includes("not found") || message.includes("does not exist"))) ||
    message.includes("no issue found") ||
    message.includes("could not find issue") ||
    message.includes("could not resolve to an issue") ||
    message.includes("no issue with identifier") ||
    message.includes("invalid issue format")
  );
}

/** Thrown when a session cannot be restored (e.g. merged, still working). */
export class SessionNotRestorableError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly reason: string,
  ) {
    super(`Session ${sessionId} cannot be restored: ${reason}`);
    this.name = "SessionNotRestorableError";
  }
}

/** Thrown when a workspace is missing and cannot be recreated. */
export class WorkspaceMissingError extends Error {
  constructor(
    public readonly path: string,
    public readonly detail?: string,
  ) {
    super(`Workspace missing at ${path}${detail ? `: ${detail}` : ""}`);
    this.name = "WorkspaceMissingError";
  }
}

/** Thrown when a session lookup fails (session does not exist). */
export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

/** Thrown when no agent-orchestrator.yaml config file can be found. */
export class ConfigNotFoundError extends Error {
  constructor(message?: string) {
    super(message ?? "No agent-orchestrator.yaml found. Run `ao start` to bootstrap a config.");
    this.name = "ConfigNotFoundError";
  }
}

/** Thrown when a project cannot be resolved into an effective runtime config. */
export class ProjectResolveError extends Error {
  constructor(
    public readonly projectId: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectResolveError";
  }
}

// =============================================================================
// PORTFOLIO — Cross-project aggregation
// =============================================================================

export interface PortfolioProject {
  id: string;
  name: string;
  configPath: string;
  configProjectKey: string;
  repoPath: string;
  repo?: string;
  defaultBranch?: string;
  sessionPrefix: string;
  source: "discovered" | "registered" | "config";
  enabled: boolean;
  pinned: boolean;
  lastSeenAt: string;
  resolveError?: string;
}

export interface PortfolioPreferences {
  version: 1;
  defaultProjectId?: string;
  projectOrder?: string[];
  projects?: Record<string, {
    pinned?: boolean;
    enabled?: boolean;
    displayName?: string;
  }>;
}

export interface PortfolioRegistered {
  version: 1;
  projects: Array<{
    path: string;
    configProjectKey?: string;
    addedAt: string;
  }>;
}

export interface PortfolioSession {
  session: Session;
  project: PortfolioProject;
}
