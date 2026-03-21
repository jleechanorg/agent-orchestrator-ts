import {
  createAgentPlugin,
  toAgentProjectPath,
  resetPsCache as _resetPsCache,
  type AgentPluginConfig,
} from "@jleechanorg/ao-plugin-agent-base";
import { execFileSync } from "node:child_process";
import type { Agent, AgentLaunchConfig, ProjectConfig, Session } from "@jleechanorg/ao-core";

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "cursor",
  slot: "agent" as const,
  description: "Agent plugin: Cursor Agent CLI",
  version: "0.1.0",
};

// =============================================================================
// Project Path Encoder (alias for tests)
// =============================================================================

/** Convert a workspace path to Cursor's project directory path. */
export const toCursorProjectPath = toAgentProjectPath;

// =============================================================================
// Plugin Config
// =============================================================================

const cursorConfig: AgentPluginConfig = {
  name: "cursor",
  description: "Agent plugin: Cursor Agent CLI",
  processName: "cursor-agent",
  command: "cursor-agent",
  configDir: ".cursor",
  // Cursor Agent CLI uses --force (equivalent of --yolo / --dangerously-skip-permissions)
  permissionlessFlag: "--force",
  // Cursor Agent CLI does not support a system prompt flag;
  // system prompts are delivered post-launch via sendMessage().
  systemPromptFlag: undefined,
  // Cursor Agent CLI does not expose cost or token data in JSONL — cost not tracked.
};

// =============================================================================
// Cursor-specific overrides
// Cursor stores sessions in SQLite at ~/.cursor/chats/, but also writes JSONL
// to ~/.cursor/projects/ so the base getSessionInfo implementation works.
// getRestoreCommand returns null until SQLite introspection is implemented.
// =============================================================================

const cursorOverrides: Partial<Agent> = {
  async getRestoreCommand(_session: Session, _project: ProjectConfig): Promise<string | null> {
    // TODO: Implement via SQLite from ~/.cursor/chats/
    return null;
  },

  getLaunchCommand(launchConfig: AgentLaunchConfig): string {
    // Pre-create the workspace trust file so cursor-agent skips the interactive
    // "Workspace Trust Required" prompt in unattended sessions.
    // The --trust flag only works in headless (--print) mode; pre-creating the
    // JSON trust file is the correct fix for interactive sessions.
    const preTrust = [
      `_WP=$(pwd)`,
      `_EP=$(echo "$_WP" | sed 's|[/.]|-|g')`,
      `mkdir -p "$HOME/.cursor/projects/$_EP"`,
      `printf '{"trustedAt":"%s","workspacePath":"%s"}' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$_WP" > "$HOME/.cursor/projects/$_EP/.workspace-trusted" 2>/dev/null`,
    ].join(" && ");
    // Strip the model from launchConfig: cursor-agent uses its own model naming
    // convention (e.g. "claude-4.6-sonnet-medium") that is incompatible with
    // Anthropic API model IDs (e.g. "claude-sonnet-4-6"). Passing an unknown
    // model name causes cursor-agent to print the available model list and exit
    // immediately. Users who need a specific cursor model should configure it in
    // Cursor's own settings; AO should not override the model for cursor sessions.
    const { model: _ignored, ...launchConfigWithoutModel } = launchConfig;
    const agentCmd = createAgentPlugin(cursorConfig).getLaunchCommand(launchConfigWithoutModel);
    return `( ${preTrust} ); ${agentCmd}`;
  },
};

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createAgentPlugin(cursorConfig, cursorOverrides);
}

/** Detect if Cursor agent CLI is installed. */
export function detect(): boolean {
  try {
    execFileSync("cursor-agent", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Reset the ps process cache. Exported for testing only. */
export const resetPsCache = _resetPsCache;

export default { manifest, create, detect } as {
  manifest: typeof manifest;
  create: typeof create;
  detect: typeof detect;
};
