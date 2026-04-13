/**
 * MCP-AO Runtime Plugin — entry point.
 *
 * Exposes AO CLI operations as MCP tools callable from any MCP client.
 * This is a runtime plugin that also exports MCP tools for use by other plugins.
 */

import type { PluginModule, Runtime } from "@jleechanorg/ao-core";
import { createMinimalRuntime } from "./runtime.js";

export { createMcpTools } from "./mcp-tools.js";
export type { McpToolDefinition, McpToolResult } from "./mcp-tools.js";

export const manifest = {
  name: "mcp-ao",
  slot: "runtime" as const,
  description:
    "MCP server: AO operations (spawn, send, session list, etc.) wrapping the ao CLI commands",
  version: "0.1.0",
};

export function create(_options?: unknown): Runtime {
  return createMinimalRuntime();
}

export default { manifest, create } satisfies PluginModule<Runtime>;
