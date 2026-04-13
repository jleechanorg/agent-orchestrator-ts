/**
 * MCP tool definitions for AO operations.
 * Exposes AO CLI operations as Model Context Protocol tools.
 */

import * as cli from "./cli-wrapper.js";

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<McpToolResult>;
}

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: "text", text }], isError };
}

function str(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

function bool(val: unknown): boolean | undefined {
  return typeof val === "boolean" ? val : undefined;
}

/**
 * Create all AO MCP tool definitions.
 */
export function createMcpTools(): McpToolDefinition[] {
  return [
    {
      name: "ao_spawn",
      description: "Spawn a new AO agent session",
      inputSchema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "Task description / prompt for the spawned session (mutually exclusive with 'issue'; if both are provided, 'task' takes precedence)",
          },
          issue: {
            type: "string",
            description:
              "Issue identifier (bead ID or issue number) (mutually exclusive with 'task'; 'task' takes precedence if both are provided)",
          },
          project: {
            type: "string",
            description: "Project ID (auto-detected if not provided)",
          },
          agent: {
            type: "string",
            description: "Agent plugin name (e.g. codex, claude-code, antigravity)",
          },
          runtime: {
            type: "string",
            description: "Runtime to use (e.g. tmux, antigravity)",
          },
          open: {
            type: "boolean",
            description: "Open session in terminal tab",
            default: false,
          },
          claim_pr: {
            type: "string",
            description: "PR number or URL to claim",
          },
        },
      },
      async handler(args) {
        try {
          const result = await cli.aoSpawn({
            task: str(args.task),
            issue: str(args.issue),
            project: str(args.project),
            agent: str(args.agent),
            runtime: str(args.runtime),
            open: bool(args.open),
            claimPr: str(args.claim_pr),
          });

          if (result.success) {
            return textResult(result.stdout || "Session spawned successfully");
          } else {
            return textResult(result.stderr || result.stdout || "Spawn failed", true);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return textResult(`Failed to spawn: ${msg}`, true);
        }
      },
    },
    {
      name: "ao_send",
      description: "Send a message to an active AO session",
      inputSchema: {
        type: "object",
        properties: {
          session: {
            type: "string",
            description: "Session name to send the message to",
          },
          message: {
            type: "string",
            description: "Message to send to the session",
          },
          file: {
            type: "string",
            description: "Path to file whose contents should be sent",
          },
          no_wait: {
            type: "boolean",
            description: "Don't wait for session to become idle before sending",
            default: false,
          },
          timeout: {
            type: "number",
            description: "Max seconds to wait for idle (default: 600)",
          },
        },
        required: ["session", "message"],
      },
      async handler(args) {
        try {
          const result = await cli.aoSend({
            session: str(args.session) ?? "",
            message: str(args.message) ?? "",
            file: str(args.file),
            wait: args.no_wait !== true,
            timeout: typeof args.timeout === "number" ? args.timeout : undefined,
          });

          if (result.success) {
            return textResult(result.stdout || "Message sent successfully");
          } else {
            return textResult(result.stderr || result.stdout || "Send failed", true);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return textResult(`Failed to send: ${msg}`, true);
        }
      },
    },
    {
      name: "ao_session_list",
      description: "List all AO sessions with their status",
      inputSchema: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description: "Filter by project ID",
          },
        },
      },
      async handler(args) {
        try {
          const result = await cli.aoSessionList({
            project: str(args.project),
          });

          if (result.success) {
            return textResult(result.stdout || "No sessions found");
          } else {
            return textResult(result.stderr || result.stdout || "Failed to list sessions", true);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return textResult(`Failed to list sessions: ${msg}`, true);
        }
      },
    },
    {
      name: "ao_session_kill",
      description: "Kill an AO session and remove its worktree",
      inputSchema: {
        type: "object",
        properties: {
          session: {
            type: "string",
            description: "Session name to kill",
          },
          keep_session: {
            type: "boolean",
            description: "Keep mapped OpenCode session after kill",
            default: false,
          },
          purge_session: {
            type: "boolean",
            description: "Delete mapped OpenCode session during kill",
            default: false,
          },
        },
        required: ["session"],
      },
      async handler(args) {
        try {
          const result = await cli.aoSessionKill({
            session: str(args.session) ?? "",
            keepSession: bool(args.keep_session),
            purgeSession: bool(args.purge_session),
          });

          if (result.success) {
            return textResult(result.stdout || "Session killed");
          } else {
            return textResult(result.stderr || result.stdout || "Kill failed", true);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return textResult(`Failed to kill session: ${msg}`, true);
        }
      },
    },
    {
      name: "ao_status",
      description: "Show AO status including lifecycle worker and queue state",
      inputSchema: {
        type: "object",
        properties: {},
      },
      async handler(_args) {
        try {
          const result = await cli.execAo(["status"]);
          if (result.success) {
            return textResult(result.stdout || "AO is running");
          } else {
            return textResult(result.stderr || result.stdout || "Status check failed", true);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return textResult(`Failed to get status: ${msg}`, true);
        }
      },
    },
  ];
}
