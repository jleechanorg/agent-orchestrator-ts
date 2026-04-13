/**
 * Minimal runtime for mcp-ao.
 *
 * Note: This runtime wraps CLI operations, so failures are surfaced
 * through the CLI exit codes rather than through runtime methods.
 * The runtime lifecycle methods delegate to the CLI, which handles
 * error reporting.
 */

import type { Runtime, RuntimeHandle, RuntimeCreateConfig } from "@jleechanorg/ao-core";
import { aoSessionKill, aoSend, aoSessionInfo } from "./cli-wrapper.js";

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
    async destroy(handle: RuntimeHandle): Promise<void> {
      const sessionId = handle.data?.sessionId;
      if (!sessionId) throw new Error("No session ID in runtime handle");
      const result = await aoSessionKill({ session: sessionId });
      if (!result.success) throw new Error(`Failed to destroy session: ${result.stderr}`);
    },
    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      const sessionId = handle.data?.sessionId;
      if (!sessionId) throw new Error("No session ID in runtime handle");
      const result = await aoSend({ session: sessionId, message });
      if (!result.success) throw new Error(`Failed to send message: ${result.stderr}`);
    },
    async getOutput(handle: RuntimeHandle, _lines?: number): Promise<string> {
      const sessionId = handle.data?.sessionId;
      if (!sessionId) throw new Error("No session ID in runtime handle");
      const result = await aoSessionInfo(sessionId);
      if (!result.success) throw new Error(`Failed to get output: ${result.stderr}`);
      return result.stdout;
    },
    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      const sessionId = handle.data?.sessionId;
      if (!sessionId) return false;
      const result = await aoSessionInfo(sessionId);
      return result.success && result.stdout.includes(sessionId);
    },
  };
}
