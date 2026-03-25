/**
 * Minimal runtime for prose-polish.
 */

import type { Runtime, RuntimeHandle, RuntimeCreateConfig } from "@jleechanorg/ao-core";

export function createMinimalRuntime(): Runtime {
  return {
    name: "prose-polish",
    async create(_opts: RuntimeCreateConfig): Promise<RuntimeHandle> {
      return { id: `prose-${Date.now()}`, runtimeName: "prose-polish", data: { sessionId: _opts.sessionId } };
    },
    async destroy(_handle: RuntimeHandle): Promise<void> {},
    async sendMessage(_handle: RuntimeHandle, _message: string): Promise<void> {},
    async getOutput(_handle: RuntimeHandle, _lines?: number): Promise<string> { return ""; },
    async isAlive(_handle: RuntimeHandle): Promise<boolean> { return true; },
  };
}
