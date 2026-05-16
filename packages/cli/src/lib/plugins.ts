import type { Agent, OrchestratorConfig, PluginRegistry, SCM } from "@jleechanorg/ao-core";
import claudeCodePlugin from "@jleechanorg/ao-plugin-agent-claude-code";
import codexPlugin from "@jleechanorg/ao-plugin-agent-codex";
import cursorPlugin from "@jleechanorg/ao-plugin-agent-cursor";
import aiderPlugin from "@jleechanorg/ao-plugin-agent-aider";
import opencodePlugin from "@jleechanorg/ao-plugin-agent-opencode";
import minimaxPlugin from "@jleechanorg/ao-plugin-agent-minimax";
import geminiPlugin from "@jleechanorg/ao-plugin-agent-gemini";
import waferPlugin from "@jleechanorg/ao-plugin-agent-wafer";
import githubSCMPlugin from "@jleechanorg/ao-plugin-scm-github";

const agentPlugins: Record<string, { create(): Agent }> = {
  "claude-code": claudeCodePlugin,
  codex: codexPlugin,
  cursor: cursorPlugin,
  aider: aiderPlugin,
  opencode: opencodePlugin,
  minimax: minimaxPlugin,
  gemini: geminiPlugin,
  wafer: waferPlugin,
};

const scmPlugins: Record<string, { create(): SCM }> = {
  github: githubSCMPlugin,
};

export function getAgent(config: OrchestratorConfig, projectId?: string): Agent {
  const agentName =
    (projectId ? config.projects[projectId]?.agent : undefined) || config.defaults.agent;
  return getAgentByName(agentName);
}

export function getAgentByName(name: string): Agent {
  const plugin = agentPlugins[name];
  if (!plugin) {
    throw new Error(`Unknown agent plugin: ${name}`);
  }
  return plugin.create();
}

export function getAgentByNameFromRegistry(registry: PluginRegistry, name: string): Agent {
  const plugin = registry.get<Agent>("agent", name);
  if (!plugin) {
    throw new Error(`Unknown agent plugin: ${name}`);
  }
  return plugin;
}

export function getSCM(config: OrchestratorConfig, projectId: string): SCM {
  const scmName = config.projects[projectId]?.scm?.plugin || "github";
  const plugin = scmPlugins[scmName];
  if (!plugin) {
    throw new Error(`Unknown SCM plugin: ${scmName}`);
  }
  return plugin.create();
}

export function getSCMFromRegistry(
  registry: PluginRegistry,
  config: OrchestratorConfig,
  projectId: string,
): SCM {
  const scmName = config.projects[projectId]?.scm?.plugin || "github";
  const plugin = registry.get<SCM>("scm", scmName);
  if (!plugin) {
    throw new Error(`Unknown SCM plugin: ${scmName}`);
  }
  return plugin;
}
