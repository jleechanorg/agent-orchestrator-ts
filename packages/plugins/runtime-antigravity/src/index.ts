/**
 * Antigravity Runtime Plugin — entry point.
 *
 * Exports the plugin manifest and factory function
 * conforming to the ao-core PluginModule interface.
 */

import type { PluginModule, Runtime } from "@jleechanorg/ao-core";
import { createAntigravityRuntime } from "./runtime.js";
export type { FallbackConfig, FallbackResult } from "./fallback.js";
export { executeWithFallback } from "./fallback.js";

export const manifest = {
  name: "antigravity",
  slot: "runtime" as const,
  description: "Runtime plugin: Antigravity IDE via Peekaboo",
  version: "0.1.0",
};

export function create(): Runtime {
  return createAntigravityRuntime();
}

export default { manifest, create } satisfies PluginModule<Runtime>;
