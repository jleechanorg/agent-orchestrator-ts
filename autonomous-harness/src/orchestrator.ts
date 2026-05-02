/**
 * Autonomous Harness Orchestrator
 *
 * GAN-style generator/evaluator loop driven by file-based handoffs.
 * The orchestrator spawns AO workers for each phase, polls the worktree
 * for artifact/state completion, and advances the state machine.
 *
 * Design: https://github.com/jleechanorg/jleechanclaw/blob/main/papers/experiment_autonomous_harness/technique.md
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, cpSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { z } from "zod";
import { loadConfig, createSessionManager, createPluginRegistry } from "@jleechanorg/ao-core";
import {
  createInitialState,
  nextPhase,
  type HarnessState,
  type Phase,
} from "./harness-state.js";

// ---------------------------------------------------------------------------
// Atomic write — avoids truncated JSON when workers read concurrently
// ---------------------------------------------------------------------------

function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Zod schema for runtime validation of worker-written state files
// ---------------------------------------------------------------------------

const PhaseSchema = z.enum(["research", "plan", "annotation", "implementation", "eval", "done"]);

const HarnessStateSchema = z.object({
  projectPath: z.string(),
  projectName: z.string(),
  currentSprint: z.object({
    sprintNumber: z.number().int().positive(),
    phase: PhaseSchema,
    artifacts: z.record(z.string()),
    startedAt: z.string(),
    updatedAt: z.string(),
    verdict: z.union([z.literal("pass"), z.literal("fail"), z.null()]).optional(),
    evaluatorNotes: z.string().optional(),
  }),
  completedSprints: z.array(z.any()),
  totalSprints: z.number().int().positive(),
  generatorModel: z.string(),
  evaluatorModel: z.string(),
  orchestratorModel: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function safeParseState(raw: unknown): HarnessState | null {
  const result = HarnessStateSchema.safeParse(raw);
  if (!result.success) {
    console.warn("[autonomous-harness] State validation failed:", result.error.message);
    return null;
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// AO Worker spawn via SessionManager API
// ---------------------------------------------------------------------------

export interface SpawnConfig {
  model: string;
  systemPrompt: string;
  taskPrompt: string;
  workspace: string;
  sessionName: string;
  skillRoot?: string;
  evidenceDir?: string;
  runtime?: string;
  projectId?: string;
}

export interface SpawnResult {
  sessionId: string;
  sessionName: string;
  worktreePath: string | null;
}

const TERMINAL_SESSION_STATUSES: ReadonlySet<string> = new Set([
  "done", "terminated", "killed", "errored", "merged", "cleanup",
]);

/**
 * Spawn an AO worker using the SessionManager API (not CLI).
 * Returns the session ID and worktree path (if available).
 *
 * AO creates an isolated git worktree for each session. The worker's CWD
 * is the worktree, not the main project path.
 */
export async function spawnAOWorker(config: SpawnConfig): Promise<SpawnResult> {
  const workspacePath = pathResolve(config.workspace);

  const config_ = loadConfig();
  const projectIds = Object.keys(config_.projects ?? {});

  let projectId = config.projectId;
  if (!projectId || !config_.projects[projectId]) {
    const matchedProjectId = projectIds.find((id) => {
      const proj = config_.projects[id];
      if (!proj?.path) return false;
      return pathResolve(proj.path) === workspacePath;
    });

    if (!matchedProjectId) {
      if (projectIds.length === 1) {
        console.warn(`[autonomous-harness] Workspace ${workspacePath} not in AO config — using default project`);
      } else {
        throw new Error(
          `[autonomous-harness] Project not found in AO config for workspace: ${workspacePath}\n` +
            `Configured projects: ${projectIds.join(", ")}`,
        );
      }
    }
    projectId = matchedProjectId ?? projectIds[0];
  }

  const fullPrompt = `${config.systemPrompt}\n\nTask: ${config.taskPrompt}`;
  const agentPlugin = config.model.split("/")[0];

  const registry = createPluginRegistry();
  await registry.loadBuiltins(config_);
  const sm = await createSessionManager({ config: config_, registry });
  const session = await sm.spawn({
    projectId,
    prompt: fullPrompt,
    agent: agentPlugin,
    runtimeOverride: config.runtime ?? "process",
    skipPrBoilerplate: true,
  });

  return {
    sessionId: session.id,
    sessionName: session.id,
    worktreePath: session.workspacePath ?? null,
  };
}

// ---------------------------------------------------------------------------
// File-based artifact I/O
// ---------------------------------------------------------------------------

export function statePath(workspace: string): string {
  return join(workspace, "harness_state.json");
}

export function artifactPath(workspace: string, sprint: number, artifact: string): string {
  return join(workspace, `sprint_${sprint}`, artifact);
}

export function readState(workspace: string): HarnessState | null {
  const p = statePath(workspace);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    return safeParseState(raw);
  } catch {
    return null;
  }
}

export function writeState(workspace: string, state: HarnessState): void {
  const p = statePath(workspace);
  mkdirSync(workspace, { recursive: true });
  atomicWriteFileSync(p, JSON.stringify(state, null, 2));
}

export function readArtifact(workspace: string, sprint: number, artifact: string): string | null {
  const p = artifactPath(workspace, sprint, artifact);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf-8");
}

export function writeArtifact(
  workspace: string,
  sprint: number,
  artifact: string,
  content: string,
): void {
  const dir = join(workspace, `sprint_${sprint}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, artifact), content, "utf-8");
}

// ---------------------------------------------------------------------------
// Phase prompt builders
//
// Workers run in AO worktrees (separate dirs from the main project).
// Prompts use "." (CWD-relative) paths so workers write artifacts to their
// worktree. The orchestrator copies state to/from the worktree.
// ---------------------------------------------------------------------------

export function buildResearchPrompt(state: HarnessState): string {
  return `You are the Researcher agent for sprint ${state.currentSprint.sprintNumber}.

Research the project files in your current working directory.

Your job:
1. Deep-read ALL existing files — understand the architecture, patterns, and constraints
2. Write a research.md file (>50 lines) with the tag "research"
3. If research is wrong, the plan is wrong, implementation is wrong

Output: Write ./sprint_${state.currentSprint.sprintNumber}/research.md

After completing research, update the harness state file ./harness_state.json:
Set currentSprint.phase to "plan" and currentSprint.artifacts.researchMd to "sprint_${state.currentSprint.sprintNumber}/research.md".
Set currentSprint.updatedAt to current ISO timestamp.`;
}

export function buildPlanPrompt(state: HarnessState): string {
  return `You are the Strategist agent for sprint ${state.currentSprint.sprintNumber}.

Read: ./sprint_${state.currentSprint.sprintNumber}/research.md

Your job:
1. Write a full spec.md covering all functionality
2. Write a plan.md with feature breakdown and priorities

Output paths:
- ./sprint_${state.currentSprint.sprintNumber}/spec.md
- ./sprint_${state.currentSprint.sprintNumber}/plan.md

After completing the plan, update ./harness_state.json:
Set currentSprint.phase to "annotation" and currentSprint.artifacts.specMd + planMd to their paths.
Set currentSprint.updatedAt to current ISO timestamp.`;
}

export function buildAnnotationPrompt(state: HarnessState): string {
  return `You are the Reviewer agent for sprint ${state.currentSprint.sprintNumber}.

Read: ./sprint_${state.currentSprint.sprintNumber}/plan.md

Your job:
1. Review the plan for completeness and correctness
2. Write a plan_review.md summarizing your review
3. Write sprint_contract.md with agreed "done" criteria

Output paths:
- ./sprint_${state.currentSprint.sprintNumber}/plan_review.md
- ./sprint_${state.currentSprint.sprintNumber}/sprint_contract.md

After completing review, update ./harness_state.json:
Set currentSprint.phase to "implementation" and currentSprint.artifacts.planReviewMd + sprintContractMd.
Set currentSprint.updatedAt to current ISO timestamp.`;
}

export function buildImplementationPrompt(state: HarnessState): string {
  return `You are the Generator agent for sprint ${state.currentSprint.sprintNumber}.

Read: ./sprint_${state.currentSprint.sprintNumber}/sprint_contract.md

Implement the full sprint per the contract. When done:
1. Mark each completed task in the plan document
2. Write a sprint_${state.currentSprint.sprintNumber}_report.md with what was built + self-eval
3. Do NOT add unnecessary comments or jsdocs
4. Do NOT use any or unknown types
5. Continuously run typecheck

Output: ./sprint_${state.currentSprint.sprintNumber}/sprint_report.md

After implementation, update ./harness_state.json:
Set currentSprint.phase to "eval".
Set currentSprint.artifacts.sprintReportMd.
Set currentSprint.updatedAt to current ISO timestamp.`;
}

export function buildEvaluatorPrompt(state: HarnessState): string {
  return `You are the Evaluator agent for sprint ${state.currentSprint.sprintNumber}.

Judge the sprint using EVIDENCE + QUALITY dual verdict:

EVIDENCE: Did the generator produce the promised artifacts?
QUALITY: Score 1-10 on:
  1. Correctness (0.25 weight) — does it solve the problem?
  2. Code quality (0.25 weight) — no any/unknown types, clean structure
  3. Test coverage (0.20 weight) — real tests, not mocks
  4. Documentation (0.15 weight) — clear why, not when/ticket
  5. Design compliance (0.15 weight) — follows sprint_contract.md

Final score = 0.7 × rubric + 0.3 × diff_similarity
Diff similarity = 1 - (lines_changed / 1000)

Read the sprint report: ./sprint_${state.currentSprint.sprintNumber}/sprint_report.md

Output: ./sprint_${state.currentSprint.sprintNumber}/sprint_eval.md

If score >= 7 and EVIDENCE pass → verdict: "pass"
Otherwise → verdict: "fail"

After evaluation, update ./harness_state.json:
Set currentSprint.phase to "done", currentSprint.verdict, currentSprint.evaluatorNotes.
Set currentSprint.updatedAt to current ISO timestamp.

IMPORTANT: When the eval phase is complete, set currentSprint.phase to "done" to signal the
orchestrator that the sprint is finished. Do not leave phase as "eval".`;
}

export function buildPromptForPhase(state: HarnessState): string {
  switch (state.currentSprint.phase) {
    case "research": return buildResearchPrompt(state);
    case "plan": return buildPlanPrompt(state);
    case "annotation": return buildAnnotationPrompt(state);
    case "implementation": return buildImplementationPrompt(state);
    case "eval": return buildEvaluatorPrompt(state);
    default: throw new Error(`No prompt for phase: ${state.currentSprint.phase}`);
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator loop
// ---------------------------------------------------------------------------

export interface RunOptions {
  projectPath: string;
  projectId: string;
  projectName: string;
  totalSprints?: number;
  generatorModel?: string;
  evaluatorModel?: string;
  orchestratorModel?: string;
  skillRoot?: string;
  maxIterationsPerPhase?: number;
  runtime?: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll AO session status until it reaches a terminal state.
 * This is more reliable than file-based state polling because workers
 * are LLM agents that may or may not update harness_state.json.
 */
async function pollSessionUntilComplete(
  projectId: string,
  sessionId: string,
  maxIterations: number,
  pollIntervalMs = 30_000, // 30s between polls
): Promise<{ status: string; activity: string | null }> {
  const config_ = loadConfig();
  const registry = createPluginRegistry();
  await registry.loadBuiltins(config_);
  const sm = await createSessionManager({ config: config_, registry });

  for (let i = 0; i < maxIterations; i++) {
    await sleep(pollIntervalMs);

    try {
      const sessions = await sm.list(projectId);
      const session = sessions.find((s: { id: string }) => s.id === sessionId);

      if (!session) {
        console.log(`[autonomous-harness] Session ${sessionId} not found in list — may have been cleaned up`);
        return { status: "terminated", activity: null };
      }

      const status = session.status as string;
      const activity = session.activity as string | null;

      if (TERMINAL_SESSION_STATUSES.has(status)) {
        console.log(`[autonomous-harness] Session ${sessionId} reached terminal status: ${status}`);
        return { status, activity };
      }

      console.log(`[autonomous-harness] Poll ${i + 1}/${maxIterations}: session ${sessionId} status=${status} activity=${activity ?? "unknown"}`);
    } catch (err) {
      console.warn(`[autonomous-harness] Poll ${i + 1}/${maxIterations}: error checking session: ${err}`);
    }
  }

  console.warn(`[autonomous-harness] Session ${sessionId} did not complete within max polls`);
  return { status: "unknown", activity: null };
}

export async function runAutonomousHarness(opts: RunOptions): Promise<HarnessState> {
  const {
    projectPath,
    projectId,
    projectName,
    totalSprints = 1,
    generatorModel = "minimax/MiniMax-M2.7",
    evaluatorModel = "minimax/MiniMax-M2.7",
    orchestratorModel = "minimax/MiniMax-M2.7",
    skillRoot,
    maxIterationsPerPhase = 40, // 40 × 30s = 20 min per phase
    runtime,
  } = opts;

  // Initialize or resume state
  let state = readState(projectPath);
  if (!state) {
    state = createInitialState(projectPath, projectName, totalSprints, generatorModel, evaluatorModel, orchestratorModel);
    writeState(projectPath, state);
  }

  console.log(`[autonomous-harness] Starting loop for ${projectId}/${projectName} sprint ${state.currentSprint.sprintNumber} phase: ${state.currentSprint.phase}`);

  while (state.currentSprint.phase !== "done") {
    const phase = state.currentSprint.phase;
    const sprint = state.currentSprint.sprintNumber;

    console.log(`[autonomous-harness] Sprint ${sprint} Phase: ${phase}`);

    const taskPrompt = buildPromptForPhase(state);

    const model = phase === "eval" || phase === "annotation"
      ? evaluatorModel
      : generatorModel;

    // Spawn worker — AO creates a worktree and runs the worker there
    const result = await spawnAOWorker({
      model,
      systemPrompt: getSystemPromptForPhase(phase),
      taskPrompt,
      workspace: projectPath,
      sessionName: `autonomous-${projectId}-s${sprint}-${phase}-${Date.now()}`,
      skillRoot,
      runtime,
      projectId,
    });

    const worktreePath = result.worktreePath;
    console.log(`[autonomous-harness] Worker spawned: ${result.sessionName} worktree: ${worktreePath ?? "unknown"}`);

    // Copy state file into the worktree so the worker can read current state
    if (worktreePath && existsSync(statePath(projectPath))) {
      try {
        cpSync(statePath(projectPath), statePath(worktreePath), { force: true });
        console.log(`[autonomous-harness] State copied to worktree: ${statePath(worktreePath)}`);
      } catch (err) {
        console.warn(`[autonomous-harness] Failed to copy state to worktree: ${err}`);
      }
    }

    console.log(`[autonomous-harness] Waiting for session ${result.sessionName} to complete (max ${maxIterationsPerPhase} × 30s)`);

    // Poll session status until terminal
    const sessionResult = await pollSessionUntilComplete(
      projectId,
      result.sessionId,
      maxIterationsPerPhase,
    );

    console.log(`[autonomous-harness] Session ${result.sessionName} ended with status: ${sessionResult.status}`);

    // Check if the worker updated harness_state.json in the worktree
    let stateUpdated = false;
    if (worktreePath) {
      const worktreeState = readState(worktreePath);
      if (worktreeState && worktreeState.currentSprint.phase !== phase) {
        state = worktreeState;
        stateUpdated = true;
        console.log(`[autonomous-harness] State advanced to ${state.currentSprint.phase} via worktree`);
      }
    }

    // Also check main project path
    if (!stateUpdated) {
      const mainState = readState(projectPath);
      if (mainState && mainState.currentSprint.phase !== phase) {
        state = mainState;
        stateUpdated = true;
        console.log(`[autonomous-harness] State advanced to ${state.currentSprint.phase} via main project`);
      }
    }

    if (!stateUpdated) {
      // Worker stalled — advance phase and let the next loop iteration pick up the new phase
      console.warn(`[autonomous-harness] Phase ${phase}: worker did not advance state — advancing manually`);
      state = nextPhase(state);
    }

    // Persist current state
    writeState(projectPath, state);

    // Copy artifacts from worktree back to main project if they exist
    if (worktreePath) {
      const sprintDir = join(worktreePath, `sprint_${sprint}`);
      const mainSprintDir = join(projectPath, `sprint_${sprint}`);
      if (existsSync(sprintDir) && !existsSync(mainSprintDir)) {
        try {
          cpSync(sprintDir, mainSprintDir, { recursive: true });
          console.log(`[autonomous-harness] Artifacts copied from worktree to ${mainSprintDir}`);
        } catch (err) {
          console.warn(`[autonomous-harness] Failed to copy artifacts: ${err}`);
        }
      }
    }
  }

  console.log(`[autonomous-harness] All sprints complete. ${state.completedSprints.length}/${state.totalSprints} done.`);
  return state;
}

// ---------------------------------------------------------------------------
// System prompts per phase (minimal — actual logic is in task prompts)
// ---------------------------------------------------------------------------

function getSystemPromptForPhase(phase: Phase): string {
  switch (phase) {
    case "research":
      return "You are a Researcher agent. Deep-read all project files and produce a detailed research.md artifact.";
    case "plan":
      return "You are a Strategist agent. Produce spec.md and plan.md from the research artifact.";
    case "annotation":
      return "You are a Reviewer agent. Annotate the plan, negotiate a sprint contract.";
    case "implementation":
      return "You are a Generator agent. Implement per the sprint contract, then self-evaluate.";
    case "eval":
      return "You are an Evaluator agent. Judge EVIDENCE + QUALITY, produce dual verdict. When done, set phase to 'done'.";
    default:
      return "You are an autonomous agent.";
  }
}
