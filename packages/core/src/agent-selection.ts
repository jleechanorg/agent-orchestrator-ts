import {
  normalizeAgentPermissionMode,
  isOrchestratorSession,
  type AgentPermissionMode,
  type AgentSpecificConfig,
  type CliModelDefaults,
  type DefaultPlugins,
  type ProjectConfig,
} from "./types.js";

export type SessionRole = "orchestrator" | "worker";

/** Case-insensitive key match for `modelByCli` maps (direct key wins if present). */
export function lookupCliModelDefaults(
  map: Record<string, CliModelDefaults> | undefined,
  agentName: string,
): CliModelDefaults {
  if (!map) {
    return {};
  }
  const direct = map[agentName];
  if (direct !== undefined) {
    return direct;
  }
  const lower = agentName.toLowerCase();
  for (const [key, value] of Object.entries(map)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return {};
}

export interface ResolvedAgentSelection {
  role: SessionRole;
  agentName: string;
  agentConfig: AgentSpecificConfig;
  model?: string;
  permissions?: AgentPermissionMode;
  subagent?: string;
}

export function resolveSessionRole(
  sessionId: string,
  metadata?: Record<string, string>,
): SessionRole {
  return isOrchestratorSession({ id: sessionId, metadata }) ? "orchestrator" : "worker";
}

export function resolveAgentSelection(params: {
  role: SessionRole;
  project: ProjectConfig;
  defaults: DefaultPlugins;
  persistedAgent?: string;
  spawnAgentOverride?: string;
}): ResolvedAgentSelection {
  const { role, project, defaults, persistedAgent, spawnAgentOverride } = params;
  const roleProjectConfig = role === "orchestrator" ? project.orchestrator : project.worker;
  const roleDefaults = role === "orchestrator" ? defaults.orchestrator : defaults.worker;
  const roleAgentConfig = {
    ...(roleDefaults?.agentConfig ?? {}),
    ...(roleProjectConfig?.agentConfig ?? {}),
  };
  const sharedConfig = {
    ...(defaults.agentConfig ?? {}),
    ...(project.agentConfig ?? {}),
  };

  const agentName = persistedAgent
    ? persistedAgent
    : role === "worker"
      ? (spawnAgentOverride ??
        roleProjectConfig?.agent ??
        project.agent ??
        roleDefaults?.agent ??
        defaults.agent)
      : (roleProjectConfig?.agent ?? project.agent ?? roleDefaults?.agent ?? defaults.agent);

  const defaultsCliModelConfig = lookupCliModelDefaults(defaults.modelByCli, agentName);
  const projectCliModelConfig = lookupCliModelDefaults(project.modelByCli, agentName);
  const cliModelConfig: CliModelDefaults = {
    ...defaultsCliModelConfig,
    ...projectCliModelConfig,
  };

  const agentConfig: AgentSpecificConfig = {
    ...sharedConfig,
  };
  for (const [key, value] of Object.entries(roleAgentConfig)) {
    if (value !== undefined) {
      agentConfig[key] = value;
    }
  }

  const model =
    role === "orchestrator"
      ? (roleAgentConfig.orchestratorModel ??
        roleAgentConfig.model ??
        cliModelConfig.orchestratorModel ??
        cliModelConfig.model ??
        sharedConfig.orchestratorModel ??
        sharedConfig.model ??
        undefined)
      : (roleAgentConfig.model ?? cliModelConfig.model ?? sharedConfig.model);

  if (model !== undefined) {
    agentConfig.model = model;
  }

  const permissions = normalizeAgentPermissionMode(
    typeof agentConfig.permissions === "string" ? agentConfig.permissions : undefined,
  );
  if (permissions !== undefined) {
    agentConfig.permissions = permissions;
  }
  const subagent =
    typeof agentConfig["subagent"] === "string" ? agentConfig["subagent"] : undefined;

  return {
    role,
    agentName,
    agentConfig,
    model,
    permissions,
    subagent,
  };
}
