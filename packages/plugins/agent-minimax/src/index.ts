/**
 * MiniMax Agent Plugin for Agent Orchestrator.
 *
 * MiniMax provides an Anthropic-compatible API at https://api.minimax.io/anthropic.
 * This plugin reuses Claude CLI with env vars pointing to the MiniMax endpoint,
 * the same pattern used by ralph.sh --tool minimax in jleechanclaw.
 *
 * Models: MiniMax-M2.5, MiniMax-M2.7 (default: MiniMax-M2.7)
 */

import {
  createAgentPlugin,
  type AgentPluginConfig,
} from "@jleechanorg/ao-plugin-agent-base";
import type {
  Agent,
  AgentLaunchConfig,
  PluginModule,
  ProjectConfig,
  Session,
} from "@jleechanorg/ao-core";

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "minimax",
  slot: "agent" as const,
  description: "Agent plugin: MiniMax (Claude CLI via Anthropic-compatible API)",
  version: "0.1.0",
};

// =============================================================================
// Constants
// =============================================================================

const MINIMAX_BASE_URL = "https://api.minimax.io/anthropic";
const MINIMAX_DEFAULT_MODEL = "MiniMax-M2.7";

// =============================================================================
// Plugin Config
// =============================================================================

const minimaxConfig: AgentPluginConfig = {
  name: "minimax",
  description: "Agent plugin: MiniMax (Claude CLI via Anthropic-compatible API)",
  processName: "claude",
  command: "claude",
  configDir: ".claude",
  permissionlessFlag: "--dangerously-skip-permissions",
  systemPromptFlag: "--append-system-prompt",
};

/** Base agent without MiniMax overrides — used to compose env and launch command. */
const baseMinimaxAgent = createAgentPlugin(minimaxConfig);

// =============================================================================
// MiniMax-specific overrides
// =============================================================================

const minimaxOverrides: Partial<Agent> = {
  getEnvironment(launchConfig: AgentLaunchConfig): Record<string, string> {
    const env: Record<string, string> = {
      ...baseMinimaxAgent.getEnvironment(launchConfig),
    };

    env["ANTHROPIC_BASE_URL"] = MINIMAX_BASE_URL;

    const apiKey = process.env.MINIMAX_API_KEY;
    if (!apiKey) {
      console.warn(
        "[agent-minimax] MINIMAX_API_KEY not set — Claude CLI will fail to authenticate with MiniMax API",
      );
    } else {
      env["ANTHROPIC_AUTH_TOKEN"] = apiKey;
      env["ANTHROPIC_API_KEY"] = apiKey;
    }

    const selectedModel = launchConfig.model ?? MINIMAX_DEFAULT_MODEL;
    env["ANTHROPIC_MODEL"] = selectedModel;
    env["ANTHROPIC_SMALL_FAST_MODEL"] = selectedModel;

    return env;
  },

  getLaunchCommand(launchConfig: AgentLaunchConfig): string {
    // Strip model from launch config — MiniMax models are set via env vars above,
    // and Claude CLI's --model flag would pass an Anthropic model ID that MiniMax rejects.
    const { model: _ignored, ...launchConfigWithoutModel } = launchConfig;
    return baseMinimaxAgent.getLaunchCommand(launchConfigWithoutModel);
  },

  async getRestoreCommand(_session: Session, _project: ProjectConfig): Promise<string | null> {
    // Returning null prevents the base plugin from building a restore command that
    // would pass --model with an Anthropic model ID (rejected by MiniMax API).
    return null;
  },
};

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createAgentPlugin(minimaxConfig, minimaxOverrides);
}

export default { manifest, create } satisfies PluginModule<Agent>;
