/**
 * Long-running harness artifact schemas.
 *
 * Defines the structured types for research.md, plan.md, and handoff.md artifacts
 * that carry context across agent sessions during context resets.
 *
 * Architecture:
 * - Artifacts are written to the worktree by the outgoing agent
 * - Incoming agents read the artifact to resume without re-research
 * - `context-reset-manager.ts` owns the lifecycle (write trigger, reload logic)
 *
 * Reference: roadmap/nextsteps-2026-05-02-long-running-harness-design.md
 */

// =============================================================================
// SHARED FOUNDATION
// =============================================================================

/** ISO 8601 timestamp with timezone (RFC 3339, e.g. "2026-05-07T10:30:00Z") */
export type IsoTimestamp = string;

/** Non-empty string with trim guard */
export type NonEmptyStr = string & { __brand: "non-empty" };

/** Verifies a string is non-empty after trim */
function assertNonEmpty(label: string, value: unknown): asserts value is NonEmptyStr {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

/** Verifies a value is a valid ISO timestamp */
function assertIsoTimestamp(label: string, value: unknown): asserts value is IsoTimestamp {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const d = Date.parse(value);
  if (Number.isNaN(d)) throw new TypeError(`${label} must be a valid ISO timestamp, got: ${value}`);
}

/** A single markdown section with a heading and body */
export interface ArtifactSection {
  /** Section heading (e.g. "Codebase Understanding") */
  heading: NonEmptyStr;
  /** Section body — can contain markdown, code blocks, lists */
  body: string;
}

/** Reference to a file studied or code snippet used */
export interface CodeReference {
  path: string;
  reason: string;
  /** Line range if applicable, e.g. "42-67" */
  range?: string;
}

// =============================================================================
// RESEARCH ARTIFACT
// =============================================================================

/**
 * research.md — deep codebase findings before planning begins.
 *
 * Produced by: Research Agent (Sonnet)
 * Consumed by: Planner/Advisor (Opus), Generator (Haiku/Sonnet)
 *
 * Schema sections:
 * - Date + agent metadata
 * - Codebase understanding (deep-read findings)
 * - Constraints (patterns, conventions, limitations)
 * - Potential issues (bugs, risky areas)
 * - References (files studied, code snippets)
 */
export interface ResearchArtifact {
  /** Always "research" for type discrimination */
  readonly artifactType: "research";
  /** Feature or task name this research is for */
  readonly featureName: NonEmptyStr;
  /** When the research session began (RFC 3339) */
  readonly sessionStartedAt: IsoTimestamp;
  /** When the research was finalized (RFC 3339) */
  readonly completedAt: IsoTimestamp;
  /** Model used for research */
  readonly model?: string;
  /** Codebase sections studied */
  readonly sections: ArtifactSection[];
  /** Constraints discovered during research */
  readonly constraints: ArtifactSection[];
  /** Potential issues or risky areas identified */
  readonly potentialIssues: ArtifactSection[];
  /** Files and code snippets referenced */
  readonly references: CodeReference[];
  /**
   * Open questions that planner should address.
   * These block implementation — planner must resolve or flag.
   */
  readonly openQuestions: Array<{ question: NonEmptyStr; context: string }>;
  /** Breadcrumb trail for multi-session research (agent session IDs) */
  readonly priorSessions?: string[];
}

// =============================================================================
// PLAN ARTIFACT
// =============================================================================

/** A single todo item in the plan */
export interface PlanTodoItem {
  /** Unique identifier for cross-referencing (e.g. "task-1", "phase-2-subtask-3") */
  readonly id: string;
  /** Human-readable description of the task */
  readonly description: NonEmptyStr;
  /** Current status */
  readonly status: "pending" | "in_progress" | "completed" | "skipped";
  /** File paths this task will modify (relative paths) */
  readonly files?: string[];
  /** Dependency: id of task that must complete before this one */
  readonly dependsOn?: string[];
  /** Note about ordering constraint or context */
  readonly note?: string;
}

/**
 * plan.md — detailed implementation plan with todo list.
 *
 * Produced by: Planner/Advisor (Opus)
 * Consumed by: Generator (Haiku/Sonnet), Evaluator (Skeptic)
 *
 * Schema sections:
 * - Overview (what + why)
 * - Approach (code snippets, file paths, trade-offs)
 * - Todo list (granular tasks)
 * - Grading criteria (what "done" looks like)
 * - Open questions (things to decide)
 */
export interface PlanArtifact {
  /** Always "plan" for type discrimination */
  readonly artifactType: "plan";
  /** Feature or task name */
  readonly featureName: NonEmptyStr;
  /** When the plan was written (RFC 3339) */
  readonly createdAt: IsoTimestamp;
  /** When the plan was last updated (RFC 3339) */
  readonly updatedAt: IsoTimestamp;
  /** Model used for planning */
  readonly model?: string;
  /** Human-readable overview */
  readonly overview: NonEmptyStr;
  /** Implementation approach sections */
  readonly approach: ArtifactSection[];
  /** Granular task breakdown — ordered for sequential execution */
  readonly todos: PlanTodoItem[];
  /**
   * Grading criteria for evaluator.
   * Maps criterion name → description of what earns full marks.
   */
  readonly gradingCriteria: Array<{ criterion: NonEmptyStr; description: string; weight?: number }>;
  /** Open questions — things the planner couldn't resolve */
  readonly openQuestions: Array<{ question: NonEmptyStr; context: string; resolved?: boolean }>;
  /** If annotated by human or prior agent: inline notes keyed by approach section heading */
  readonly annotations?: Record<string, string>;
  /** PR number this plan targets (if known) */
  readonly targetPr?: number;
  /** Branch name */
  readonly targetBranch?: string;
  /** Breadcrumb: research artifact session that preceded this plan */
  readonly researchSessionId?: string;
}

/** Progress summary for a plan — used in handoff */
export interface PlanProgress {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  skipped: number;
}

/** Computes progress stats from a plan's todo list */
export function computePlanProgress(todos: PlanTodoItem[]): PlanProgress {
  return {
    total: todos.length,
    completed: todos.filter((t) => t.status === "completed").length,
    inProgress: todos.filter((t) => t.status === "in_progress").length,
    pending: todos.filter((t) => t.status === "pending").length,
    skipped: todos.filter((t) => t.status === "skipped").length,
  };
}

// =============================================================================
// HANDOFF ARTIFACT
// =============================================================================

/**
 * handoff.md — state snapshot for context reset.
 *
 * Produced by: Generator (when context reset triggered)
 * Consumed by: next Generator session (after context reset)
 *
 * Schema sections:
 * - Session resume point (last completed item)
 * - Next steps (remaining todo items)
 * - Current state (what's been built so far)
 * - Open issues (evaluator critiques not yet addressed)
 * - Context notes (anything the next agent needs to know)
 *
 * This artifact is written to the worktree so a fresh agent can resume
 * without re-reading the full plan or repeating prior work.
 */
export interface HandoffArtifact {
  /** Always "handoff" for type discrimination */
  readonly artifactType: "handoff";
  /** Feature or task name */
  readonly featureName: NonEmptyStr;
  /** When this handoff was created (RFC 3339) */
  readonly createdAt: IsoTimestamp;
  /** Why a context reset was triggered */
  readonly triggerReason: NonEmptyStr;
  /** Context utilization percentage at trigger time */
  readonly contextUtilizationPct: number;
  /** ID of the session that produced this handoff */
  readonly originatingSessionId: string;
  /** ID of the session that should resume from this handoff (set on creation) */
  readonly targetSessionId?: string;
  /** ID of the plan artifact this handoff extends */
  readonly planSessionId?: string;
  /** ID of the research artifact this handoff extends */
  readonly researchSessionId?: string;
  /** The next todo item to work on (first non-completed, non-skipped) */
  readonly nextTodoId: string;
  /** Description of what to work on next */
  readonly nextStepDescription: NonEmptyStr;
  /** Current state of the codebase (files changed, key facts) */
  readonly currentState: ArtifactSection[];
  /**
   * Evaluator critiques or issues still open.
   * Resolving these is the first order of business.
   */
  readonly openIssues: ArtifactSection[];
  /** Notes the next agent needs that won't be obvious from code */
  readonly contextNotes: ArtifactSection[];
  /** Reset counter — how many context resets have occurred in this session chain */
  readonly resetCount: number;
  /** Max resets allowed before escalating (e.g. to human review) */
  readonly maxResets?: number;
  /** Any error or interruption that caused this handoff */
  readonly interruptionInfo?: {
    reason: string;
    lastCompletedTodo?: string;
    errorMessage?: string;
  };
}

// =============================================================================
// VALIDATION
// =============================================================================

/** Result of artifact validation */
export interface ArtifactValidationResult {
  readonly valid: boolean;
  readonly errors: string[];
  readonly artifactType: string;
}

/** Validates a research artifact */
export function validateResearchArtifact(artifact: unknown): ArtifactValidationResult {
  const errors: string[] = [];
  if (!artifact || typeof artifact !== "object") {
    return { valid: false, errors: ["must be an object"], artifactType: "unknown" };
  }
  const a = artifact as Record<string, unknown>;
  if (a["artifactType"] !== "research") {
    errors.push(`artifactType must be "research", got: ${a["artifactType"]}`);
  }
  try {
    assertNonEmpty("featureName", a["featureName"]);
  } catch {
    errors.push("featureName must be a non-empty string");
  }
  try {
    assertIsoTimestamp("sessionStartedAt", a["sessionStartedAt"]);
  } catch {
    errors.push("sessionStartedAt must be a valid ISO timestamp");
  }
  try {
    assertIsoTimestamp("completedAt", a["completedAt"]);
  } catch {
    errors.push("completedAt must be a valid ISO timestamp");
  }
  return { valid: errors.length === 0, errors, artifactType: "research" };
}

/** Validates a plan artifact */
export function validatePlanArtifact(artifact: unknown): ArtifactValidationResult {
  const errors: string[] = [];
  if (!artifact || typeof artifact !== "object") {
    return { valid: false, errors: ["must be an object"], artifactType: "unknown" };
  }
  const a = artifact as Record<string, unknown>;
  if (a["artifactType"] !== "plan") {
    errors.push(`artifactType must be "plan", got: ${a["artifactType"]}`);
  }
  try {
    assertNonEmpty("featureName", a["featureName"]);
  } catch {
    errors.push("featureName must be a non-empty string");
  }
  try {
    assertNonEmpty("overview", a["overview"]);
  } catch {
    errors.push("overview must be a non-empty string");
  }
  try {
    assertIsoTimestamp("createdAt", a["createdAt"]);
  } catch {
    errors.push("createdAt must be a valid ISO timestamp");
  }
  try {
    assertIsoTimestamp("updatedAt", a["updatedAt"]);
  } catch {
    errors.push("updatedAt must be a valid ISO timestamp");
  }
  if (!Array.isArray(a["todos"])) {
    errors.push("todos must be an array");
  } else {
    const seenIds = new Set<string>();
    for (let i = 0; i < a["todos"].length; i++) {
      const todo = a["todos"][i] as Record<string, unknown>;
      if (!todo["id"] || typeof todo["id"] !== "string") {
        errors.push(`todos[${i}]: id must be a string`);
      } else if (seenIds.has(todo["id"])) {
        errors.push(`todos[${i}]: duplicate id "${todo["id"]}"`);
      } else {
        seenIds.add(todo["id"]);
      }
      if (!todo["description"] || typeof todo["description"] !== "string") {
        errors.push(`todos[${i}]: description must be a non-empty string`);
      }
      const validStatuses = new Set(["pending", "in_progress", "completed", "skipped"]);
      if (!validStatuses.has(todo["status"] as string)) {
        errors.push(`todos[${i}]: status must be one of pending, in_progress, completed, skipped`);
      }
      if (todo["dependsOn"]) {
        if (!Array.isArray(todo["dependsOn"])) {
          errors.push(`todos[${i}]: dependsOn must be an array`);
        }
        // Forward references (dependsOn pointing to a todo not yet validated) are
        // allowed here — the plan author may reference a later task intentionally.
        // Downstream logic should handle cycles or dangling references at runtime.
      }
    }
  }
  return { valid: errors.length === 0, errors, artifactType: "plan" };
}

/** Validates a handoff artifact */
export function validateHandoffArtifact(artifact: unknown): ArtifactValidationResult {
  const errors: string[] = [];
  if (!artifact || typeof artifact !== "object") {
    return { valid: false, errors: ["must be an object"], artifactType: "unknown" };
  }
  const a = artifact as Record<string, unknown>;
  if (a["artifactType"] !== "handoff") {
    errors.push(`artifactType must be "handoff", got: ${a["artifactType"]}`);
  }
  try {
    assertNonEmpty("featureName", a["featureName"]);
  } catch {
    errors.push("featureName must be a non-empty string");
  }
  try {
    assertIsoTimestamp("createdAt", a["createdAt"]);
  } catch {
    errors.push("createdAt must be a valid ISO timestamp");
  }
  try {
    assertNonEmpty("triggerReason", a["triggerReason"]);
  } catch {
    errors.push("triggerReason must be a non-empty string");
  }
  try {
    assertNonEmpty("nextStepDescription", a["nextStepDescription"]);
  } catch {
    errors.push("nextStepDescription must be a non-empty string");
  }
  const util = a["contextUtilizationPct"];
  if (typeof util !== "number" || util < 0 || util > 100) {
    errors.push("contextUtilizationPct must be a number between 0 and 100");
  }
  return { valid: errors.length === 0, errors, artifactType: "handoff" };
}

/**
 * Validates any harness artifact (research, plan, or handoff).
 * Returns the appropriate validation result or an error for unknown types.
 */
export function validateHarnessArtifact(artifact: unknown): ArtifactValidationResult {
  if (!artifact || typeof artifact !== "object") {
    return { valid: false, errors: ["must be an object"], artifactType: "unknown" };
  }
  const a = artifact as Record<string, unknown>;
  const type = a["artifactType"];
  switch (type) {
    case "research":
      return validateResearchArtifact(artifact);
    case "plan":
      return validatePlanArtifact(artifact);
    case "handoff":
      return validateHandoffArtifact(artifact);
    default:
      return { valid: false, errors: [`unknown artifactType: ${type}`], artifactType: String(type) };
  }
}

// =============================================================================
// SERIALIZATION
// =============================================================================

/**
 * Converts a ResearchArtifact to markdown for writing to research.md.
 */
export function researchToMarkdown(artifact: ResearchArtifact): string {
  const lines: string[] = [
    `# Research: ${artifact.featureName}`,
    "",
    `## Date`,
    `Started: ${artifact.sessionStartedAt}`,
    `Completed: ${artifact.completedAt}`,
    artifact.model ? `Model: ${artifact.model}` : "",
    "",
    `## Codebase Understanding`,
  ];
  for (const s of artifact.sections) {
    lines.push(`### ${s.heading}`);
    lines.push(s.body);
    lines.push("");
  }
  lines.push("## Constraints");
  for (const s of artifact.constraints) {
    lines.push(`### ${s.heading}`);
    lines.push(s.body);
    lines.push("");
  }
  if (artifact.potentialIssues.length > 0) {
    lines.push("## Potential Issues");
    for (const s of artifact.potentialIssues) {
      lines.push(`### ${s.heading}`);
      lines.push(s.body);
      lines.push("");
    }
  }
  if (artifact.references.length > 0) {
    lines.push("## References");
    for (const ref of artifact.references) {
      lines.push(`- \`${ref.path}\` — ${ref.reason}${ref.range ? ` (${ref.range})` : ""}`);
    }
    lines.push("");
  }
  if (artifact.openQuestions.length > 0) {
    lines.push("## Open Questions");
    for (const q of artifact.openQuestions) {
      lines.push(`- **${q.question}**: ${q.context}`);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n\n\n+/g, "\n\n");
}

/**
 * Converts a PlanArtifact to markdown for writing to plan.md.
 */
export function planToMarkdown(artifact: PlanArtifact): string {
  const lines: string[] = [
    `# Plan: ${artifact.featureName}`,
    "",
    `**Created**: ${artifact.createdAt}`,
    `**Updated**: ${artifact.updatedAt}`,
    artifact.model ? `**Model**: ${artifact.model}` : "",
    "",
    `## Overview`,
    artifact.overview,
    "",
    `## Approach`,
  ];
  for (const s of artifact.approach) {
    lines.push(`### ${s.heading}`);
    lines.push(s.body);
    lines.push("");
  }
  lines.push("## Todo List");
  for (const todo of artifact.todos) {
    const checkbox = todo.status === "completed" ? "[x]" : todo.status === "skipped" ? "[s]" : todo.status === "in_progress" ? "[>]" : "[ ]";
    const dep = todo.dependsOn?.length ? ` (depends on: ${todo.dependsOn.join(", ")})` : "";
    const note = todo.note ? ` [[${todo.note}]]` : "";
    lines.push(`- ${checkbox} \`${todo.id}\`: ${todo.description}${dep}${note}`);
    if (todo.files?.length) {
      lines.push(`  - files: ${todo.files.join(", ")}`);
    }
  }
  lines.push("");
  if (artifact.gradingCriteria.length > 0) {
    lines.push("## Grading Criteria");
    for (const g of artifact.gradingCriteria) {
      const weight = g.weight !== undefined ? ` (${g.weight}%)` : "";
      lines.push(`- **${g.criterion}**${weight}: ${g.description}`);
    }
    lines.push("");
  }
  if (artifact.openQuestions.length > 0) {
    lines.push("## Open Questions");
    for (const q of artifact.openQuestions) {
      const resolved = q.resolved ? " ✅" : "";
      lines.push(`- **${q.question}**${resolved}: ${q.context}`);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n\n\n+/g, "\n\n");
}

/**
 * Converts a HandoffArtifact to markdown for writing to handoff.md.
 */
export function handoffToMarkdown(artifact: HandoffArtifact): string {
  const lines: string[] = [
    `# Handoff: ${artifact.featureName}`,
    "",
    `**Created**: ${artifact.createdAt}`,
    `**Trigger**: ${artifact.triggerReason} (${artifact.contextUtilizationPct}% context used)`,
    `**Reset**: #${artifact.resetCount}${artifact.maxResets ? ` / ${artifact.maxResets} max` : ""}`,
    artifact.originatingSessionId ? `**From session**: ${artifact.originatingSessionId}` : "",
    artifact.targetSessionId ? `**To session**: ${artifact.targetSessionId}` : "",
    "",
    `## Session Resume Point`,
    `**Next todo**: \`${artifact.nextTodoId}\` — ${artifact.nextStepDescription}`,
    "",
    `## Current State`,
  ];
  for (const s of artifact.currentState) {
    lines.push(`### ${s.heading}`);
    lines.push(s.body);
    lines.push("");
  }
  if (artifact.openIssues.length > 0) {
    lines.push("## Open Issues");
    for (const s of artifact.openIssues) {
      lines.push(`### ${s.heading}`);
      lines.push(s.body);
      lines.push("");
    }
  }
  if (artifact.contextNotes.length > 0) {
    lines.push("## Context Notes");
    for (const s of artifact.contextNotes) {
      lines.push(`### ${s.heading}`);
      lines.push(s.body);
      lines.push("");
    }
  }
  if (artifact.interruptionInfo) {
    lines.push("## Interruption");
    if (artifact.interruptionInfo.reason) lines.push(`Reason: ${artifact.interruptionInfo.reason}`);
    if (artifact.interruptionInfo.lastCompletedTodo) {
      lines.push(`Last completed: ${artifact.interruptionInfo.lastCompletedTodo}`);
    }
    if (artifact.interruptionInfo.errorMessage) {
      lines.push(`Error: \`${artifact.interruptionInfo.errorMessage}\``);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n\n\n+/g, "\n\n");
}

// =============================================================================
// CONTEXT RESET TRIGGER
// =============================================================================

/**
 * Context utilization thresholds.
 *
 * The 70% threshold is based on the long-running harness design doc:
 * "When context window hits threshold, reset executor with handoff artifact."
 * 70% gives enough runway for the last chunk of work while ensuring
 * the handoff artifact is written before coherence degrades.
 */
export const CONTEXT_THRESHOLDS = {
  /** Context utilization (%) that triggers a reset warning */
  WARNING_PCT: 60,
  /** Context utilization (%) that triggers a full reset */
  RESET_TRIGGER_PCT: 70,
  /** Maximum number of resets allowed before escalating to human review */
  DEFAULT_MAX_RESETS: 5,
} as const;

export type ContextUtilizationLevel = "nominal" | "warning" | "trigger" | "critical";

/**
 * Classifies context utilization into a level for decision-making.
 */
export function classifyContextUtilization(pct: number): ContextUtilizationLevel {
  if (pct >= 90) return "critical";
  if (pct >= CONTEXT_THRESHOLDS.RESET_TRIGGER_PCT) return "trigger";
  if (pct >= CONTEXT_THRESHOLDS.WARNING_PCT) return "warning";
  return "nominal";
}

/** Context state snapshot — tracks the fields written by init/update helpers */
export interface ContextMonitorState {
  /** Population percentage, e.g. 71 */
  contextUtilizationPct: string;
  /** Raw unrounded value, e.g. "69.60" */
  contextUtilizationRaw?: string;
  /** Utilization band for decision-making */
  contextLevel: ContextUtilizationLevel;
  /** How many resets have occurred */
  contextResetCount: string;
  /** ISO timestamp of last sample */
  contextLastRecorded: string;
}

/**
 * Builds initial context monitor metadata for a new session.
 * Call this when a session is spawned to initialize tracking state.
 */
export function initContextMonitorState(): Record<string, string> {
  const now = new Date().toISOString();
  return {
    contextUtilizationPct: "0",
    contextResetCount: "0",
    contextLastRecorded: now,
    contextLevel: "nominal",
  };
}

/**
 * Updates session metadata with new context utilization.
 * Returns the updated metadata fields (caller writes to session.metadata).
 */
export function updateContextMonitorState(
  current: Record<string, string>,
  utilizationPct: number,
): Record<string, string> {
  const level = classifyContextUtilization(utilizationPct);
  const now = new Date().toISOString();
  const resetCount = Number(current["contextResetCount"] ?? "0");
  return {
    ...current,
    contextUtilizationPct: String(Math.round(utilizationPct)),
    contextUtilizationRaw: String(utilizationPct.toFixed(2)),
    contextLevel: level,
    contextLastRecorded: now,
    contextResetCount: String(resetCount),
  };
}

/**
 * Increments the reset counter after a context reset occurs.
 * Returns the updated metadata fields.
 */
export function incrementContextResetCount(current: Record<string, string>): Record<string, string> {
  const resetCount = Number(current["contextResetCount"] ?? "0") + 1;
  return { ...current, contextResetCount: String(resetCount) };
}

/**
 * Checks whether context reset should trigger based on current state.
 *
 * Returns an object with:
 * - shouldTrigger: true if a reset should occur now
 * - level: current utilization level
 * - resetCount: number of resets so far
 * - maxResets: maximum allowed resets
 * - reason: human-readable reason for the decision
 */
export function shouldContextReset(
  current: Record<string, string>,
  maxResets = CONTEXT_THRESHOLDS.DEFAULT_MAX_RESETS,
): { shouldTrigger: boolean; level: ContextUtilizationLevel; resetCount: number; maxResets: number; reason: string } {
  const resetCount = Number(current["contextResetCount"] ?? "0");
  // Prefer stored contextLevel (computed from raw float at sample time) over
  // recomputing from rounded contextUtilizationPct — avoids false triggers when
  // 69.6 was stored as "70" (rounded) but classified as "warning".
  const storedLevel = current["contextLevel"] as ContextUtilizationLevel | undefined;
  const utilizationPct = Number(current["contextUtilizationPct"] ?? "0");
  const level = (storedLevel && ["nominal", "warning", "trigger", "critical"].includes(storedLevel))
    ? storedLevel
    : classifyContextUtilization(utilizationPct);

  const rawPct = current["contextUtilizationRaw"] ?? `${utilizationPct}`;

  if (resetCount >= maxResets) {
    return { shouldTrigger: false, level, resetCount, maxResets, reason: "max resets reached" };
  }

  if (level === "critical") {
    return { shouldTrigger: true, level, resetCount, maxResets, reason: `critical utilization (${rawPct}%)` };
  }
  if (level === "trigger") {
    return { shouldTrigger: true, level, resetCount, maxResets, reason: `trigger threshold hit (${rawPct}%)` };
  }

  return { shouldTrigger: false, level, resetCount, maxResets, reason: `nominal/warning (${rawPct}%)` };
}