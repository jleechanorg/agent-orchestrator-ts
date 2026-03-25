/**
 * Prose-Polish Runtime Plugin — entry point.
 */
import type { PluginModule, Runtime } from "@jleechanorg/ao-core";
import { createMinimalRuntime } from "./runtime.js";

export { createMcpTools } from "./mcp-tools.js";
export type { McpToolDefinition, McpToolResult } from "./mcp-tools.js";

export const manifest = {
  name: "prose-polish",
  slot: "runtime" as const,
  description: "Runtime plugin: Fiction prose pattern detector and fixer",
  version: "0.1.0",
};

export function create(_options?: unknown): Runtime {
  return createMinimalRuntime();
}

export default { manifest, create } satisfies PluginModule<Runtime>;
