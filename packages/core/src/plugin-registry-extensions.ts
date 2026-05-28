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
import { computeLoadOrder, type LoadOrderEntry } from "./plugin-load-order.js";
import {
  checkPluginVersionMismatch,
  formatVersionMismatchWarning,
} from "./plugin-version-check.js";

export function applyForkExtensions(registry: PluginRegistry): void {
  const origRegister = registry.register.bind(registry);

  registry.register = (plugin, config) => {
    const warning = checkPluginVersionMismatch(plugin.manifest);
    if (warning) {
      console.warn(formatVersionMismatchWarning(warning));
    }
    origRegister(plugin, config);
  };
}

export { computeLoadOrder, type LoadOrderEntry };
export { checkPluginVersionMismatch, formatVersionMismatchWarning } from "./plugin-version-check.js";
