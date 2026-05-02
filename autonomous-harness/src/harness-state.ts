/**
 * Harness State Machine — file-based handoff state for autonomous GAN-style loop.
 * Each sprint produces artifacts read by the next phase agent.
 */

export type Phase = "research" | "plan" | "annotation" | "implementation" | "eval" | "done";

export interface ArtifactSet {
  researchMd: string;    // >50 lines of deep research
  specMd: string;         // Full product specification
  planMd: string;         // Feature breakdown with priorities
  planReviewMd: string;   // L1 constraint violations, corrections
  sprintContractMd: string; // Agreed "done" criteria before sprint
  sprintReportMd: string; // What was built + self-eval
  sprintEvalMd: string;   // Dual verdict + scores
}

export interface SprintState {
  sprintNumber: number;
  phase: Phase;
  artifacts: Partial<ArtifactSet>;
  startedAt: string;
  updatedAt: string;
  verdict?: "pass" | "fail" | null;
  evaluatorNotes?: string;
}

export interface HarnessState {
  projectPath: string;
  projectName: string;
  currentSprint: SprintState;
  completedSprints: SprintState[];
  totalSprints: number;
  generatorModel: string;
  evaluatorModel: string;
  orchestratorModel: string;
  createdAt: string;
  updatedAt: string;
}

export const PHASE_ORDER: Phase[] = ["research", "plan", "annotation", "implementation", "eval"];

export function createInitialState(
  projectPath: string,
  projectName: string,
  totalSprints: number = 1,
  generatorModel: string = "minimax/MiniMax-M2.7",
  evaluatorModel: string = "minimax/MiniMax-M2.7",
  orchestratorModel: string = "minimax/MiniMax-M2.7"
): HarnessState {
  return {
    projectPath,
    projectName,
    currentSprint: {
      sprintNumber: 1,
      phase: "research",
      artifacts: {},
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      verdict: null,
    },
    completedSprints: [],
    totalSprints,
    generatorModel,
    evaluatorModel,
    orchestratorModel,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function nextPhase(state: HarnessState): HarnessState {
  const { phase } = state.currentSprint;
  const idx = PHASE_ORDER.indexOf(phase);

  if (phase === "eval") {
    // Sprint complete — move to next sprint or done
    const completedSprints = [...state.completedSprints, { ...state.currentSprint }];
    if (completedSprints.length >= state.totalSprints) {
      return {
        ...state,
        currentSprint: { ...state.currentSprint, phase: "done" },
        completedSprints,
        updatedAt: new Date().toISOString(),
      };
    }
    const nextSprint: SprintState = {
      sprintNumber: state.currentSprint.sprintNumber + 1,
      phase: "research",
      artifacts: {},
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      verdict: null,
    };
    return {
      ...state,
      currentSprint: nextSprint,
      completedSprints,
      updatedAt: new Date().toISOString(),
    };
  }

  const nextPhase_ = PHASE_ORDER[idx + 1] ?? "done";
  if (phase === "done") return state;
  return {
    ...state,
    currentSprint: {
      ...state.currentSprint,
      phase: nextPhase_,
      updatedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
}