/**
 * Agent plugin timeout — configurable timeout for agent startup.
 *
 * Adds `startupTimeoutMs` to AgentSpecificConfig and project defaults,
 * with a sensible default. Companion module to avoid modifying upstream
 * config.ts and types.ts inline.
 */

import type { OrchestratorConfig, AgentSpecificConfig } from "./types.js";

export const DEFAULT_AGENT_STARTUP_TIMEOUT_MS = 120_000;

export function resolveAgentStartupTimeout(
  config: OrchestratorConfig,
  projectId: string,
): number {
  const defaultsTimeout = config.defaults?.agentConfig?.startupTimeoutMs;
  const effectiveDefault = typeof defaultsTimeout === "number" && defaultsTimeout > 0
    ? defaultsTimeout
    : DEFAULT_AGENT_STARTUP_TIMEOUT_MS;

  const project = config.projects[projectId];
  if (!project) return effectiveDefault;

  const projectTimeout = project.agentConfig?.startupTimeoutMs;
  if (typeof projectTimeout === "number" && projectTimeout > 0) {
    return projectTimeout;
  }

  return effectiveDefault;
}

export function augmentAgentConfigWithTimeout(
  agentConfig: AgentSpecificConfig,
  timeoutMs: number,
): AgentSpecificConfig {
  if (agentConfig.startupTimeoutMs !== undefined) {
    return agentConfig;
  }
  return { ...agentConfig, startupTimeoutMs: timeoutMs };
}
