import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildPrompt } from "./prompt-builder.js";
import { getProjectBaseDir } from "./paths.js";
import type { Agent, Issue, ProjectConfig, SessionId, SessionSpawnConfig } from "./types.js";

export const WORKER_BOOT_PROMPT =
  "Begin the assigned AO worker task. Follow the session instructions file.";

export interface WorkerPromptArtifact {
  composedPromptPath: string;
  launchPrompt: string;
  postLaunchPrompt: string;
  promptIssueId: string | undefined;
  requestedTask: string | undefined;
}

export interface WorkerPromptArtifactConfig {
  agent: Agent;
  configPath: string;
  hasTracker: boolean;
  issueContext: string | undefined;
  project: ProjectConfig;
  resolvedIssue: Issue | null | undefined;
  sessionId: SessionId;
  spawnConfig: SessionSpawnConfig;
  composedPromptPath?: string;
  /** Skip PR/push boilerplate (e.g. for artifact-only workers). Defaults to false. */
  skipPrBoilerplate?: boolean;
}

export function agentSupportsPromptFile(agent: Agent): boolean {
  return agent.supportsSystemPromptFile === true;
}

function launchPromptForAgent(agent: Agent, composedPrompt: string): string {
  return agentSupportsPromptFile(agent) ? WORKER_BOOT_PROMPT : composedPrompt;
}

export function getWorkerPromptArtifactPath(
  configPath: string,
  project: ProjectConfig,
  sessionId: SessionId,
): string {
  return join(
    getProjectBaseDir(configPath, project.path),
    "prompts",
    `worker-prompt-${sessionId}.md`,
  );
}

export function buildWorkerPromptArtifact(config: WorkerPromptArtifactConfig): WorkerPromptArtifact {
  const isAdHocTask = Boolean(
    config.spawnConfig.issueId && config.hasTracker && !config.resolvedIssue,
  );
  const promptIssueId = isAdHocTask ? undefined : config.spawnConfig.issueId;
  const requestedTask =
    config.spawnConfig.prompt ?? (isAdHocTask ? config.spawnConfig.issueId : undefined);

  const composedPrompt = buildPrompt({
    project: config.project,
    projectId: config.spawnConfig.projectId,
    issueId: promptIssueId,
    issueContext: config.issueContext,
    trackerDrivenBranching: Boolean(
      !config.spawnConfig.branch && promptIssueId && config.hasTracker && config.resolvedIssue,
    ),
    userPrompt: requestedTask,
    lineage: config.spawnConfig.lineage,
    siblings: config.spawnConfig.siblings,
    skipPrBoilerplate: config.skipPrBoilerplate ?? config.spawnConfig.skipPrBoilerplate ?? false,
  });

  const composedPromptPath =
    config.composedPromptPath ??
    getWorkerPromptArtifactPath(config.configPath, config.project, config.sessionId);
  const composedPromptDir = dirname(composedPromptPath);
  mkdirSync(composedPromptDir, { recursive: true, mode: 0o700 });
  chmodSync(composedPromptDir, 0o700);
  writeFileSync(composedPromptPath, composedPrompt, { encoding: "utf-8", mode: 0o600 });

  return {
    composedPromptPath,
    launchPrompt: launchPromptForAgent(config.agent, composedPrompt),
    postLaunchPrompt: composedPrompt,
    promptIssueId,
    requestedTask,
  };
}
