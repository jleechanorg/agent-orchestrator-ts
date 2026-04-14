/**
 * Fork-only plugin registry extensions.
 *
 * All fork-specific plugin additions and overrides live here.
 * Upstream carries this as a no-op module — plugin-registry.ts imports
 * this file and calls applyForkExtensions() if the function exists.
 *
 * This keeps plugin-registry.ts as pure upstream code, reducing merge conflicts.
 */

import type { PluginRegistry } from "./types.js";

/**
 * Fork-only BUILTIN_PLUGINS additions (upstream doesn't have these):
 * - minimax agent plugin
 * - gemini agent plugin
 * - beads tracker plugin
 * - mcp-mail notifier plugin
 * - antigravity runtime plugin
 * - poller runtime plugin
 * - prose-polish runtime plugin
 *
 * These are NOT added here because the upstream BUILTIN_PLUGINS array
 * already contains these entries. This file is the target for future
 * fork-specific migrations so that plugin-registry.ts stays pure.
 */

/* fork-only: extractPluginConfig override — currently inline in plugin-registry.ts */
/* fork-only: any additional fork-specific plugin registration logic goes here */

export function applyForkExtensions(_registry: PluginRegistry): void {
  // TODO: migrate fork-specific BUILTIN_PLUGINS entries here
  // TODO: migrate extractPluginConfig fork override here

  // Currently a no-op because all fork plugins are already in upstream BUILTIN_PLUGINS.
  // This function exists as the extension point so plugin-registry.ts stays
  // identical to upstream — fork-specific logic can be added here without
  // modifying the upstream file.
}