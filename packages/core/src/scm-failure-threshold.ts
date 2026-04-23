import type { OrchestratorConfig, ProjectConfig } from "./types.js";

const DEFAULT_SCM_FAILURE_THRESHOLD = 3;

export function resolveScmFailureThreshold(
  project: ProjectConfig,
  config: OrchestratorConfig,
): number {
  return (
    project.scmFailureThreshold ??
    config.defaults.scmFailureThreshold ??
    config.scmFailureThreshold ??
    DEFAULT_SCM_FAILURE_THRESHOLD
  );
}
