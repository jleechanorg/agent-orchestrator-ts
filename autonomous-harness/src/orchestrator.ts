/**
 * Autonomous Harness Orchestrator
 *
 * GAN-style generator/evaluator loop driven by file-based handoffs.
 * The orchestrator spawns AO workers for each phase, polls the worktree
 * for artifact/state completion, and advances the state machine.
 *
 * Design: https://github.com/jleechanorg/jleechanclaw/blob/main/papers/experiment_autonomous_harness/technique.md
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, cpSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { z } from "zod";
import { loadConfig, createSessionManager, createPluginRegistry } from "@jleechanorg/ao-core";
import {
  createInitialState,
  nextPhase,
  PHASE_ORDER,
  SprintStateSchema,
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

const HarnessStateSchema = z.object({
  projectPath: z.string(),
  projectName: z.string(),
  currentSprint: SprintStateSchema,
  completedSprints: z.array(SprintStateSchema),
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
// Pipelined multi-worker support
// ---------------------------------------------------------------------------

export interface WorkerHandle {
  sessionId: string;
  sessionName: string;
  worktreePath: string | null;
  phase: Phase;
  sprintNumber: number;
}

/**
 * Pre-spawn the next phase worker while current phase is running.
 * The standby worker WAITS until the harness state shows the next phase
 * is active, then proceeds with its assigned task.
 */
export async function spawnStandbyWorker(
  currentPhase: Phase,
  state: HarnessState,
  opts: Pick<RunOptions, "generatorModel" | "evaluatorModel" | "orchestratorModel" | "skillRoot" | "runtime" | "projectId">,
  projectPath: string,
): Promise<WorkerHandle | null> {
  const currentIdx = PHASE_ORDER.indexOf(currentPhase);
  const nextPhaseIdx = currentIdx + 1;
  if (nextPhaseIdx >= PHASE_ORDER.length) return null; // No next phase

  const nextPhase = PHASE_ORDER[nextPhaseIdx];
  const nextSprint = currentPhase === "eval"
    ? state.currentSprint.sprintNumber + 1
    : state.currentSprint.sprintNumber;

  // Only pre-spawn if there's meaningful work to do
  if (nextPhase === "done") return null;

  const model: string = nextPhase === "eval"
    ? (opts.evaluatorModel ?? opts.orchestratorModel ?? "minimax/MiniMax-M2.7")
    : nextPhase === "annotation"
    ? (opts.orchestratorModel ?? "minimax/MiniMax-M2.7")
    : (opts.generatorModel ?? "minimax/MiniMax-M2.7");

  // Build the actual current state (NOT advanced) - the worker will poll until phase advances
  const taskPrompt = buildWaitThenActPrompt(nextPhase, state);
  const sessionName = `standby-${opts.projectId}-s${nextSprint}-${nextPhase}-${Date.now()}`;

  try {
    const result = await spawnAOWorker({
      model,
      systemPrompt: getSystemPromptForPhase(nextPhase),
      taskPrompt,
      workspace: projectPath,
      sessionName,
      skillRoot: opts.skillRoot,
      runtime: opts.runtime,
      projectId: opts.projectId,
    });

    console.log(`[autonomous-harness] Standby spawned for ${nextPhase}: ${result.sessionName}`);

    return {
      sessionId: result.sessionId,
      sessionName: result.sessionName,
      worktreePath: result.worktreePath,
      phase: nextPhase,
      sprintNumber: nextSprint,
    };
  } catch (err) {
    console.warn(`[autonomous-harness] Failed to spawn standby for ${nextPhase}: ${err}`);
    return null;
  }
}

/**
 * Build a prompt that instructs the worker to wait for phase activation
 * before executing the actual task.
 */
function buildWaitThenActPrompt(targetPhase: Phase, state: HarnessState): string {
  const basePrompt = buildPromptForPhase({
    ...state,
    currentSprint: {
      ...state.currentSprint,
      phase: targetPhase,
    },
  });

  // Prepend wait instruction to the base prompt
  return `IMPORTANT: Before starting, check ./harness_state.json.
If currentSprint.phase is NOT "${targetPhase}", wait and poll every 30 seconds
until the phase transitions to "${targetPhase}".

This is a PRE-SPAWNED standby worker. The previous phase is still running.
Wait for activation before doing any real work.

${basePrompt}`;
}

/**
 * Poll until a phase transition occurs OR session terminates.
 * Used for standby workers that auto-activate when previous phase completes.
 */
async function pollUntilActive(
  projectId: string,
  handle: WorkerHandle,
  targetPhase: Phase,
  maxIterations: number,
  pollIntervalMs = 30_000,
): Promise<{ status: string; activated: boolean }> {
  const config_ = loadConfig();
  const registry = createPluginRegistry();
  await registry.loadBuiltins(config_);
  const sm = await createSessionManager({ config: config_, registry });

  for (let i = 0; i < maxIterations; i++) {
    await sleep(pollIntervalMs);

    try {
      const sessions = await sm.list(projectId);
      const session = sessions.find((s: { id: string }) => s.id === handle.sessionId);

      if (!session) {
        console.log(`[autonomous-harness] Standby session ${handle.sessionId} not found`);
        return { status: "terminated", activated: false };
      }

      const status = session.status as string;
      if (TERMINAL_SESSION_STATUSES.has(status)) {
        return { status, activated: false };
      }

      // Check if worktree state shows this phase is now active
      if (handle.worktreePath) {
        const worktreeState = readState(handle.worktreePath);
        if (worktreeState && worktreeState.currentSprint.phase === targetPhase) {
          const currentPhase = PHASE_ORDER[PHASE_ORDER.indexOf(targetPhase) - 1];
          // Verify the previous phase actually completed
          if (currentPhase && worktreeState.currentSprint.phase !== currentPhase) {
            console.log(`[autonomous-harness] Standby ${targetPhase} activated (poll ${i + 1})`);
            return { status, activated: true };
          }
        }
      }

      console.log(`[autonomous-harness] Standby poll ${i + 1}/${maxIterations}: waiting for ${targetPhase}`);
    } catch (err) {
      console.warn(`[autonomous-harness] Standby poll ${i + 1} error: ${err}`);
    }
  }

  return { status: "unknown", activated: false };
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
  const [agentPlugin, modelName] = config.model.split("/", 2);
  if (!agentPlugin || !modelName) {
    throw new Error(
      `[autonomous-harness] Invalid model format: "${config.model}" — expected "provider/model" (e.g. "minimax/MiniMax-M2.7")`,
    );
  }

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
2. Write ./sprint_${state.currentSprint.sprintNumber}/sprint_report.md with what was built + self-eval
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
Set currentSprint.phase to "eval" (NOT "done" — the orchestrator handles that transition),
currentSprint.verdict to "pass" or "fail", and currentSprint.evaluatorNotes to your
analysis summary. Set currentSprint.updatedAt to current ISO timestamp.

IMPORTANT: Set phase to "eval" with verdict/notes. Do NOT set phase to "done" —
the orchestrator will call nextPhase() to transition to "done" and record the
completed sprint in completedSprints.`;
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
 * Poll for phase completion using dual strategy:
 * 1. Check AO session status (for sessions that properly transition)
 * 2. Check worktree harness_state.json (for tmux sessions where status sticks at spawning)
 *
 * Returns as soon as EITHER the session reaches a terminal state OR the worker
 * advances the phase in the state file.
 */
async function pollUntilPhaseAdvance(
  projectId: string,
  sessionId: string,
  currentPhase: string,
  worktreePath: string | null,
  maxIterations: number,
  pollIntervalMs = 30_000,
): Promise<{ status: string; phaseAdvanced: boolean }> {
  const config_ = loadConfig();
  const registry = createPluginRegistry();
  await registry.loadBuiltins(config_);
  const sm = await createSessionManager({ config: config_, registry });

  for (let i = 0; i < maxIterations; i++) {
    await sleep(pollIntervalMs);

    // Check 1: Session status
    try {
      const sessions = await sm.list(projectId);
      const session = sessions.find((s: { id: string }) => s.id === sessionId);

      if (!session) {
        console.log(`[autonomous-harness] Session ${sessionId} not found — may have been cleaned up`);
        return { status: "terminated", phaseAdvanced: false };
      }

      const status = session.status as string;
      const activity = session.activity as string | null;

      if (TERMINAL_SESSION_STATUSES.has(status)) {
        console.log(`[autonomous-harness] Session ${sessionId} terminal: ${status}`);
        return { status, phaseAdvanced: false };
      }

      // Check 2: Worktree state file for phase advance
      if (worktreePath) {
        const worktreeState = readState(worktreePath);
        if (worktreeState && worktreeState.currentSprint.phase !== currentPhase) {
          console.log(`[autonomous-harness] Phase advanced ${currentPhase} → ${worktreeState.currentSprint.phase} (poll ${i + 1})`);
          return { status, phaseAdvanced: true };
        }
      }

      console.log(`[autonomous-harness] Poll ${i + 1}/${maxIterations}: status=${status} activity=${activity ?? "?"} phase=${currentPhase}`);
    } catch (err) {
      console.warn(`[autonomous-harness] Poll ${i + 1}/${maxIterations}: error: ${err}`);
    }
  }

  console.warn(`[autonomous-harness] Session ${sessionId} did not complete within max polls`);
  return { status: "unknown", phaseAdvanced: false };
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

    // annotation uses orchestratorModel; eval uses evaluatorModel.
    const model = phase === "eval"
      ? evaluatorModel
      : phase === "annotation"
      ? orchestratorModel
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

    // Copy state file and sprint artifacts into the worktree so the worker can read current state and prior phase outputs
    if (worktreePath) {
      try {
        if (existsSync(statePath(projectPath))) {
          cpSync(statePath(projectPath), statePath(worktreePath), { force: true });
          console.log(`[autonomous-harness] State copied to worktree: ${statePath(worktreePath)}`);
        }
        // Copy all existing sprint directories so phase prompts can read prior artifacts (research.md, plan.md, etc.)
        const entries = readdirSync(projectPath);
        for (const entry of entries) {
          if (/^sprint_\d+$/.test(entry) && !existsSync(join(worktreePath, entry))) {
            cpSync(join(projectPath, entry), join(worktreePath, entry), { recursive: true, force: true });
            console.log(`[autonomous-harness] Sprint artifacts copied to worktree: ${entry}`);
          }
        }
      } catch (err) {
        console.warn(`[autonomous-harness] Failed to copy state/artifacts to worktree: ${err}`);
      }
    }

    // PRE-SPAWN standby worker for next phase (multi-worker pipelining)
    const standbyHandle = await spawnStandbyWorker(phase, state, {
      generatorModel,
      evaluatorModel,
      orchestratorModel,
      skillRoot,
      runtime,
      projectId,
    }, projectPath);

    console.log(`[autonomous-harness] Waiting for phase advance or session completion (max ${maxIterationsPerPhase} × 30s)`);

    // Poll until active worker completes
    const pollResult = await pollUntilPhaseAdvance(
      projectId,
      result.sessionId,
      phase,
      worktreePath,
      maxIterationsPerPhase,
    );

    console.log(`[autonomous-harness] Session ${result.sessionName} ended: status=${pollResult.status} phaseAdvanced=${pollResult.phaseAdvanced}`);

    // Check if the worker updated harness_state.json in the worktree
    let stateUpdated = false;
    if (worktreePath) {
      const worktreeState = readState(worktreePath);
      if (worktreeState) {
        const newPhase = worktreeState.currentSprint.phase;
        const currentIdx = PHASE_ORDER.indexOf(phase as Phase);
        const newIdx = PHASE_ORDER.indexOf(newPhase as Phase);

        // Accept: phase advanced by exactly 1, OR eval phase wrote verdict/notes without advancing
        const validTransition = (newIdx === currentIdx + 1) ||
          (phase === "eval" && newPhase === "eval" && worktreeState.currentSprint.verdict !== null);
        if (validTransition) {
          state = worktreeState;
          stateUpdated = true;
          console.log(`[autonomous-harness] State updated to ${newPhase} via worktree`);
        }
      }
    }

    // Also check main project path
    if (!stateUpdated) {
      const mainState = readState(projectPath);
      if (mainState) {
        const newPhase = mainState.currentSprint.phase;
        const currentIdx = PHASE_ORDER.indexOf(phase as Phase);
        const newIdx = PHASE_ORDER.indexOf(newPhase as Phase);
        const validTransition = (newIdx === currentIdx + 1) ||
          (phase === "eval" && newPhase === "eval" && mainState.currentSprint.verdict !== null);
        if (validTransition) {
          state = mainState;
          stateUpdated = true;
          console.log(`[autonomous-harness] State updated to ${newPhase} via main project`);
        }
      }
    }

    if (!stateUpdated) {
      throw new Error(
        `[autonomous-harness] Phase ${phase} did not advance after worker completion — treating as run failure.`,
      );
    }

    // If eval completed (verdict written), advance to next phase
    if (phase === "eval" && state.currentSprint.verdict) {
      state = nextPhase(state);
      console.log(`[autonomous-harness] Eval complete, verdict=${state.currentSprint.verdict}. Transitioned to ${state.currentSprint.phase}.`);
    }

    // Persist current state
    writeState(projectPath, state);

    // Copy artifacts from worktree back to main project
    if (worktreePath) {
      const sprintDir = join(worktreePath, `sprint_${sprint}`);
      const mainSprintDir = join(projectPath, `sprint_${sprint}`);
      if (existsSync(sprintDir)) {
        try {
          cpSync(sprintDir, mainSprintDir, { recursive: true, force: true });
          console.log(`[autonomous-harness] Artifacts copied from worktree to ${mainSprintDir}`);
        } catch (err) {
          console.warn(`[autonomous-harness] Failed to copy artifacts: ${err}`);
        }
      }
    }

    // If standby was pre-spawned, wait for it to activate and complete
    if (standbyHandle) {
      const nextPhase = state.currentSprint.phase;
      // Sync latest state/artifacts to standby worktree before polling —
      // the standby worktree may not have received updates yet.
      if (standbyHandle.worktreePath) {
        try {
          if (existsSync(statePath(projectPath))) {
            cpSync(statePath(projectPath), statePath(standbyHandle.worktreePath), { force: true });
          }
          const entries = readdirSync(projectPath);
          for (const entry of entries) {
            if (/^sprint_\d+$/.test(entry)) {
              cpSync(join(projectPath, entry), join(standbyHandle.worktreePath, entry), { recursive: true, force: true });
            }
          }
        } catch (err) {
          console.warn(`[autonomous-harness] Failed to sync state/artifacts to standby worktree: ${err}`);
        }
      }
      console.log(`[autonomous-harness] Waiting for standby ${standbyHandle.sessionName} to activate for ${nextPhase}`);

      // Wait for standby to activate (previous phase completing triggers it)
      const standbyPollResult = await pollUntilActive(
        projectId,
        standbyHandle,
        nextPhase,
        maxIterationsPerPhase,
      );

      if (standbyPollResult.activated) {
        console.log(`[autonomous-harness] Standby activated and is working on ${nextPhase}`);

        // Now wait for the standby (now active) to complete
        const standbyComplete = await pollUntilPhaseAdvance(
          projectId,
          standbyHandle.sessionId,
          nextPhase,
          standbyHandle.worktreePath,
          maxIterationsPerPhase,
        );

        console.log(`[autonomous-harness] Standby ${standbyHandle.sessionName} ended: ${standbyComplete.status}`);

        // Copy standby artifacts back
        if (standbyHandle.worktreePath) {
          const standbySprint = standbyHandle.sprintNumber;
          const standbySprintDir = join(standbyHandle.worktreePath, `sprint_${standbySprint}`);
          const mainSprintDir = join(projectPath, `sprint_${standbySprint}`);
          if (existsSync(standbySprintDir)) {
            try {
              cpSync(standbySprintDir, mainSprintDir, { recursive: true, force: true });
              console.log(`[autonomous-harness] Standby artifacts copied to ${mainSprintDir}`);
            } catch (err) {
              console.warn(`[autonomous-harness] Failed to copy standby artifacts: ${err}`);
            }
          }
        }

        // Skip the normal spawn for this phase since standby is already working
        // Update state from standby's worktree (with the same phase-validation guard
        // used in the primary worker path — prevent stale/malformed harness_state.json
        // from regressing or jumping phases)
        let standbyAccepted = false;
        if (standbyHandle.worktreePath) {
          const standbyState = readState(standbyHandle.worktreePath);
          if (standbyState) {
            const standbyPhase = standbyState.currentSprint.phase;
            const standbyIdx = PHASE_ORDER.indexOf(standbyPhase as Phase);
            const currentIdx = PHASE_ORDER.indexOf(state.currentSprint.phase as Phase);
            // Valid: standby advanced by exactly 1, OR eval wrote verdict without advancing
            const validTransition =
              (standbyIdx === currentIdx + 1) ||
              (phase === "eval" && standbyPhase === "eval" && standbyState.currentSprint.verdict !== null);
            if (validTransition) {
              state = standbyState;
              writeState(projectPath, state);
              standbyAccepted = true;
            } else {
              console.warn(`[autonomous-harness] Standby state rejected: phase=${standbyPhase} (expected standby.phase=${standbyHandle.phase}), treating as failure — will retry normally`);
            }
          }
        }
        // Only skip normal spawn if standby was successfully activated and state accepted
        if (standbyAccepted) {
          continue; // Skip to next iteration — don't spawn another worker
        }
        // else: fall through to normal spawn below
      } else {
        console.log(`[autonomous-harness] Standby did not activate in time, will spawn normally`);
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
      return "You are an Evaluator agent. Judge EVIDENCE + QUALITY, produce dual verdict. Leave phase at 'eval' — the orchestrator handles the 'done' transition.";
    default:
      return "You are an autonomous agent.";
  }
}
