import {
  setupMcpMailInWorkspace,
  isWaferModel,
  isZaiModel,
  stripProviderPrefix,
  isCustomProviderModel,
} from "@jleechanorg/ao-plugin-agent-base";
import {
  DEFAULT_READY_THRESHOLD_MS,
  shellEscape,
  asValidOpenCodeSessionId,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
  type RuntimeHandle,
  type Session,
  type OpenCodeAgentConfig,
  type WorkspaceHooksConfig,
} from "@jleechanorg/ao-core";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Escapes a string for safe use inside double-quoted shell strings.
 * Escapes: " $ ` \
 */
function escapeForDoubleQuotes(str: string): string {
  return str.replace(/(["`$\\])/g, "\\$1");
}

interface OpenCodeSessionListEntry {
  id: string;
  title?: string;
  updated?: string | number;
}

function parseUpdatedTimestamp(updated: string | number | undefined): Date | null {
  if (typeof updated === "number") {
    if (!Number.isFinite(updated)) return null;
    const date = new Date(updated);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof updated !== "string") return null;

  const trimmed = updated.trim();
  if (trimmed.length === 0) return null;

  if (/^\d+$/.test(trimmed)) {
    const epochMs = Number(trimmed);
    if (!Number.isFinite(epochMs)) return null;
    const date = new Date(epochMs);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsedMs = Date.parse(trimmed);
  if (!Number.isFinite(parsedMs)) return null;
  return new Date(parsedMs);
}

function parseSessionList(raw: string): OpenCodeSessionListEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is OpenCodeSessionListEntry => {
    if (!item || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    return asValidOpenCodeSessionId(record["id"]) !== undefined;
  });
}

// =============================================================================
// Terminal output patterns (hoisted to avoid repeated allocation)
// =============================================================================

/** Patterns where the agent is blocked on an interactive prompt — needs human input. */
const INTERACTIVE_PROMPT_PATTERNS: readonly RegExp[] = [
  /\[[yY]\/[nN]\]/, // [y/n], [Y/n], [y/N], etc.
  /\[[yY][eE][sS]\/[nN][oO]\]/, // [yes/no], [YES/NO], etc.
  /\bconfirm\??\b/i, // "confirm?" or "confirm" as a standalone word
  /^\s*[→\-•]\s*$/m, // arrow/hyphen/bullet-only line (menu selection)
];

/** Patterns where the agent is waiting neutrally — AO can send work. */
const NEUTRAL_WAIT_PATTERNS: readonly RegExp[] = [
  /press .* to (continue|submit|send|confirm|run)/i,
  /\b(q|quit|exit|cancel)\b.*\bto\b/i,
  /\bwaiting\b/i,
  /\bready\b/i,
  /proceed\??\b/i, // "proceed?" or "proceed" as a standalone word
  /\boptions?\b.*\bselect\b/i, // "option select" or "options, select"
];

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "opencode",
  slot: "agent" as const,
  description: "Agent plugin: OpenCode",
  version: "0.1.0",
  displayName: "OpenCode",
};

// =============================================================================
// Agent Implementation
// =============================================================================

function createOpenCodeAgent(): Agent {
  return {
    name: "opencode",
    processName: "opencode",
    supportsSystemPromptFile: true,

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["opencode", "run", "--format", "json"];

      const existingSessionId = asValidOpenCodeSessionId(
        (config.projectConfig.agentConfig as OpenCodeAgentConfig | undefined)?.opencodeSessionId,
      );

      const isResuming = !!existingSessionId;

      if (existingSessionId) {
        parts.push("--session", shellEscape(existingSessionId));
      } else {
        parts.push("--title", shellEscape(`AO:${config.sessionId}`));
      }

      if (config.model) {
        const modelArg = isCustomProviderModel(config.model)
          ? stripProviderPrefix(config.model)
          : config.model;
        if (!modelArg) {
          throw new Error(
            `[ao-plugin-agent-opencode] Invalid model "${config.model}": provider prefix with no model name`,
          );
        }
        parts.push("--model", shellEscape(modelArg));
      }

      if (config.subagent) {
        parts.push("--agent", shellEscape(config.subagent));
      }

      let combinedPrompt = "";
      if (config.systemPromptFile) {
        combinedPrompt = `$(cat ${shellEscape(config.systemPromptFile)})`;
        if (config.prompt) {
          combinedPrompt = `"${combinedPrompt}\n\n${escapeForDoubleQuotes(config.prompt)}"`;
        } else {
          combinedPrompt = `"${combinedPrompt}"`;
        }
      } else if (config.systemPrompt) {
        combinedPrompt = config.systemPrompt;
        if (config.prompt) {
          combinedPrompt = `${config.systemPrompt}\n\n${config.prompt}`;
        }
      } else if (config.prompt) {
        combinedPrompt = config.prompt;
      }

      if (isResuming) {
        if (combinedPrompt) {
          if (config.systemPromptFile) {
            parts.push("--prompt", combinedPrompt);
          } else {
            parts.push("--prompt", shellEscape(combinedPrompt));
          }
        }
      } else {
        if (combinedPrompt) {
          if (config.systemPromptFile) {
            parts.push(combinedPrompt);
          } else {
            parts.push(shellEscape(combinedPrompt));
          }
        } else {
          parts.push(shellEscape("."));
        }
      }

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;

      // Route provider models to their OpenAI-compatible proxies.
      // Wafer: the opencodew() bashrc function pattern.
      // ZAI: the claudeg()-equivalent pattern for opencode.
      if (isWaferModel(config.model)) {
        env["OPENAI_BASE_URL"] = "https://pass.wafer.ai/v1";
        const waferKey = process.env["WAFER_API_KEY"];
        if (waferKey) {
          env["OPENAI_API_KEY"] = waferKey;
        } else {
          console.warn(
            "[ao-plugin-agent-opencode] WAFER_API_KEY is not set — opencode may fail to authenticate with wafer.",
          );
        }
      } else if (isZaiModel(config.model)) {
        env["OPENAI_BASE_URL"] = "https://api.z.ai/v1";
        const glmKey = process.env["GLM_API_KEY"];
        if (glmKey) {
          env["OPENAI_API_KEY"] = glmKey;
        } else {
          console.warn(
            "[ao-plugin-agent-opencode] GLM_API_KEY is not set — opencode may fail to authenticate with ZAI.",
          );
        }
      }

      // Pass MCP mail configuration to the agent if available
      if (process.env.MCP_AGENT_MAIL_URL) {
        env["MCP_AGENT_MAIL_URL"] = process.env.MCP_AGENT_MAIL_URL;
      }
      if (process.env.MCP_AGENT_MAIL_TOKEN) {
        env["MCP_AGENT_MAIL_TOKEN"] = process.env.MCP_AGENT_MAIL_TOKEN;
      }
      // NOTE: AO_PROJECT_ID is the caller's responsibility (spawn.ts sets it)
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }
      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";

      for (const p of INTERACTIVE_PROMPT_PATTERNS) {
        if (p.test(terminalOutput)) return "waiting_input";
      }

      // Standalone "?" on its own line (not mid-sentence "?...") — check only the last line
      const lastLine = terminalOutput.trimEnd().split("\n").at(-1) ?? "";
      if (/^\s*\?\s*$/.test(lastLine)) return "waiting_input";

      for (const p of NEUTRAL_WAIT_PATTERNS) {
        if (p.test(terminalOutput)) return "ready";
      }

      return "active";
    },

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      await setupMcpMailInWorkspace(workspacePath, ".opencode");
    },
    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;
      const activeWindowMs = Math.min(30_000, threshold);

      // Check if process is running first
      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      try {
        const { stdout } = await execFileAsync(
          "opencode",
          ["session", "list", "--format", "json"],
          {
            timeout: 30_000,
          },
        );

        const sessions = parseSessionList(stdout);
        const targetSession =
          (session.metadata?.opencodeSessionId
            ? sessions.find((s) => s.id === session.metadata.opencodeSessionId)
            : undefined) ?? sessions.find((s) => s.title === `AO:${session.id}`);

        if (targetSession) {
          const lastActivity = parseUpdatedTimestamp(targetSession.updated);

          if (lastActivity) {
            const ageMs = Math.max(0, Date.now() - lastActivity.getTime());
            if (ageMs <= activeWindowMs) {
              return { state: "active", timestamp: lastActivity };
            }
            if (ageMs <= threshold) {
              return { state: "ready", timestamp: lastActivity };
            }
            return { state: "idle", timestamp: lastActivity };
          }

          return null;
        }
      } catch {
        return null;
      }

      return null;
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
          const processRe = /(?:^|\/)opencode(?:\s|$)/;
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

    async getSessionInfo(_session: Session): Promise<AgentSessionInfo | null> {
      // OpenCode doesn't have JSONL session files for introspection yet
      return null;
    },
  };
}

function buildSessionIdCaptureScript(): string {
  const script = `
let buffer = '';
let captured = null;
const extract = obj => {
  if (!obj || captured) return;
  for (const key of ['sessionID', 'session_id', 'id']) {
    const val = obj[key];
    if (typeof val === 'string' && /^ses_[A-Za-z0-9_-]+$/.test(val)) {
      captured = val;
      return;
    }
  }
};
process.stdin.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (captured) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { extract(JSON.parse(trimmed)); } catch {}
  }
}).on('end', () => {
  if (buffer.trim()) {
    try { extract(JSON.parse(buffer.trim())); } catch {}
  }
  if (captured) {
    process.stdout.write(captured);
    process.exit(0);
  }
  process.exit(1);
});
  `.trim();
  return script.replace(/\n/g, " ").replace(/\s+/g, " ");
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createOpenCodeAgent();
}

export { buildSessionIdCaptureScript };

export function detect(): boolean {
  try {
    execFileSync("opencode", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
