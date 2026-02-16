import {
  shellEscape,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityState,
  type PluginModule,
  type RuntimeHandle,
  type Session,
} from "@composio/ao-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat, access } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";

const execFileAsync = promisify(execFile);

// =============================================================================
// Aider Activity Detection Helpers
// =============================================================================

/**
 * Check if Aider has made recent commits (within last 60 seconds).
 */
async function hasRecentCommits(workspacePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "--since=60 seconds ago", "--format=%H"],
      { cwd: workspacePath, timeout: 5_000 },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Get modification time of Aider chat history file.
 */
async function getChatHistoryMtime(workspacePath: string): Promise<Date | null> {
  try {
    const chatFile = join(workspacePath, ".aider.chat.history.md");
    await access(chatFile, constants.R_OK);
    const stats = await stat(chatFile);
    return stats.mtime;
  } catch {
    return null;
  }
}

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "aider",
  slot: "agent" as const,
  description: "Agent plugin: Aider",
  version: "0.1.0",
};

// =============================================================================
// Agent Implementation
// =============================================================================

function createAiderAgent(): Agent {
  return {
    name: "aider",
    processName: "aider",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["aider"];

      if (config.permissions === "skip") {
        parts.push("--yes");
      }

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      if (config.prompt) {
        parts.push("--message", shellEscape(config.prompt));
      }

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      // NOTE: AO_PROJECT_ID is the caller's responsibility (spawn.ts sets it)
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }
      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";
      // Aider doesn't have rich terminal output patterns yet
      return "active";
    },

    async getActivityState(session: Session): Promise<ActivityState> {
      // Check if process is running first
      if (!session.runtimeHandle) return "exited";
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return "exited";

      // Process is running - check for activity signals
      if (!session.workspacePath) return "active";

      // Check for recent git commits (Aider auto-commits changes)
      const hasCommits = await hasRecentCommits(session.workspacePath);
      if (hasCommits) return "active";

      // Check chat history file modification time
      const chatMtime = await getChatHistoryMtime(session.workspacePath);
      if (!chatMtime) {
        // No chat history yet, but process is running - assume active
        return "active";
      }

      // If chat file was modified within last 30 seconds, consider active
      const ageMs = Date.now() - chatMtime.getTime();
      if (ageMs < 30_000) return "active";

      // No recent activity - idle at prompt
      return "idle";
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      try {
        if (handle.runtimeName === "tmux" && handle.id) {
          const { stdout: ttyOut } = await execFileAsync(
            "tmux",
            ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
            { timeout: 30_000 },
          );
          const ttys = ttyOut
            .trim()
            .split("\n")
            .map((t) => t.trim())
            .filter(Boolean);
          if (ttys.length === 0) return false;

          const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
            timeout: 30_000,
          });
          const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
          const processRe = /(?:^|\/)aider(?:\s|$)/;
          for (const line of psOut.split("\n")) {
            const cols = line.trimStart().split(/\s+/);
            if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
            const args = cols.slice(2).join(" ");
            if (processRe.test(args)) {
              return true;
            }
          }
          return false;
        }

        const rawPid = handle.data["pid"];
        const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            return true;
          } catch (err: unknown) {
            if (err instanceof Error && "code" in err && err.code === "EPERM") {
              return true;
            }
            return false;
          }
        }

        return false;
      } catch {
        return false;
      }
    },

    // NOTE: Aider lacks introspection to distinguish "processing" from "idle at prompt".
    // Falling back to process liveness until richer detection is implemented (see #18).
    async isProcessing(session: Session): Promise<boolean> {
      if (!session.runtimeHandle) return false;
      return this.isProcessRunning(session.runtimeHandle);
    },

    async getSessionInfo(_session: Session): Promise<AgentSessionInfo | null> {
      // Aider doesn't have JSONL session files for introspection yet
      return null;
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createAiderAgent();
}

export default { manifest, create } satisfies PluginModule<Agent>;
