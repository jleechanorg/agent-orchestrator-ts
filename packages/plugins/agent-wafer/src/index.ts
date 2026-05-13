import { createAgentPlugin, type AgentPluginConfig } from "@jleechanorg/ao-plugin-agent-base";
import {
  type Agent,
  type AgentLaunchConfig,
  type PluginModule,
  type ProjectConfig,
  type Session,
} from "@jleechanorg/ao-core";
import { execFileSync } from "node:child_process";

/** Default Wafer Anthropic-compatible endpoint. Override with WAFER_ANTHROPIC_BASE_URL. */
export const DEFAULT_WAFER_ANTHROPIC_BASE_URL = "https://pass.wafer.ai";

export const manifest = {
  name: "wafer",
  slot: "agent" as const,
  description: "Agent plugin: Wafer via Claude Code (Anthropic-compatible API)",
  version: "0.1.0",
  displayName: "Wafer (Claude Code)",
};

const waferConfig: AgentPluginConfig = {
  name: "wafer",
  description: manifest.description,
  processName: "claude",
  command: "claude",
  configDir: ".claude",
  permissionlessFlag: "--dangerously-skip-permissions",
};

const waferOverrides: Partial<Agent> = {
  getLaunchCommand(launchConfig: AgentLaunchConfig): string {
    const model = process.env.WAFER_MODEL?.trim() || "GLM-5.1";
    const { model: _model, ...rest } = launchConfig;
    const baseUrl = process.env.WAFER_ANTHROPIC_BASE_URL?.trim() || DEFAULT_WAFER_ANTHROPIC_BASE_URL;
    const apiKey = process.env.WAFER_API_KEY || "";
    const baseCmd = createAgentPlugin(waferConfig).getLaunchCommand({ ...rest, model });
    // Inline env vars survive tmux shell startup overrides (.bashrc etc.)
    return `ANTHROPIC_BASE_URL=${baseUrl} ANTHROPIC_API_KEY=${apiKey} ANTHROPIC_MODEL=${model} ${baseCmd}`;
  },

  getEnvironment(launchConfig: AgentLaunchConfig): Record<string, string> {
    const baseEnv = createAgentPlugin(waferConfig).getEnvironment(launchConfig);
    const apiKey = process.env.WAFER_API_KEY;
    if (apiKey) {
      console.debug(
        "[ao-plugin-agent-wafer] WAFER_API_KEY resolved",
      );
    } else {
      console.error(
        "[ao-plugin-agent-wafer] WAFER_API_KEY not found. Set WAFER_API_KEY in your environment or in a file listed under envSource in agent-orchestrator.yaml.",
      );
    }
    const baseUrl =
      process.env.WAFER_ANTHROPIC_BASE_URL?.trim() || DEFAULT_WAFER_ANTHROPIC_BASE_URL;
    const env: Record<string, string> = {
      ...baseEnv,
      ANTHROPIC_BASE_URL: baseUrl,
    };
    if (apiKey) {
      env["ANTHROPIC_AUTH_TOKEN"] = apiKey;
      env["ANTHROPIC_API_KEY"] = apiKey;
    }
    const model = process.env.WAFER_MODEL?.trim();
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
  return createAgentPlugin(waferConfig, waferOverrides);
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
