import { describe, it, expect, afterEach } from "vitest";
import { createDirectTerminalServer } from "../direct-terminal-ws.js";
import { WebSocket } from "ws";
import { createConnection, type AddressInfo } from "node:net";

const closers: Array<() => void | Promise<void>> = [];

async function testWebSocketConnection(path: string, port: number): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}?session=testsessionid`);
    closers.push(() => { socket.close(); });
    socket.on("open", () => resolve(socket));
    socket.on("error", reject);
    socket.on("unexpected-response", (_req, res) => {
      reject(new Error(`Handshake failed with status ${res.statusCode}`));
    });
  });
}

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    if (close) {
      try {
        await close();
      } catch {
        // ignore errors on cleanup
      }
    }
  }
});

describe("direct-terminal-ws WebSocket integration and routing", () => {
  it("should initialize the direct terminal server without throwing TypeError", () => {
    const serverInstance = createDirectTerminalServer();
    expect(serverInstance).toBeDefined();
    expect(serverInstance.wss).toBeDefined();
    serverInstance.shutdown();
  });

  it("honors noServer: true option behaviorally by not auto-handling upgrades on unrouted paths", async () => {
    const serverInstance = createDirectTerminalServer();
    expect(serverInstance.wss.options.noServer).toBe(true);
    
    await new Promise<void>((resolve) => serverInstance.server.listen(0, "127.0.0.1", resolve));
    const { port } = serverInstance.server.address() as { port: number };
    
    const upgradeResponsePromise = new Promise<string>((resolve, reject) => {
      const socket = createConnection(port, "127.0.0.1", () => {
        const req =
          `GET /unrouted-path HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `\r\n`;
        socket.write(req);
      });
      const timeoutId = setTimeout(() => { socket.destroy(); resolve("timeout"); }, 1000);
      socket.once("data", (chunk) => {
        clearTimeout(timeoutId);
        socket.destroy();
        resolve(chunk.toString("utf8"));
      });
      socket.once("close", () => {
        clearTimeout(timeoutId);
        resolve("closed");
      });
      socket.once("error", (err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
    });

    const res = await upgradeResponsePromise;
    serverInstance.shutdown();
    
    expect(res).not.toMatch(/^HTTP\/1\.1 101/);
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
    
    expect(upgradeResponse).toMatch(/^HTTP\/1\.1 101/);
  });

  it("allows WebSocket connections to /ws", async () => {
    const serverInstance = createDirectTerminalServer();
    await new Promise<void>((resolve) => serverInstance.server.listen(0, "127.0.0.1", resolve));
    closers.push(() => {
      serverInstance.wss.close();
      return new Promise<void>((r) => serverInstance.server.close(() => r()));
    });
    
    const port = (serverInstance.server.address() as AddressInfo).port;
    const ws = await testWebSocketConnection("/ws", port);
    
    expect([WebSocket.OPEN, WebSocket.CLOSING, WebSocket.CLOSED]).toContain(ws.readyState);
    ws.close();
  });

  it("allows WebSocket connections to /ao-terminal-mux", async () => {
    const serverInstance = createDirectTerminalServer();
    await new Promise<void>((resolve) => serverInstance.server.listen(0, "127.0.0.1", resolve));
    closers.push(() => {
      serverInstance.wss.close();
      return new Promise<void>((r) => serverInstance.server.close(() => r()));
    });
    
    const port = (serverInstance.server.address() as AddressInfo).port;
    const ws = await testWebSocketConnection("/ao-terminal-mux", port);
    
    expect([WebSocket.OPEN, WebSocket.CLOSING, WebSocket.CLOSED]).toContain(ws.readyState);
    ws.close();
  });
});
