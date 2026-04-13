/**
 * Minimal runtime for mcp-ao.
 *
 * Note: This runtime wraps CLI operations, so failures are surfaced
 * through the CLI exit codes rather than through runtime methods.
 * The runtime lifecycle methods (destroy, sendMessage, etc.) delegate
 * to the CLI, which handles error reporting.
 */

import type { Runtime, RuntimeHandle, RuntimeCreateConfig } from "@jleechanorg/ao-core";

export function createMinimalRuntime(): Runtime {
  return {
    name: "mcp-ao",
    async create(_opts: RuntimeCreateConfig): Promise<RuntimeHandle> {
      return {
        id: `mcp-ao-${Date.now()}`,
        runtimeName: "mcp-ao",
        data: { sessionId: _opts.sessionId },
      };
    },
    async destroy(_handle: RuntimeHandle): Promise<void> {
      // Destruction is handled via ao session kill CLI
      // Errors are surfaced through CLI exit codes
    },
    async sendMessage(_handle: RuntimeHandle, _message: string): Promise<void> {
      // Messages are sent via ao send CLI
      // Errors are surfaced through CLI exit codes
    },
    async getOutput(_handle: RuntimeHandle, _lines?: number): Promise<string> {
      // Output retrieval is handled via ao session CLI
      // Return empty string - actual output handled through CLI
      return "";
    },
    async isAlive(_handle: RuntimeHandle): Promise<boolean> {
      // Liveness check is handled via ao session ls CLI
      // Return true - actual liveness check delegated to CLI
      return true;
    },
  };
}
