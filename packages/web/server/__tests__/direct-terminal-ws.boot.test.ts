import { describe, it, expect } from "vitest";

import { createDirectTerminalServer } from "../direct-terminal-ws.js";

/**
 * Regression test for the boot crash where createDirectTerminalServer()
 * constructed `new WebSocketServer({ path: "/ws" })` with none of the required
 * port/server/noServer options. The `ws` library throws at construction:
 *   "One and only one of the port, server, or noServer options must be specified"
 * This crashed the direct-terminal server before server.listen() ran, so the
 * dashboard session console (DirectTerminal) got ERR_CONNECTION_REFUSED.
 *
 * The server does manual HTTP upgrade routing, so the correct mode is
 * { noServer: true }. This test would have caught the hard boot crash at CI.
 */
describe("createDirectTerminalServer (boot)", () => {
  it("constructs without throwing and exposes server + wss", () => {
    let result: ReturnType<typeof createDirectTerminalServer> | undefined;
    expect(() => {
      result = createDirectTerminalServer("/opt/homebrew/bin/tmux");
    }).not.toThrow();

    expect(result).toBeDefined();
    expect(result!.server).toBeDefined();
    expect(result!.wss).toBeDefined();

    // Clean up (does not bind a port — listen() is never called here).
    result!.shutdown();
  });
});
