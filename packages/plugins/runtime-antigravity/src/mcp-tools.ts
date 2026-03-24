/**
 * MCP tool definitions for the Antigravity runtime.
 *
 * Exposes Antigravity operations as Model Context Protocol tools
 * callable from any Claude session or MCP client.
 */

import type { Runtime, RuntimeHandle } from "@jleechanorg/ao-core";
import * as peekaboo from "./peekaboo.js";

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

/**
 * Create all Antigravity MCP tool definitions.
 *
 * @param runtime - The Antigravity runtime instance
 * @param sessionStore - Shared map of active session handles
 */
export function createMcpTools(
  runtime: Runtime,
  sessionStore: Map<string, RuntimeHandle>,
): McpToolDefinition[] {
  return [
    {
      name: "antigravity_spawn",
      description:
        "Start a new Antigravity IDE conversation to execute a coding task",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Task description / prompt" },
          workspace: {
            type: "string",
            description: "Workspace path or name",
          },
        },
        required: ["task"],
      },
      async handler(args) {
        const task = String(args["task"] ?? "");
        const workspace = String(args["workspace"] ?? ".");
        const sessionId = `antig-${Date.now()}`;

        try {
          const handle = await runtime.create({
            sessionId,
            workspacePath: workspace,
            launchCommand: task,
            environment: {},
          });
          sessionStore.set(sessionId, handle);
          return textResult(
            `Session ${sessionId} created in workspace "${workspace}"`,
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return textResult(`Failed to spawn: ${msg}`, true);
        }
      },
    },
    {
      name: "antigravity_status",
      description:
        "List all active and idle Antigravity conversations with their status",
      inputSchema: { type: "object", properties: {} },
      async handler() {
        try {
          const windows = await peekaboo.windowList("Antigravity");
          const managerWindow = windows.find((w) =>
            w.title.toLowerCase().includes("manager"),
          );

          if (!managerWindow) {
            return textResult("Antigravity Manager window not found");
          }

          const snapshot = await peekaboo.see(
            "Antigravity",
            managerWindow.window_id,
          );
          const conversations = snapshot.ui_elements.filter(
            (el) =>
              el.role === "button" &&
              (el.title.includes("progress_activity") ||
                /\d+[mhd]$/.test(el.title.trim())),
          );

          if (conversations.length === 0) {
            return textResult("No conversations found");
          }

          const lines = conversations.map((c) => {
            const isActive =
              c.title.includes("progress_activity") ||
              c.title.includes("now");
            const title = c.title
              .replace("progress_activity ", "")
              .replace(" now", "")
              .trim();
            return `${isActive ? "[ACTIVE]" : "[IDLE]  "} ${title}`;
          });

          return textResult(lines.join("\n"));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return textResult(`Failed to get status: ${msg}`, true);
        }
      },
    },
    {
      name: "antigravity_kill",
      description: "Cancel and clean up a running Antigravity conversation",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Session ID to kill" },
        },
        required: ["session_id"],
      },
      async handler(args) {
        const sessionId = String(args["session_id"] ?? "");
        const handle = sessionStore.get(sessionId);

        if (!handle) {
          return textResult(`Session "${sessionId}" not found`, true);
        }

        try {
          await runtime.destroy(handle);
          sessionStore.delete(sessionId);
          return textResult(`Session "${sessionId}" destroyed`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return textResult(`Failed to kill: ${msg}`, true);
        }
      },
    },
    {
      name: "antigravity_send",
      description: "Send a follow-up message to an active Antigravity conversation",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Session ID" },
          message: { type: "string", description: "Message to send" },
        },
        required: ["session_id", "message"],
      },
      async handler(args) {
        const sessionId = String(args["session_id"] ?? "");
        const message = String(args["message"] ?? "");
        const handle = sessionStore.get(sessionId);

        if (!handle) {
          return textResult(`Session "${sessionId}" not found`, true);
        }

        try {
          await runtime.sendMessage(handle, message);
          return textResult(`Message sent to "${sessionId}"`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return textResult(`Failed to send: ${msg}`, true);
        }
      },
    },
    {
      name: "antigravity_workspaces",
      description: "List all Antigravity windows and workspaces",
      inputSchema: { type: "object", properties: {} },
      async handler() {
        try {
          const windows = await peekaboo.windowList("Antigravity");
          const lines = windows.map(
            (w) => `${w.window_id}: ${w.title || "(untitled)"}`,
          );
          return textResult(
            lines.length > 0 ? lines.join("\n") : "No Antigravity windows found",
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return textResult(`Failed to list workspaces: ${msg}`, true);
        }
      },
    },
  ];
}
