/**
 * Minimal runtime for mcp-ao.
 *
 * Note: This runtime wraps CLI operations, so failures are surfaced
 * through the CLI exit codes rather than through runtime methods.
 * The runtime lifecycle methods delegate to the CLI, which handles
 * error reporting.
 *
 * The runtime maintains a session registry mapping handle IDs to actual
 * AO session names, since MCP tool calls (ao_spawn, ao_send, etc.) operate
 * on real AO sessions while the runtime handle uses generated IDs.
 */

import type { Runtime, RuntimeHandle, RuntimeCreateConfig } from "@jleechanorg/ao-core";
import { aoSessionKill, aoSend, aoSessionInfo } from "./cli-wrapper.js";

/** Maps runtime handle IDs to actual AO session names */
const sessionRegistry = new Map<string, string>();

export function createMinimalRuntime(): Runtime {
  return {
    name: "mcp-ao",
    async create(opts: RuntimeCreateConfig): Promise<RuntimeHandle> {
      const id = `mcp-ao-${Date.now()}`;
      // If a sessionId was provided (e.g., from ao_spawn), store it in the registry
      if (opts.sessionId) {
        sessionRegistry.set(id, opts.sessionId);
      }
      return {
        id,
        runtimeName: "mcp-ao",
        data: { sessionId: opts.sessionId },
      };
    },
    async destroy(handle: RuntimeHandle): Promise<void> {
      const sessionId = sessionRegistry.get(handle.id) ?? handle.id;
      if (!sessionId) throw new Error("No session ID in runtime handle");
      sessionRegistry.delete(handle.id);
      const result = await aoSessionKill({ session: sessionId });
      if (!result.success) throw new Error(`Failed to destroy session: ${result.stderr}`);
    },
    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      const sessionId = sessionRegistry.get(handle.id) ?? handle.id;
      if (!sessionId) throw new Error("No session ID in runtime handle");
      const result = await aoSend({ session: sessionId, message });
      if (!result.success) throw new Error(`Failed to send message: ${result.stderr}`);
    },
    async getOutput(handle: RuntimeHandle, _lines?: number): Promise<string> {
      const sessionId = sessionRegistry.get(handle.id) ?? handle.id;
      if (!sessionId) throw new Error("No session ID in runtime handle");
      const result = await aoSessionInfo(sessionId);
      if (!result.success) throw new Error(`Failed to get output: ${result.stderr}`);
      return result.stdout;
    },
    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      const sessionId = sessionRegistry.get(handle.id) ?? handle.id;
      if (!sessionId) return false;
      const result = await aoSessionInfo(sessionId);
      return result.success && result.stdout.includes(sessionId);
    },
  };
}
