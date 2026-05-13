import { createAgentPlugin, type AgentPluginConfig } from "@jleechanorg/ao-plugin-agent-base";
import {
  type Agent,
  type AgentLaunchConfig,
  type PluginModule,
  type ProjectConfig,
  type Session,
} from "@jleechanorg/ao-core";
import { execFileSync } from "node:child_process";

/** Default MiniMax Anthropic-compatible endpoint (international). Override with MINIMAX_ANTHROPIC_BASE_URL. */
export const DEFAULT_MINIMAX_ANTHROPIC_BASE_URL = "https://api.minimax.io/anthropic";

export const manifest = {
  name: "minimax",
  slot: "agent" as const,
  description: "Agent plugin: MiniMax via Claude Code (Anthropic-compatible API)",
  version: "0.1.0",
  displayName: "MiniMax (Claude Code)",
};

const minimaxConfig: AgentPluginConfig = {
  name: "minimax",
  description: manifest.description,
  processName: "claude",
  command: "claude",
  configDir: ".claude",
  permissionlessFlag: "--dangerously-skip-permissions",
};

const minimaxOverrides: Partial<Agent> = {
  getLaunchCommand(launchConfig: AgentLaunchConfig): string {
    const { model: _model, ...rest } = launchConfig;
    const baseUrl = process.env.MINIMAX_ANTHROPIC_BASE_URL?.trim() || DEFAULT_MINIMAX_ANTHROPIC_BASE_URL;
    const apiKey = process.env.MINIMAX_API_KEY || "";
    const model = process.env.MINIMAX_MODEL?.trim() || "";
    const baseCmd = createAgentPlugin(minimaxConfig).getLaunchCommand(rest);
    // Inline env vars survive tmux shell startup overrides (.bashrc etc.)
    const modelPrefix = model ? ` ANTHROPIC_MODEL=${model}` : "";
    return `ANTHROPIC_BASE_URL=${baseUrl} ANTHROPIC_API_KEY=${apiKey}${modelPrefix} ${baseCmd}`;
  },

  getEnvironment(launchConfig: AgentLaunchConfig): Record<string, string> {
    const baseEnv = createAgentPlugin(minimaxConfig).getEnvironment(launchConfig);
    const apiKey = process.env.MINIMAX_API_KEY;
    if (apiKey) {
      console.debug(
        "[ao-plugin-agent-minimax] MINIMAX_API_KEY resolved",
      );
    } else {
      console.error(
        "[ao-plugin-agent-minimax] MINIMAX_API_KEY not found. Set MINIMAX_API_KEY in your environment or in a file listed under envSource in agent-orchestrator.yaml.",
      );
    }
    const baseUrl =
      process.env.MINIMAX_ANTHROPIC_BASE_URL?.trim() || DEFAULT_MINIMAX_ANTHROPIC_BASE_URL;
    const env: Record<string, string> = {
      ...baseEnv,
      ANTHROPIC_BASE_URL: baseUrl,
    };
    if (apiKey) {
      env["ANTHROPIC_AUTH_TOKEN"] = apiKey;
      env["ANTHROPIC_API_KEY"] = apiKey;
    }
    const model = process.env.MINIMAX_MODEL?.trim();
    if (model) {
      env["ANTHROPIC_MODEL"] = model;
    }
    return env;
  },

  async getRestoreCommand(_session: Session, _project: ProjectConfig): Promise<string | null> {
    return null;
  },
};

export function create(): Agent {
  return createAgentPlugin(minimaxConfig, minimaxOverrides);
}

export function detect(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
