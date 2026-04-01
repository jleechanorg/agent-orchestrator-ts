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

const CURSOR_DEFAULT_MODEL = "composer-2-fast";

/** Known Composer model IDs from `cursor-agent models` — do not pass through arbitrary `composer-*` typos. */
const SUPPORTED_COMPOSER_MODEL_IDS = new Set<string>(["composer-2-fast", "composer-2"]);

/**
 * Anthropic / AO-style model IDs (e.g. claude-opus-4-6) that Cursor rejects.
 * Cursor-native claude-* slugs (e.g. claude-3-5-sonnet) are passed through.
 */
function isAnthropicApiStyleModelId(model: string): boolean {
  return /^claude-(?:sonnet|opus|haiku)-\d+-\d+$/i.test(model);
}

function normalizeCursorModel(model?: string): string {
  if (!model) {
    return CURSOR_DEFAULT_MODEL;
  }
  if (model === "auto") {
    return model;
  }
  if (model.startsWith("composer-")) {
    return SUPPORTED_COMPOSER_MODEL_IDS.has(model) ? model : CURSOR_DEFAULT_MODEL;
  }
  if (model.startsWith("gpt-")) {
    return model;
  }
  if (model.startsWith("gemini-") || model.startsWith("grok-") || model.startsWith("kimi-")) {
    return model;
  }
  if (model.startsWith("claude-")) {
    if (isAnthropicApiStyleModelId(model)) {
      return CURSOR_DEFAULT_MODEL;
    }
    return model;
  }
  return CURSOR_DEFAULT_MODEL;
}

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
      `_EP=$(echo "$_WP" | sed 's|^/||; s|\\.||g; s|/|-|g')`,
      `mkdir -p "$HOME/.cursor/projects/$_EP"`,
      `printf '{"trustedAt":"%s","workspacePath":"%s"}' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$_WP" > "$HOME/.cursor/projects/$_EP/.workspace-trusted" 2>/dev/null`,
    ].join(" && ");
    const { model, ...launchConfigWithoutModel } = launchConfig;
    const normalizedModel = normalizeCursorModel(model);
    const launchConfigWithModel = {
      ...launchConfigWithoutModel,
      model: normalizedModel,
    };
    const agentCmd = createAgentPlugin(cursorConfig).getLaunchCommand(launchConfigWithModel);
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
