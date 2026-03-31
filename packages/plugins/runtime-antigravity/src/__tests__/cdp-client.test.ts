import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CdpClient } from "../cdp-client.js";

interface MockTarget {
  id: string;
  title: string;
  type: string;
  webSocketDebuggerUrl: string;
}

interface MockWebSocketInstance {
  url: string;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: Error | Event) => void) | null;
  onclose: (() => void) | null;
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

describe("CdpClient", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockWebSocket: new (url: string) => MockWebSocketInstance;
  let wsInstances: MockWebSocketInstance[] = [];

  beforeEach(() => {
    wsInstances = [];
    mockWebSocket = class MockWebSocket implements MockWebSocketInstance {
      url: string;
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      onerror: ((ev: Error | Event) => void) | null = null;
      onclose: (() => void) | null = null;
      readyState: number = 0; // CONNECTING
      send = vi.fn();
      close = vi.fn(() => {
        this.readyState = 3; // CLOSED
        if (this.onclose) this.onclose();
      });

      constructor(url: string) {
        this.url = url;
        wsInstances.push(this);
        // Auto-connect on next tick
        setTimeout(() => {
          this.readyState = 1; // OPEN
          if (this.onopen) this.onopen();
        }, 0);
      }
    };

    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
    globalThis.WebSocket = mockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setupMockTargets(targets: MockTarget[]) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => targets,
    });
  }

  function simulateWsMessage(msg: Record<string, unknown>) {
    if (wsInstances.length > 0) {
      const ws = wsInstances[wsInstances.length - 1];
      if (ws.onmessage) {
        ws.onmessage({ data: JSON.stringify(msg) });
      }
    }
  }

  describe("connect()", () => {
    it("should connect to active page target", async () => {
      setupMockTargets([
        { id: "1", title: "Background", type: "background_page", webSocketDebuggerUrl: "ws://bg" },
        { id: "2", title: "Antigravity", type: "page", webSocketDebuggerUrl: "ws://target" },
      ]);

      const client = await CdpClient.connect();
      expect(client.isConnected()).toBe(true);
      expect(wsInstances.length).toBe(1);
      expect(wsInstances[0].url).toBe("ws://target");
    });

    it("should throw descriptive error if fetch fails", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      await expect(CdpClient.connect()).rejects.toThrow(/Failed to fetch CDP targets/);
    });

    it("should throw if no page target found", async () => {
      setupMockTargets([{ id: "1", title: "ServiceWorker", type: "service_worker", webSocketDebuggerUrl: "ws://sw" }]);
      await expect(CdpClient.connect()).rejects.toThrow(/No suitable CDP page target found/);
    });

    it("should throw if ws connection fails", async () => {
      setupMockTargets([{ id: "1", title: "Page", type: "page", webSocketDebuggerUrl: "ws://target" }]);
      
      const connectPromise = CdpClient.connect();
      
      // We must fail it after it pushes to wsInstances, but before the timeout runs
      setTimeout(() => {
        const ws = wsInstances[0];
        ws.readyState = 3;
        if (ws.onerror) ws.onerror(new Error("WS ERROR"));
      }, 0);

      await expect(connectPromise).rejects.toThrow(/WebSocket connection failed/);
    });
  });

  describe("CDP commands", () => {
    let client: CdpClient;

    beforeEach(async () => {
      setupMockTargets([{ id: "1", title: "Page", type: "page", webSocketDebuggerUrl: "ws://target" }]);
      client = await CdpClient.connect();
    });

    afterEach(() => {
      client.disconnect();
    });

    it("evaluateInAntigravity() sends Runtime.evaluate and resolves", async () => {
      const evalPromise = client.evaluateInAntigravity("1 + 1");
      
      expect(wsInstances[0].send).toHaveBeenCalledWith(expect.stringContaining('"method":"Runtime.evaluate"'));
      expect(wsInstances[0].send).toHaveBeenCalledWith(expect.stringContaining('"expression":"1 + 1"'));
      expect(wsInstances[0].send).toHaveBeenCalledWith(expect.stringContaining('"returnByValue":true'));
      
      // Simulate CDP response
      simulateWsMessage({
        id: 1,
        result: {
          result: { type: "number", value: 2 },
        },
      });

      const res = await evalPromise;
      expect(res).toBe(2);
    });

    it("evaluateInAntigravity() throws on exception", async () => {
      const evalPromise = client.evaluateInAntigravity("throw new Error('foo')");
      
      simulateWsMessage({
        id: 1, // first call
        result: {
          exceptionDetails: {
            exception: { description: "Error: foo" },
          },
        },
      });

      await expect(evalPromise).rejects.toThrow(/Error: foo/);
    });

    it("findElement() returns null if element not found", async () => {
      const promise = client.findElement(".btn");
      simulateWsMessage({ id: 1, result: { result: { type: "object", value: null } } });
      const res = await promise;
      expect(res).toBeNull();
    });

    it("findElement() returns x,y coords if found", async () => {
      const promise = client.findElement(".btn");
      simulateWsMessage({ id: 1, result: { result: { type: "object", value: { x: 100, y: 200 } } } });
      const res = await promise;
      expect(res).toEqual({ x: 100, y: 200 });
    });

    it("clickElement() resolves to true if element is clicked", async () => {
      const promise = client.clickElement(".btn");
      simulateWsMessage({ id: 1, result: { result: { type: "boolean", value: true } } });
      const res = await promise;
      expect(res).toBe(true);
    });

    it("getConversationText() stringifies DOM node content", async () => {
      const promise = client.getConversationText();
      simulateWsMessage({ id: 1, result: { result: { type: "string", value: "Hello\nWorld" } } });
      const res = await promise;
      expect(res).toBe("Hello\nWorld");
    });
  });
});
