/**
 * Autonomous Harness Orchestrator
 *
 * GAN-style generator/evaluator loop driven by file-based handoffs.
 * The orchestrator (MiniMax M2.7) spawns workers for each phase,
 * polls for artifact completion, and advances the state machine.
 *
 * Design: https://github.com/jleechanorg/jleechanclaw/blob/main/papers/experiment_autonomous_harness/technique.md
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { loadConfig, createSessionManager, createPluginRegistry } from "@jleechanorg/ao-core";
import { createInitialState, nextPhase, PHASE_ORDER, type HarnessState, type Phase } from "./harness-state.js";

function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
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
}

export interface SpawnResult {
  sessionId: string;
  sessionName: string;
  exitCode: number | null;
}

/**
 * Spawn an AO worker using the SessionManager API (not CLI).
 * The worker reads the harness_state.json and produces artifacts according to its phase.
 *
 * Uses ao-core's SessionManager.spawn() which supports:
 * - prompt: free-form task prompt (unlike ao spawn CLI which is issue-based)
 * - agent: agent plugin override
 * - runtimeOverride: runtime override
 *
 * The projectId is resolved by matching config.workspace against project paths.
 */
export async function spawnAOWorker(config: SpawnConfig): Promise<SpawnResult> {
  const sessionName = config.sessionName || `autonomous-${Date.now()}`;
  const workspacePath = pathResolve(config.workspace);

  // Load AO config to resolve projectId from workspace path
  const config_ = loadConfig();
  const projectIds = Object.keys(config_.projects);

  // Find project by matching workspace path
  const matchedProjectId = projectIds.find((id) => {
    const proj = config_.projects[id];
    if (!proj?.path) return false;
    return pathResolve(proj.path) === workspacePath;
  });

  if (!matchedProjectId) {
    // Fallback: use first project if only one configured
    if (projectIds.length === 1) {
      console.warn(`[autonomous-harness] Workspace ${workspacePath} not in AO config — using default project`);
    } else {
      throw new Error(
        `[autonomous-harness] Project not found in AO config for workspace: ${workspacePath}\n` +
          `Configured projects: ${projectIds.join(", ")}`,
      );
    }
  }

  const projectId = matchedProjectId ?? projectIds[0];
  const resolvedWorkspace = pathResolve(config_.projects[projectId]?.path ?? config_.defaults?.workspace ?? ".");

  // Build full prompt: system context + task
  const fullPrompt = `${config.systemPrompt}\n\nTask: ${config.taskPrompt}`;

  // Extract agent plugin name from model string (e.g., "minimax/MiniMax-M2.7" → "minimax")
  const agentPlugin = config.model.split("/")[0];

  const sm = await createSessionManager({ config: config_, registry: createPluginRegistry() });
  const session = await sm.spawn({
    projectId,
    prompt: fullPrompt,
    agent: agentPlugin,
    runtimeOverride: undefined,
    skipPrBoilerplate: true,
  });

  return {
    sessionId: session.id,
    sessionName: session.id,
    exitCode: null,
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
    return JSON.parse(readFileSync(p, "utf-8")) as HarnessState;
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
  content: string
): void {
  const dir = join(workspace, `sprint_${sprint}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, artifact), content, "utf-8");
}

// ---------------------------------------------------------------------------
// Phase prompt builders
// ---------------------------------------------------------------------------

export function buildResearchPrompt(state: HarnessState): string {
  return `You are the Researcher agent for sprint ${state.currentSprint.sprintNumber}.

Research the project at: ${state.projectPath}

Your job:
1. Deep-read ALL existing files — understand the architecture, patterns, and constraints
2. Write a research.md file (>50 lines) with the tag "research"
3. Use words like "deeply", "intricacies" to ensure thorough analysis
4. If research is wrong, the plan is wrong, implementation is wrong

Output: Write ${artifactPath(state.projectPath, state.currentSprint.sprintNumber, "research.md")}

After completing research, update the harness state by writing ${statePath(state.projectPath)}.
Set currentSprint.phase to "plan" and currentSprint.artifacts.researchMd to the path you wrote.
Set currentSprint.updatedAt to ${new Date().toISOString()}.`;
}

export function buildPlanPrompt(state: HarnessState): string {
  return `You are the Strategist agent for sprint ${state.currentSprint.sprintNumber}.

Read: ${state.projectPath}/sprint_${state.currentSprint.sprintNumber}/research.md

Your job:
1. Write a full spec.md covering all functionality
2. Write a plan.md with feature breakdown and priorities
3. Use your own .md files (not built-in plan mode) for full control

Output paths:
- ${artifactPath(state.projectPath, state.currentSprint.sprintNumber, "spec.md")}
- ${artifactPath(state.projectPath, state.currentSprint.sprintNumber, "plan.md")}

After completing the plan, update harness state:
Set currentSprint.phase to "annotation" and currentSprint.artifacts.specMd + planMd to their paths.
Set currentSprint.updatedAt.`;
}

export function buildAnnotationPrompt(state: HarnessState): string {
  return `You are the Reviewer agent for sprint ${state.currentSprint.sprintNumber}.

Read the plan: ${state.projectPath}/sprint_${state.currentSprint.sprintNumber}/plan.md

Your job:
1. Open the plan in your editor
2. Add inline annotations (correcting assumptions, rejecting approaches, adding constraints)
3. Send Claude back to address notes — repeat until the plan is validated
4. Write a plan_review.md summarizing your annotations
5. Write sprint_contract.md with agreed "done" criteria before the sprint

Output paths:
- ${artifactPath(state.projectPath, state.currentSprint.sprintNumber, "plan_review.md")}
- ${artifactPath(state.projectPath, state.currentSprint.sprintNumber, "sprint_contract.md")}

After completing annotation cycle, update harness state:
Set currentSprint.phase to "implementation" and currentSprint.artifacts.planReviewMd + sprintContractMd.
Set currentSprint.updatedAt.`;
}

export function buildImplementationPrompt(state: HarnessState): string {
  return `You are the Generator agent for sprint ${state.currentSprint.sprintNumber}.

Read: ${state.projectPath}/sprint_${state.currentSprint.sprintNumber}/sprint_contract.md

Implement the full sprint per the contract. When done:
1. Mark each completed task in the plan document
2. Write a sprint_${state.currentSprint.sprintNumber}_report.md with what was built + self-eval
3. Do NOT add unnecessary comments or jsdocs
4. Do NOT use any or unknown types
5. Continuously run typecheck

Output: ${artifactPath(state.projectPath, state.currentSprint.sprintNumber, "sprint_report.md")}

After implementation, update harness state:
Set currentSprint.phase to "eval".
Set currentSprint.artifacts.sprintReportMd.
Set currentSprint.updatedAt.`;
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

Read the sprint report: ${state.projectPath}/sprint_${state.currentSprint.sprintNumber}/sprint_report.md

Output: ${artifactPath(state.projectPath, state.currentSprint.sprintNumber, "sprint_eval.md")}

If score >= 7 and EVIDENCE pass → verdict: "pass"
Otherwise → verdict: "fail"

After evaluation, update harness state:
Set currentSprint.phase to "eval" (final), currentSprint.verdict, currentSprint.evaluatorNotes.
Set currentSprint.updatedAt.`;
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
  projectName: string;
  totalSprints?: number;
  generatorModel?: string;
  evaluatorModel?: string;
  orchestratorModel?: string;
  skillRoot?: string;
  maxIterationsPerPhase?: number;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollStateUntilPhaseChange(
  workspace: string,
  phase: string,
  maxIterations: number
): Promise<HarnessState | null> {
  const POLL_INTERVAL_MS = 15_000; // 15s between polls
  for (let i = 0; i < maxIterations; i++) {
    await sleep(POLL_INTERVAL_MS);
    const state = readState(workspace);
    if (!state) return null;
    if (state.currentSprint.phase !== phase) return state;
    console.log(`[autonomous-harness] Poll ${i + 1}/${maxIterations}: phase still ${phase}, waiting...`);
  }
  return readState(workspace); // return last known state (may be stalled)
}

export async function runAutonomousHarness(opts: RunOptions): Promise<HarnessState> {
  const {
    projectPath,
    projectName,
    totalSprints = 1,
    generatorModel = "minimax/MiniMax-M2.7",
    evaluatorModel = "minimax/MiniMax-M2.7",
    orchestratorModel = "minimax/MiniMax-M2.7",
    skillRoot,
    maxIterationsPerPhase = 10,
  } = opts;

  // Initialize or resume state
  let state = readState(projectPath);
  if (!state) {
    state = createInitialState(projectPath, projectName, totalSprints, generatorModel, evaluatorModel, orchestratorModel);
    writeState(projectPath, state);
  }

  console.log(`[autonomous-harness] Starting loop for ${projectName} sprint ${state.currentSprint.sprintNumber} phase: ${state.currentSprint.phase}`);

  while (state.currentSprint.phase !== "done") {
    const phase = state.currentSprint.phase;
    const sprint = state.currentSprint.sprintNumber;

    console.log(`[autonomous-harness] Sprint ${sprint} Phase: ${phase}`);

    // Build task prompt for current phase
    const taskPrompt = buildPromptForPhase(state);

    // Select model based on phase
    const model = phase === "eval" || phase === "annotation"
      ? evaluatorModel
      : generatorModel;

    const sessionName = `autonomous-s${sprint}-${phase}-${Date.now()}`;

    // Spawn worker
    const result = await spawnAOWorker({
      model,
      systemPrompt: getSystemPromptForPhase(phase),
      taskPrompt,
      workspace: projectPath,
      sessionName,
      skillRoot,
    });

    console.log(`[autonomous-harness] Worker spawned: ${result.sessionName} — polling for phase advance`);

    // Poll until phase advances or retry limit reached
    const newState = await pollStateUntilPhaseChange(projectPath, phase, maxIterationsPerPhase);
    if (!newState) throw new Error("State lost after worker run");

    // Worker may have already advanced the phase via writeState
    // Only call nextPhase if the worker didn't advance
    const workerAdvanced = newState.currentSprint.phase !== phase;
    if (workerAdvanced) {
      // Validate transition using PHASE_ORDER
      const fromIdx = PHASE_ORDER.indexOf(phase);
      const toIdx = PHASE_ORDER.indexOf(newState.currentSprint.phase);
      if (toIdx < 0) {
        console.error(`[autonomous-harness] Unknown phase: ${newState.currentSprint.phase}`);
        newState.currentSprint.verdict = "fail";
        newState.currentSprint.evaluatorNotes = `Invalid phase transition: ${phase} → ${newState.currentSprint.phase}`;
        state = nextPhase(newState);
        writeState(projectPath, state);
      } else if (toIdx > fromIdx + 1 || toIdx < fromIdx) {
        // Skip (forward >1) or backwards — reject as invalid
        console.error(`[autonomous-harness] Invalid phase transition: ${phase} → ${newState.currentSprint.phase}`);
        newState.currentSprint.verdict = "fail";
        newState.currentSprint.evaluatorNotes = `Invalid phase transition: ${phase} → ${newState.currentSprint.phase}`;
        state = nextPhase(newState);
        writeState(projectPath, state);
      } else {
        // Valid: same phase (artifact rewrite) or immediate next
        console.log(`[autonomous-harness] Worker advanced phase: ${phase} → ${newState.currentSprint.phase}`);
        state = newState;
      }
    } else if (phase === "eval") {
      // Eval phase: worker writes verdict but keeps phase as "eval" (final marker)
      // Accept eval as complete once verdict is set, then advance to done
      console.log(`[autonomous-harness] Eval complete — verdict: ${newState.currentSprint.verdict ?? "(none)"}`);
      state = nextPhase(newState);
      writeState(projectPath, state);
    } else {
      // Worker stalled — advance and continue to next phase
      console.warn(`[autonomous-harness] Phase ${phase} did not advance — advancing manually`);
      state = nextPhase(newState);
      writeState(projectPath, state);
    }
  }

  console.log(`[autonomous-harness] All sprints complete. ${state.completedSprints.length}/${state.totalSprints} done.`);
  return state;
}

// ---------------------------------------------------------------------------
// System prompts per phase (minimal — actual logic is in skill prompts)
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
      return "You are an Evaluator agent. Judge EVIDENCE + QUALITY, produce dual verdict.";
    default:
      return "You are an autonomous agent.";
  }
}