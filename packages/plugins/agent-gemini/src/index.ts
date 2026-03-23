import {
  createAgentPlugin,
  toAgentProjectPath,
  resetPsCache as _resetPsCache,
  findLatestSessionFile,
  type AgentPluginConfig,
} from "@jleechanorg/ao-plugin-agent-base";
import {
  DEFAULT_READY_THRESHOLD_MS,
  readLastJsonlEntry,
  type Agent,
  type AgentLaunchConfig,
  type ActivityDetection,
  type PluginModule,
  type ProjectConfig,
  type Session,
} from "@jleechanorg/ao-core";
import { readFile, stat } from "node:fs/promises";
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
  // Gemini CLI settings.json uses AfterTool/BeforeTool; Claude Code uses PostToolUse/PreToolUse
  hookEventNames: { postToolUse: "AfterTool", preToolUse: "BeforeTool" },
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

// =============================================================================
// Gemini native JSON session reader (orch-cb3e: done-signal)
// =============================================================================

/**
 * Read the last message type from a Gemini native session file.
 *
 * Gemini CLI stores sessions as a top-level JSON object:
 *   { sessionId, messages: [{ type, content, id, timestamp }, ...] }
 * The last entry in messages[] is the current agent state.
 *
 * Gemini message types (observed in production):
 *   "user"   → user prompt pending response → active
 *   "gemini" → agent completed its turn     → ready (done-signal)
 *   "error"  → error occurred               → blocked
 *   "info"   → informational                → active
 */
async function readLastGeminiNativeEntry(
  filePath: string,
): Promise<{ lastType: string | null; modifiedAt: Date } | null> {
  try {
    const [content, fileStat] = await Promise.all([readFile(filePath, "utf-8"), stat(filePath)]);
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.messages) || obj.messages.length === 0) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lastMsg = obj.messages[obj.messages.length - 1] as any;
    const lastType = typeof lastMsg?.type === "string" ? lastMsg.type : null;
    return { lastType, modifiedAt: fileStat.mtime };
  } catch {
    return null;
  }
}

const geminiOverrides: Partial<Agent> = {
  async getRestoreCommand(_session: Session, _project: ProjectConfig): Promise<string | null> {
    // TODO: Implement restore via ~/.gemini/tmp/<sha256>/chats/ session files.
    // Returning null prevents the base plugin from building a restore command that
    // would pass --model with an Anthropic model ID (rejected by gemini CLI).
    return null;
  },

  async getActivityState(
    session: Session,
    readyThresholdMs?: number,
  ): Promise<ActivityDetection | null> {
    const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;

    // Check if process is running first
    const exitedAt = new Date();
    if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
    const running = await this.isProcessRunning!(session.runtimeHandle);
    if (!running) return { state: "exited", timestamp: exitedAt };

    if (!session.workspacePath) return null;

    const projectDir = geminiConfig.getSessionDir(session.workspacePath);

    const sessionFile = await findLatestSessionFile(projectDir, ".json");
    if (!sessionFile) return null;

    // Try native Gemini JSON format first: { sessionId, messages: [...] }
    const nativeEntry = await readLastGeminiNativeEntry(sessionFile);
    // Only use native entry if lastType is a known string; null means the entry
    // exists but has no string `type`, so fall through to JSONL rather than
    // mis-classifying via the `default` branch.
    if (nativeEntry && nativeEntry.lastType !== null) {
      const ageMs = Date.now() - nativeEntry.modifiedAt.getTime();
      const timestamp = nativeEntry.modifiedAt;
      switch (nativeEntry.lastType) {
        case "gemini": // agent completed its turn — done signal
          return { state: ageMs > threshold ? "idle" : "ready", timestamp };
        case "error":
          return { state: "blocked", timestamp };
        case "user":
        case "info":
          return { state: ageMs > threshold ? "idle" : "active", timestamp };
        default:
          // Unknown type — fall through to JSONL to avoid false-active/idle
          break;
      }
    }

    // Fall back to JSONL-style format (one JSON object per line)
    // This handles test fixtures and any future format changes.
    const entry = await readLastJsonlEntry(sessionFile);
    if (!entry) return null;

    const ageMs = Date.now() - entry.modifiedAt.getTime();
    const timestamp = entry.modifiedAt;
    switch (entry.lastType) {
      case "user":
      case "tool_use":
      case "progress":
        return { state: ageMs > threshold ? "idle" : "active", timestamp };
      case "assistant":
      case "system":
      case "summary":
      case "result":
        return { state: ageMs > threshold ? "idle" : "ready", timestamp };
      case "permission_request":
        return { state: "waiting_input", timestamp };
      case "error":
        return { state: "blocked", timestamp };
      default:
        return { state: ageMs > threshold ? "idle" : "active", timestamp };
    }
  },

  getLaunchCommand(launchConfig: AgentLaunchConfig): string {
    // Pre-add the workspace to ~/.gemini/trustedFolders.json so Gemini CLI
    // skips the interactive trust dialog in unattended sessions.
    const preTrust = [
      `python3 -c "import json,os; tf=os.path.expanduser('~/.gemini/trustedFolders.json'); os.makedirs(os.path.dirname(tf),exist_ok=True); d=json.load(open(tf)) if os.path.exists(tf) else {}; d[os.getcwd()]='TRUST_FOLDER'; open(tf,'w').write(json.dumps(d,indent=2))"`,
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
