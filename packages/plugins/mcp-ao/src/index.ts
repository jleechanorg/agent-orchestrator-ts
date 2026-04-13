/**
 * MCP-AO Plugin — entry point.
 *
 * Exposes AO CLI operations as MCP tools callable from any MCP client.
 */

import type { PluginModule } from "@jleechanorg/ao-core";
import { createMcpTools } from "./mcp-tools.js";

export { createMcpTools };
export type { McpToolDefinition, McpToolResult } from "./mcp-tools.js";

export const manifest = {
  name: "mcp-ao",
  slot: "runtime" as const,
  description:
    "MCP server: AO operations (spawn, send, session list, etc.) wrapping the ao CLI commands",
  version: "0.1.0",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function create(_options?: unknown): any {
  return {
    manifest,
    createMcpTools,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default { manifest, create } satisfies PluginModule<any>;
