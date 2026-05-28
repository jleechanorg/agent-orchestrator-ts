/**
 * @jleechanorg/ao-core
 *
 * Core library for the Agent Orchestrator.
 * Exports all types, config loader, and service implementations.
 */

// Types — everything plugins and consumers need
export * from "./types.js";

// Config — YAML loader + validation
export {
  loadConfig,
  loadConfigWithPath,
  validateConfig,
  getDefaultConfig,
  findConfig,
  findConfigFile,
} from "./config.js";
export { deepMerge, isPlainObject } from "./deep-merge.js";
export {
  findManagedConfigFile,
  getManagedConfigPath,
  getLegacyConfigPaths,
  getPreferredConfigSearchPaths,
  validateManagedConfigTopology,
  findRepoLocalConfigFile,
} from "./config-topology.js";
export type {
  ManagedConfigEnvironment,
  ManagedConfigTopologyIssue,
  ManagedConfigTopologyProblem,
} from "./config-topology.js";

// Plugin registry
export { createPluginRegistry, BUILTIN_PLUGINS } from "./plugin-registry.js";

// Metadata — flat-file session metadata read/write
export {
  readMetadata,
  readMetadataRaw,
  writeMetadata,
  updateMetadata,
  deleteMetadata,
  listMetadata,
} from "./metadata.js";

// Agent selection — role + persisted agent resolution
export {
  resolveAgentSelection,
  resolveAgentSelectionForSession,
  resolveSessionRole,
  type ResolvedAgentSelection,
  type SessionRole,
} from "./agent-selection.js";

// tmux — command wrappers
export {
  isTmuxAvailable,
  listSessions as listTmuxSessions,
  hasSession as hasTmuxSession,
  sendKeys as tmuxSendKeys,
  capturePane as tmuxCapturePane,
  killSession as killTmuxSession,
  getPaneTTY as getTmuxPaneTTY,
} from "./tmux.js";

// Session manager — session CRUD
export { createSessionManager } from "./session-manager.js";
export type { SessionManagerDeps } from "./session-manager.js";
export { killProcessTreeAndWait } from "./kill-and-wait.js";
export { findDuplicateSessions, type DuplicateMatch } from "./session-duplicate-detect.js";
export { validateStatusTransition, type TransitionValidationResult } from "./session-status-validator.js";

// Activity log — terminal activity detection and recording
export {
  DEFAULT_ACTIVE_WINDOW_MS,
  PROCESS_PROBE_INDETERMINATE,
  readLastActivityEntry,
  checkActivityLogState,
  getActivityFallbackState,
  recordTerminalActivity,
} from "./activity-log.js";

// Activity log thresholds (defined in types.ts)
export { DEFAULT_NATIVE_ACTIVE_WINDOW_MS, DEFAULT_READY_THRESHOLD_MS, isProcessProbeIndeterminate } from "./types.js";

// Agent workspace hooks — path wrapper workspace setup
export { setupPathWrapperWorkspace } from "./agent-workspace-hooks.js";

// Lifecycle manager — state machine + reaction engine
export { createLifecycleManager } from "./lifecycle-manager.js";
export type { LifecycleManagerDeps } from "./lifecycle-manager.js";

// CI failure context — upstream commit 3fb23cfb4 companion module
export {
  enrichCIFailureReaction,
  formatCIFailureMessage,
  getFailedCIChecks,
  makeCIFailureFingerprint,
  isFailedCICheck,
  escapeMarkdownCodeFenceClosers,
} from "./upstream-ci-failure-context.js";
export type { CIFailureSummary } from "./types.js";

// Failure budget tracker — tracks retry attempts and routes on exhaustion
export { FailureBudgetTracker, routeExhaustedBudget } from "./failure-budget.js";
export type { BudgetExhaustedDeps } from "./failure-budget.js";

// Spawn queue — persistent admission control for bounded worker spawns
export {
  drainSpawnQueue,
  enqueueSpawnRequest,
  resolveSpawnQueueConfig,
  hasSpawnCapacity,
  countActiveSessions,
  _resetSpawnQueueTimer,
} from "./spawn-queue.js";
export type {
  DrainSpawnQueueDeps,
  DrainSpawnQueueParams,
  EnqueueSpawnRequestInput,
  SpawnQueueConfigResolved,
} from "./spawn-queue.js";

// Spawn guard — prevent concurrent ao spawn for the same project
export { acquireSpawnLock } from "./spawn-guard.js";
export type { AcquireResult, AcquireBlockedResult } from "./spawn-guard.js";

// Poller manager — outer initiation loop (bd-uxs.2)
export { createPollerManager } from "./poller-manager.js";
export type { PollerManagerDeps } from "./poller-manager.js";

// Prompt builder — layered prompt composition
export { buildPrompt, BASE_AGENT_PROMPT, CORE_AGENT_PROMPT, PR_BOILERPLATE } from "./prompt-builder.js";
export type { PromptBuildConfig } from "./prompt-builder.js";

// Decomposer — LLM-driven task decomposition
export {
  decompose,
  getLeaves,
  getSiblings,
  formatPlanTree,
  formatLineage,
  formatSiblings,
  propagateStatus,
  DEFAULT_DECOMPOSER_CONFIG,
} from "./decomposer.js";
export type {
  TaskNode,
  TaskKind,
  TaskStatus,
  DecompositionPlan,
  DecomposerConfig,
} from "./decomposer.js";

// Orchestrator prompt — generates orchestrator context for `ao start`
export { generateOrchestratorPrompt } from "./orchestrator-prompt.js";
export type { OrchestratorPromptConfig } from "./orchestrator-prompt.js";

// Global pause constants and utilities
export {
  GLOBAL_PAUSE_UNTIL_KEY,
  GLOBAL_PAUSE_REASON_KEY,
  GLOBAL_PAUSE_SOURCE_KEY,
  GLOBAL_PAUSE_CREATED_AT_KEY,
  parsePauseUntil,
} from "./global-pause.js";

// Shared utilities
export {
  shellEscape,
  escapeAppleScript,
  validateUrl,
  isRetryableHttpStatus,
  normalizeRetryConfig,
  readLastJsonlEntry,
  readLastJsonEntry,
  resolveProjectIdForSessionId,
  isGitBranchNameSafe,
} from "./utils.js";
export {
  getWebhookHeader,
  parseWebhookJsonObject,
  parseWebhookTimestamp,
  parseWebhookBranchRef,
} from "./scm-webhook-utils.js";
export { asValidOpenCodeSessionId } from "./opencode-session-id.js";

// GitHub rate-limit detection & backoff (shared across gh-based plugins)
export {
  GH_RATE_LIMIT_ERROR_PATTERNS,
  isGhRateLimitError,
  ghSleep,
} from "./gh-rate-limit.js";
export { normalizeOrchestratorSessionStrategy } from "./orchestrator-session-strategy.js";
export type { NormalizedOrchestratorSessionStrategy } from "./orchestrator-session-strategy.js";

export {
  createCorrelationId,
  createProjectObserver,
  readObservabilitySummary,
} from "./observability.js";
export type {
  ObservabilityMetricName,
  ObservabilityHealthStatus,
  ObservabilitySummary,
  ProjectObserver,
} from "./observability.js";

// Feedback tools — contracts, validation, and report storage
export {
  FEEDBACK_TOOL_NAMES,
  FEEDBACK_TOOL_CONTRACTS,
  BugReportSchema,
  ImprovementSuggestionSchema,
  validateFeedbackToolInput,
  generateFeedbackDedupeKey,
  FeedbackReportStore,
} from "./feedback-tools.js";
export type {
  FeedbackToolName,
  FeedbackToolContract,
  BugReportInput,
  ImprovementSuggestionInput,
  FeedbackToolInput,
  PersistedFeedbackReport,
} from "./feedback-tools.js";

// Path utilities — hash-based directory structure
export {
  generateConfigHash,
  generateProjectId,
  generateInstanceId,
  generateSessionPrefix,
  getProjectBaseDir,
  getAoBaseDir,
  getSessionsDir,
  getWorktreesDir,
  getFeedbackReportsDir,
  getObservabilityBaseDir,
  getArchiveDir,
  getOriginFilePath,
  generateSessionName,
  generateTmuxName,
  parseTmuxName,
  expandHome,
  validateAndStoreOrigin,
} from "./paths.js";

// Config generator — auto-generate config from repo URL
export {
  isRepoUrl,
  parseRepoUrl,
  detectScmPlatform,
  detectDefaultBranchFromDir,
  detectProjectInfo,
  generateConfigFromUrl,
  configToYaml,
  isRepoAlreadyCloned,
  resolveCloneTarget,
  sanitizeProjectId,
} from "./config-generator.js";
export type {
  ParsedRepoUrl,
  ScmPlatform,
  DetectedProjectInfo,
  GenerateConfigOptions,
} from "./config-generator.js";

// Webhook ingress — HMAC verification, dedup, and event queue (bd-c9h)
export { WebhookIngress } from "./webhook-ingress.js";
export type { WebhookIngressConfig } from "./webhook-ingress.js";

// MCP agent mail — inter-agent guidance messaging (bd-qm6)
export { AgentMailBridge, formatGuidancePrompt } from "./mcp-mail.js";
export type { AgentMailMessage, AgentMailConfig } from "./mcp-mail.js";

// MCP mail HTTP client — global inbox polling + heartbeat for workers
export {
  initMcpMailClient,
  getMcpMailClientConfig,
  setMcpMailInboxCallback,
  pollMcpMailInbox,
  sendMcpMailHeartbeat,
  sendMcpMailSessionStart,
  sendMcpMailSessionEnd,
} from "./mcp-mail.js";
export type { McpMailClientConfig, InboxMessage, InboxCallback } from "./mcp-mail.js";

// Outcome recorder — persist and query fix strategy outcomes
export { OutcomeRecorder } from "./outcome-recorder.js";
export type { OutcomeRecorderDeps } from "./outcome-recorder.js";

// Merge gate — 6-condition enforcement (bd-nrp)
export { checkMergeGate } from "./merge-gate.js";
export type { MergeGateCheck, MergeGateResult } from "./merge-gate.js";

// Evidence bundle — structured evidence generation and review gate (bd-2gz)
export {
  generateEvidenceBundle,
  reviewEvidenceBundle,
  writeEvidenceBundle,
} from "./evidence-bundle.js";
export type {
  EvidenceBundle,
  CICheckEvidence,
  EvidenceVerdict,
} from "./evidence-bundle.js";

// Parallel retry monitor (bd-tzt)
export { ParallelRetryMonitor } from "./parallel-retry.js";
export type { RaceGroup, RaceEntry } from "./parallel-retry.js";

// Auto-resolve threads — resolve stale review threads after fix push (bd-xj8)
export { autoResolveThreads } from "./auto-resolve-threads.js";
export type {
  AutoResolveConfig,
  AutoResolveResult,
  ResolvedThread,
  SkippedThread,
  ThreadError,
  GraphQLExecutor,
} from "./auto-resolve-threads.js";

// Resilient GraphQL executor — retry + backoff + deferred state (bd-fy7)
export { DeferredGraphQLExecutor, withRetryAndDefer } from "./gh-graphql-defer.js";
export type { DeferredItem, ResilientResult } from "./gh-graphql-defer.js";

// Slack outbox — outbox queue + dead letter handling (bd-sw3)
export { SlackOutbox } from "./slack-outbox.js";
export type { OutboxEntry, OutboxConfig } from "./slack-outbox.js";

// Pattern synthesizer — learn from outcomes (bd-89q)
export {
  PatternSynthesizer,
} from "./pattern-synthesizer.js";
export type {
  SynthesizedPattern,
  PatternStore,
} from "./pattern-synthesizer.js";

// =============================================================================
// FORK-SPECIFIC EXPORTS (extracted from upstream files for isolation)
// =============================================================================

// Reaction context builder (extracted from lifecycle-manager)
export { buildReactionContext } from "./reaction-context.js";

// Gate-closure action plans — deterministic 7-green sequencing
export { buildActionPlan, formatActionPlan, GATE } from "./action-plan.js";
export type { ActionPlan, ActionItem } from "./action-plan.js";

// Session exit proof (extracted from lifecycle-manager)
export { validateAndEmitExitProof, emitExitProofEvent } from "./session-exit-proof.js";
export type { ExitProofDeps } from "./session-exit-proof.js";

// Reaction handlers: request-merge, parallel-retry (extracted from lifecycle-manager)
export { handleRequestMerge, handleParallelRetry } from "./fork-reaction-handlers.js";
export type { ReactionHandlerDeps } from "./fork-reaction-handlers.js";

// AO action audit log — PR mutation attribution (bd-att)
export { logAoAction } from "./ao-action-log.js";
export type { AoAction } from "./ao-action-log.js";

// Review backlog dispatch (extracted from lifecycle-manager)
export { maybeDispatchReviewBacklog } from "./review-backlog.js";
export type { ReviewBacklogDeps } from "./review-backlog.js";

// Shared fork utility: session metadata update helper
export { updateSessionMetadataHelper } from "./fork-utils.js";

// Review judgment policy matrix — objective vs subjective comment classification
export {
  classifyComment,
  judgeCommentBatch,
  hasActionableComments,
  batchSeverityScore,
} from "./review-judgment-matrix.js";
export type { CommentClass, JudgmentResult, CommentBatchJudgment } from "./review-judgment-matrix.js";

// Review SLA tracker — stuck-review SLA with escalation
export {
  evaluateReviewSLA,
  getSLAState,
  recordSLAStart,
  recordSLAEscalation,
  recordSLAWarn,
  clearSLAState,
  DEFAULT_REVIEW_SLA_CONFIG,
} from "./review-sla.js";
export type { ReviewSLAConfig, SLAEvaluation, SLAState } from "./review-sla.js";

// GitHub API headroom tracker — REST-first fallback when GraphQL exhausted
export {
  getHeadroomStatus,
  getOperationHeadroom,
  shouldDeferOperation,
  withRESTFallback,
  invalidateHeadroomCache,
  parseGhRateLimitOutput,
  DEFAULT_HEADROOM_THRESHOLDS,
} from "./gh-headroom.js";
export type { HeadroomStatus, HeadroomThresholds } from "./gh-headroom.js";

// Atomic re-review transaction coordinator
export {
  executeAtomicRereview,
  hasInFlightTransaction,
  abortTransaction,
  getCheckpoint,
} from "./review-atomic-rereview.js";
export type { AtomicRereviewDeps, AtomicRereviewResult, RereviewPhase, RereviewCheckpoint } from "./review-atomic-rereview.js";

// Terminal finalizer guard — PR health check before terminal transition
export {
  runTerminalGuard,
  formatGuardResult,
} from "./terminal-guard.js";
export type { TerminalGuardResult, TerminalGuardBlocker, TerminalGuardDeps } from "./terminal-guard.js";

// No-delta watchdog — detect agent stalls via heartbeat monitoring
export {
  evaluateNoDeltaWatchdog,
  recordDelta,
  recordDeltaWarning,
  recordDeltaStuck,
  emitWatchdogEvent,
  DEFAULT_NO_DELTA_CONFIG,
} from "./no-delta-watchdog.js";
export type { NoDeltaWatchdogConfig, NoDeltaEvaluation, NoDeltaResult, WatchdogEventDeps } from "./no-delta-watchdog.js";

// Review KPI emitter — measurable metrics for CHANGES_REQUESTED stalls
export {
  getReviewKPIs,
  recordCycleStart,
  recordCycleResolved,
  recordStuckReview,
  recordNoDeltaWarning,
  recordSLAEscalation as recordKPISLAEscalation,
  emitKPIEvent,
  buildKPISummary,
  enrichWithCommentJudgment,
} from "./review-kpi.js";
export type { ReviewKPIs, KPIEmitDeps } from "./review-kpi.js";

// Task queue drainer — config-driven bead processing with maxConcurrent (bd-bsu)
export { drainTaskQueue, resolveBead, _resetDrainTimer } from "./task-queue.js";
export type { TaskQueueDeps, TaskQueueParams } from "./task-queue.js";

// Stuck worker detection — deep pane inspection after consecutive idle cycles
export {
  analyzePaneContent,
  checkStuckWorker,
  recordIdleCycle,
  resetIdleCycles,
  resetAllIdleCycles,
  getIdleCycleState,
  DEFAULT_IDLE_CYCLE_THRESHOLD,
  DEFAULT_NUDGE_TEXT,
} from "./stuck-worker-detector.js";
export type {
  StuckAction,
  StuckWorkerVerdict,
  IdleCycleState,
  CheckStuckWorkerOptions,
  CheckStuckWorkerResult,
} from "./stuck-worker-detector.js";

// Fork-only: stalled-worker auditor
export {
  auditStalledWorkers,
  runStalledWorkerAuditor,
  formatEloopCoverageReport,
  sendGapAlert,
} from "./stalled-worker-auditor.js";
export type {
  StalledWorkerRecord,
  EloopCoverageReport,
  StalledWorkerAuditorDeps,
  SendMcpMailOptions,
  SendMcpMailFn,
} from "./stalled-worker-auditor.js";

// Fork-only: productivity-based stall detection
export {
  runProductivityChecks,
  checkMergedPRCleanup,
  checkStallDetection,
  checkContextExhaustion,
} from "./productivity-checker.js";

// Shared worktree-git utilities — used by both core (backfill-extensions) and
// workspace-worktree plugin so the same recovery logic is in one place.
export { findRepoPathForWorktree } from "./utils/worktree-git.js";
export type { RepoPathResult } from "./utils/worktree-git.js";

// Long-running harness artifact schemas — research.md, plan.md, handoff.md
export {
  validateHarnessArtifact,
  validateResearchArtifact,
  validatePlanArtifact,
  validateHandoffArtifact,
  classifyContextUtilization,
  computePlanProgress,
  initContextMonitorState,
  updateContextMonitorState,
  incrementContextResetCount,
  shouldContextReset,
  CONTEXT_THRESHOLDS,
  researchToMarkdown,
  planToMarkdown,
  handoffToMarkdown,
} from "./harness-artifacts.js";
export type {
  ArtifactSection,
  CodeReference,
  ResearchArtifact,
  PlanTodoItem,
  PlanArtifact,
  PlanProgress,
  HandoffArtifact,
  ArtifactValidationResult,
  ContextUtilizationLevel,
  ContextMonitorState,
} from "./harness-artifacts.js";

// Platform adapter — centralized cross-platform branching (cherry-picked upstream #1849)
export {
  isWindows,
  isMac,
  isLinux,
  getDefaultRuntime,
  getNodePtyPrebuildsSubdir,
  getShell,
  killProcessTree,
  findPidByPort,
  getEnvDefaults,
} from "./platform.js";

// Daemon-children registry — orphan reaping on start/stop (cherry-picked upstream #1849)
export {
  registerDaemonChild,
  unregisterDaemonChild,
  getDaemonChildren,
  clearDaemonChildrenRegistry,
  markDaemonShutdownHandlerInstalled,
  registerChildReaper,
  spawnManagedDaemonChild,
  sweepDaemonChildren,
  classifyAoOrphanCommand,
  detectAoOrphansFromPsOutput,
  scanAoOrphans,
  reapAoOrphans,
  type DaemonChildEntry,
  type DaemonChildSweepOptions,
  type DaemonChildSweepResult,
  type AoOrphanProcess,
} from "./daemon-children.js";

// Upstream session header companion (#1981)
export { deriveDisplayName, type DeriveDisplayNameInput } from "./upstream-session-header.js";
// Activity event logging — structured diagnostic event trail (upstream #1528)
export { recordActivityEvent, droppedEventCount } from "./activity-events.js";
export { isActivityEventsFtsEnabled } from "./events-db.js";
export type {
  ActivityEventInput,
  ActivityEventKind,
  ActivityEventSource,
  ActivityEventLevel,
  ActivityEvent,
} from "./activity-events.js";
export {
  queryActivityEvents,
  searchActivityEvents,
  getActivityEventStats,
} from "./query-activity-events.js";
export type { ActivityEventFilter, ActivityEventStats } from "./query-activity-events.js";

// Companion hooks for session-manager and lifecycle-manager activity events
export {
  emitSpawnStarted,
  emitSpawnFailed,
  emitSpawned,
  emitKilled,
} from "./session-activity-events.js";
export {
  emitLifecycleTransition,
  emitActivityTransition,
} from "./lifecycle-activity-events.js";

// Config hot-reload — watch agent-orchestrator.yaml and auto-reload
export {
  startConfigHotReload,
  type ConfigHotReloadOptions,
  type ConfigHotReloadHandle,
} from "./config-hot-reload.js";

// Config env var expansion — ${VAR} and ${VAR:-default} in YAML values
export { expandEnvVars } from "./config-env-expand.js";

// Config reaction validation — warn on missing required fields
export {
  validateReactionDefinitions,
  type ReactionValidationIssue,
} from "./config-reaction-validation.js";

// Plugin load order — topological sort for dependency-first loading
export {
  computeLoadOrder,
  type LoadOrderEntry,
  type PluginDependency,
} from "./plugin-load-order.js";

// Plugin version check — warn on major version mismatch with core
export {
  checkPluginVersionMismatch,
  formatVersionMismatchWarning,
  isCompatibleMajorVersion,
  type VersionMismatchWarning,
} from "./plugin-version-check.js";

// Agent plugin timeout — configurable startup timeout
export {
  resolveAgentStartupTimeout,
  augmentAgentConfigWithTimeout,
  DEFAULT_AGENT_STARTUP_TIMEOUT_MS,
} from "./plugin-agent-timeout.js";

// SCM retry 5xx — retry transient server errors for GitHub API calls
export { withScmRetry, type ScmRetryOptions } from "./scm-retry-5xx.js";
// force coderabbit review
