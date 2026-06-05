/**
 * @jleechanorg/ao-autonomous-harness — public API
 */
export { registerAutonomousHarness } from "./cli.js";
export type { RunOptions } from "./orchestrator.js";
export type { Phase, ArtifactSet, SprintState, HarnessState } from "./harness-state.js";
export { createInitialState, nextPhase, PHASE_ORDER, SprintStateSchema } from "./harness-state.js";
export { spawnAOWorker } from "./orchestrator.js";
export type { SpawnConfig, SpawnResult } from "./orchestrator.js";

