import {
  createAgentPlugin,
  toAgentProjectPath,
  resetPsCache as _resetPsCache,
  type AgentPluginConfig,
} from "@jleechanorg/ao-plugin-agent-base";
import type { Agent, AgentLaunchConfig, PluginModule } from "@jleechanorg/ao-core";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "gemini",
  slot: "agent" as const,
  description: "Agent plugin: Gemini CLI",
  version: "0.1.0",
};

// =============================================================================
// Project Path Encoder
// =============================================================================

/**
 * Convert a workspace path to Gemini's project directory hash.
 * Gemini CLI uses SHA-256 of the workspace path to name its project directory
 * (`~/.gemini/tmp/<hash>/chats/`), unlike Claude Code which uses path-mangling.
 *
 * Exported for testing.
 */
export function toGeminiProjectPath(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/");
  return createHash("sha256").update(normalized).digest("hex");
}

/** @deprecated Use toGeminiProjectPath instead */
export { toAgentProjectPath };

// =============================================================================
// Plugin Config
// =============================================================================

const geminiConfig: AgentPluginConfig = {
  name: "gemini",
  description: "Agent plugin: Gemini CLI",
  processName: "gemini",
  command: "gemini",
  configDir: ".gemini",
  // Gemini CLI uses --yolo (equivalent of --dangerously-skip-permissions)
  permissionlessFlag: "--yolo",
  // Gemini CLI does not support a system prompt CLI flag; prompts are delivered
  // post-launch via sendMessage(), or inline via the GEMINI_SYSTEM_MD env var.
  systemPromptFlag: undefined,
  systemPromptEnvVar: "GEMINI_SYSTEM_MD",
  // Gemini CLI does not expose cost data in its JSON session files — cost not tracked.
  // Gemini CLI stores sessions at ~/.gemini/tmp/<sha256(workspacePath)>/chats/
  // (SHA-256 encoding), not the path-mangling scheme used by Claude Code.
  getSessionDir: (workspacePath: string) =>
    join(homedir(), ".gemini", "tmp", toGeminiProjectPath(workspacePath), "chats"),
  // Gemini CLI session files use .json extension, not .jsonl
  sessionFileExtension: ".json",
  // Gemini CLI uses "run_shell_command" for shell execution, not "Bash"
  hookToolMatcher: "run_shell_command",
};

// =============================================================================
// Gemini-specific overrides
// Pre-trust the workspace folder so Gemini CLI skips the interactive
// "Do you trust the files in this folder?" prompt in unattended sessions.
// Gemini stores trusted folders in ~/.gemini/trustedFolders.json as
// { "/path/to/workspace": "TRUST_FOLDER" }.
// Also strips the model flag: Gemini CLI uses its own model naming
// (e.g. "gemini-2.5-pro") incompatible with Anthropic API model IDs.
// =============================================================================

const geminiOverrides: Partial<Agent> = {
  getLaunchCommand(launchConfig: AgentLaunchConfig): string {
    // Pre-add the workspace to ~/.gemini/trustedFolders.json so Gemini CLI
    // skips the interactive trust dialog in unattended sessions.
    const preTrust = [
      `python3 -c "import json,os; tf=os.path.expanduser('~/.gemini/trustedFolders.json'); d=json.load(open(tf)) if os.path.exists(tf) else {}; d[os.getcwd()]='TRUST_FOLDER'; open(tf,'w').write(json.dumps(d,indent=2))"`,
    ].join(" && ");
    // Strip model: Gemini CLI uses its own model naming convention
    // incompatible with Anthropic API model IDs (causes "model not found" error).
    const { model: _ignored, ...launchConfigWithoutModel } = launchConfig;
    const agentCmd = createAgentPlugin(geminiConfig).getLaunchCommand(launchConfigWithoutModel);
    return `( ${preTrust} ); ${agentCmd}`;
  },
};

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createAgentPlugin(geminiConfig, geminiOverrides);
}

/** Reset the ps process cache. Exported for testing only. */
export const resetPsCache = _resetPsCache;

export default { manifest, create } satisfies PluginModule<Agent>;
