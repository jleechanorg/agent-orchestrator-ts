import {
  setupMcpMailInWorkspace,
  stripProviderPrefix,
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

export const DEFAULT_OPENW_OPENAI_BASE_URL = "https://pass.wafer.ai/v1";
export const DEFAULT_OPENW_MODEL = "wafer.ai/GLM-5.1";

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

function buildSessionIdCaptureScript(): string {
  const script = `
let buffer = '';
let captured = null;
process.stdin.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (captured) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.session_id === 'string' && /^ses_[A-Za-z0-9_-]+$/.test(obj.session_id)) {
        captured = obj.session_id;
      }
    } catch {}
  }
}).on('end', () => {
  if (buffer.trim()) {
    try {
      const obj = JSON.parse(buffer.trim());
      if (obj && typeof obj.session_id === 'string' && /^ses_[A-Za-z0-9_-]+$/.test(obj.session_id)) {
        captured = obj.session_id;
      }
    } catch {}
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

function buildSessionLookupScript(): string {
  const script = `
let input = '';
process.stdin.on('data', c => input += c).on('end', () => {
  const title = process.argv[1];
  let rows;
  try { rows = JSON.parse(input); } catch { process.exit(1); }
  if (!Array.isArray(rows)) process.exit(1);
  const isValidId = id => /^ses_[A-Za-z0-9_-]+$/.test(id);
  const timestamp = value => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    }
    return Number.NEGATIVE_INFINITY;
  };
  const matches = rows
    .filter(r => r && r.title === title && typeof r.id === 'string' && isValidId(r.id))
    .sort((a, b) => {
      const ta = timestamp(a.updated);
      const tb = timestamp(b.updated);
      if (ta === tb) return 0;
      return tb - ta;
    });
  if (matches.length === 0) process.exit(1);
  process.stdout.write(matches[0].id);
});
  `.trim();
  return script.replace(/\n/g, " ").replace(/\s+/g, " ");
}

// Structural [y/N] / [yes/no] UI widgets emitted by OpenCode — deterministic, not semantic.
const CONFIRMATION_WIDGET_RE = /\[[yY]\/[nN]\]|\[[yY][eE][sS]\/[nN][oO]\]/;

export const manifest = {
  name: "openw",
  slot: "agent" as const,
  description: "Agent plugin: OpenW (Wafer via OpenCode)",
  version: "0.1.0",
  displayName: "OpenW (Wafer via OpenCode)",
};

function createOpenWAgent(): Agent {
  return {
    name: "openw",
    processName: "opencode",
    supportsSystemPromptFile: true,

    getLaunchCommand(config: AgentLaunchConfig): string {
      const options: string[] = [];
      const sharedOptions: string[] = [];

      const existingSessionId = asValidOpenCodeSessionId(
        (config.projectConfig.agentConfig as OpenCodeAgentConfig | undefined)?.opencodeSessionId,
      );

      if (existingSessionId) {
        options.push("--session", shellEscape(existingSessionId));
      }

      if (config.subagent) {
        sharedOptions.push("--agent", shellEscape(config.subagent));
      }

      const model = process.env.OPENW_MODEL?.trim() || DEFAULT_OPENW_MODEL;
      const stripped = stripProviderPrefix(model);
      if (!stripped) {
        throw new Error(
          `[ao-plugin-agent-openw] Invalid model "${model}": provider prefix with no model name`,
        );
      }
      sharedOptions.push("--model", shellEscape(stripped));

      let promptValue: string | undefined;
      if (config.prompt) {
        if (config.systemPromptFile) {
          promptValue = `"$(cat ${shellEscape(config.systemPromptFile)}; printf '\\n\\n'; printf %s ${shellEscape(config.prompt)})"`;
        } else if (config.systemPrompt) {
          promptValue = shellEscape(`${config.systemPrompt}\n\n${config.prompt}`);
        } else {
          promptValue = shellEscape(config.prompt);
        }
      } else if (config.systemPromptFile) {
        promptValue = `"$(cat ${shellEscape(config.systemPromptFile)})"`;
      } else if (config.systemPrompt) {
        promptValue = shellEscape(config.systemPrompt);
      }

      if (!existingSessionId) {
        const runOptions = [
          "--format",
          "json",
          "--title",
          shellEscape(`AO:${config.sessionId}`),
          ...sharedOptions,
        ];
        const captureScript = buildSessionIdCaptureScript();
        const fallbackScript = buildSessionLookupScript();
        const runCommand = ["opencode", "run", ...runOptions, "--command", "true"].join(" ");
        const resumeOptions = [...(promptValue ? ["--prompt", promptValue] : []), ...sharedOptions];
        const resumeOptionsSuffix = resumeOptions.length > 0 ? ` ${resumeOptions.join(" ")}` : "";
        const missingSessionError = shellEscape(
          `failed to discover OpenCode session ID for AO:${config.sessionId}`,
        );
        return [
          `SES_ID=$(${runCommand} | node -e ${shellEscape(captureScript)})`,
          `if [ -z "$SES_ID" ]; then SES_ID=$(opencode session list --format json | node -e ${shellEscape(fallbackScript)} ${shellEscape(`AO:${config.sessionId}`)}); fi`,
          `[ -n "$SES_ID" ] && exec opencode --session "$SES_ID"${resumeOptionsSuffix}; echo ${missingSessionError} >&2; exit 1`,
        ].join("; ");
      }

      if (promptValue) {
        options.push("--prompt", promptValue);
      }

      options.push(...sharedOptions);

      return ["opencode", ...options].join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;

      env["OPENAI_BASE_URL"] = process.env.OPENW_OPENAI_BASE_URL?.trim() || DEFAULT_OPENW_OPENAI_BASE_URL;

      const waferKey = process.env["WAFER_API_KEY"];
      if (waferKey) {
        env["OPENAI_API_KEY"] = waferKey;
        console.debug("[ao-plugin-agent-openw] WAFER_API_KEY resolved");
      } else {
        // Explicitly blank OPENAI_API_KEY to prevent inheriting a dev machine's
        // OpenAI key and sending it to Wafer's endpoint.
        env["OPENAI_API_KEY"] = "";
        console.error(
          "[ao-plugin-agent-openw] WAFER_API_KEY not found. Set WAFER_API_KEY in your environment or in a file listed under envSource in agent-orchestrator.yaml.",
        );
      }

      if (process.env.MCP_AGENT_MAIL_URL) {
        env["MCP_AGENT_MAIL_URL"] = process.env.MCP_AGENT_MAIL_URL;
      }
      if (process.env.MCP_AGENT_MAIL_TOKEN) {
        env["MCP_AGENT_MAIL_TOKEN"] = process.env.MCP_AGENT_MAIL_TOKEN;
      }
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }
      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";

      const lastLine = terminalOutput.trimEnd().split("\n").at(-1) ?? "";

      // Structural [y/N] / [yes/no] widgets — OpenCode renders these as literal UI chrome.
      if (CONFIRMATION_WIDGET_RE.test(lastLine)) return "waiting_input";

      // OpenCode idle prompt: last line is bare `>` or `> ` with no other content.
      if (/^>\s*$/.test(lastLine)) return "idle";

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

      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      try {
        const { stdout } = await execFileAsync(
          "opencode",
          ["session", "list", "--format", "json"],
          { timeout: 30_000 },
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
      return null;
    },
  };
}

export function create(): Agent {
  return createOpenWAgent();
}

export function detect(): boolean {
  try {
    execFileSync("opencode", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
