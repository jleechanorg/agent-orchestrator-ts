/**
 * Antigravity Runtime Plugin — entry point.
 *
 * Exports the plugin manifest and factory function
 * conforming to the ao-core PluginModule interface.
 */

import type { PluginModule, Runtime } from "@jleechanorg/ao-core";
import { createAntigravityRuntime } from "./runtime.js";
import { parseConfig } from "./config.js";

export {
  AntigravityConfigSchema,
  WorkspaceMapSchema,
  parseConfig,
  defaultConfig,
} from "./config.js";
export type { AntigravityConfig, WorkspaceMap } from "./config.js";

export const manifest = {
  name: "antigravity",
  slot: "runtime" as const,
  description: "Runtime plugin: Antigravity IDE via Peekaboo",
  version: "0.1.0",
};

export function create(options?: unknown): Runtime {
  const config = parseConfig(options ?? {});
  return createAntigravityRuntime(config);
}

export default { manifest, create } satisfies PluginModule<Runtime>;

