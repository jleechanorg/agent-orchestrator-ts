import { describe, it, expect } from "vitest";
import { createDirectTerminalServer } from "../direct-terminal-ws.js";
import { createConnection } from "node:net";

describe("direct-terminal-ws integration", () => {
  it("should initialize the direct terminal server without throwing TypeError", () => {
    const serverInstance = createDirectTerminalServer();
    expect(serverInstance).toBeDefined();
    expect(serverInstance.wss).toBeDefined();
    serverInstance.shutdown();
  });

  it("accepts WebSocket upgrade on /ao-terminal-mux (path option must NOT be set on noServer WSS)", async () => {
    const serverInstance = createDirectTerminalServer();
    await new Promise<void>((resolve) => serverInstance.server.listen(0, "127.0.0.1", resolve));
    const { port } = serverInstance.server.address() as { port: number };

    const upgradeResponse = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(port, "127.0.0.1", () => {
        const req =
          `GET /ao-terminal-mux HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `\r\n`;
        socket.write(req);
      });
      const timeoutId = setTimeout(() => { socket.destroy(); reject(new Error("timeout")); }, 3000);
      socket.once("data", (chunk) => {
        clearTimeout(timeoutId);
        socket.destroy();
        resolve(chunk.toString("utf8"));
      });
      socket.once("error", (err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
    }).finally(() => {
      serverInstance.shutdown();
    });
    // Without the fix (path:"/ws" set), ws would call shouldHandle() → false → HTTP 400
    // With the fix (no path option), handleUpgrade succeeds → HTTP 101
    expect(upgradeResponse).toMatch(/^HTTP\/1\.1 101/);
  });
});
