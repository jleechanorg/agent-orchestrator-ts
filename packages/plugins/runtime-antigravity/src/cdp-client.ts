interface CdpTarget {
  id: string;
  title: string;
  type: string;
  webSocketDebuggerUrl: string;
}

interface CdpResponse {
  id: number;
  result?: {
    value?: unknown;
    exceptionDetails?: { exception?: { description?: string } };
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
}

/**
 * CDP Client for communicating with Antigravity directly.
 * Uses native fetch and WebSocket available in Node 22.
 */
export class CdpClient {
  private ws: WebSocket;
  private messageId = 1;
  private pendingResolvers = new Map<number, { resolve: (val: unknown) => void; reject: (err: Error) => void }>();
  private connected = false;

  private constructor(wsUrl: string, onClose: () => void) {
    this.ws = new WebSocket(wsUrl);
    this.ws.onmessage = this.handleMessage.bind(this);
    this.ws.onclose = () => {
      this.connected = false;
      onClose();
      for (const { reject } of this.pendingResolvers.values()) {
        reject(new Error("WebSocket disconnected"));
      }
      this.pendingResolvers.clear();
    };
    this.ws.onerror = () => {
      // In Node 22 native WebSocket, onerror doesn't always get an object with message
      // and close is usually also triggered if the connection is completely dead.
    };
  }

  /**
   * Connects to the active page target via CDP.
   */
  static async connect(port = 9222): Promise<CdpClient> {
    const listUrl = `http://localhost:${port}/json`;
    let res: Response;
    try {
      res = await fetch(listUrl, { signal: AbortSignal.timeout(2000) });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Failed to fetch CDP targets at ${listUrl}: ${msg}`, { cause: e });
    }

    if (!res.ok) {
      throw new Error(`CDP targets HTTP error: ${res.status}`);
    }

    const targets = (await res.json()) as CdpTarget[];

    // Antigravity has multiple targets (background pages, service workers, tabs)
    // We want the main renderer page. Usually type: "page"
    // And to be safe, we can filter for something containing antigravity/manager/index
    // If not, just taking the first 'page' type works for electron apps with a single window.
    const pageTarget = targets.find((t) => t.type === "page" && !t.title.includes("devtools"));

    if (!pageTarget?.webSocketDebuggerUrl) {
      throw new Error("No suitable CDP page target found");
    }

    return new Promise((resolve, reject) => {
      const client = new CdpClient(pageTarget.webSocketDebuggerUrl, () => {
        // Will throw handled rejects for any pending commands inside CdpClient
      });

      // Quick timeout to prevent hanging on ws connection
      const connectTimeout = setTimeout(() => {
        client.ws.close();
        reject(new Error("WebSocket connection timeout"));
      }, 5000);

      client.ws.onopen = () => {
        clearTimeout(connectTimeout);
        client.connected = true;
        resolve(client);
      };

      const originalOnError = client.ws.onerror;
      client.ws.onerror = (ev) => {
        if (!client.connected) {
          clearTimeout(connectTimeout);
          reject(new Error("WebSocket connection failed"));
        }
        if (originalOnError) originalOnError.call(client.ws, ev);
      };
    });
  }

  private handleMessage(event: MessageEvent) {
    let data: CdpResponse;
    try {
      data = JSON.parse(event.data.toString());
    } catch {
      return;
    }

    if (data.id && this.pendingResolvers.has(data.id)) {
      const resolver = this.pendingResolvers.get(data.id);
      if (!resolver) return;
      this.pendingResolvers.delete(data.id);

      if (data.error) {
        resolver.reject(new Error(`CDP Error [${data.error.code}]: ${data.error.message}`));
      } else if (data.result?.exceptionDetails) {
        // Runtime.evaluate exception
        const desc = data.result.exceptionDetails.exception?.description ?? "Unknown evaluation error";
        resolver.reject(new Error(`CDP Eval Exception: ${desc}`));
      } else if (data.result !== undefined) {
        resolver.resolve(data.result);
      } else {
        resolver.resolve(undefined);
      }
    }
  }

  private sendCommand(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    if (!this.connected || this.ws.readyState !== 1 /* WebSocket.OPEN */) {
      return Promise.reject(new Error("CDP client is not connected"));
    }

    const id = this.messageId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pendingResolvers.set(id, { resolve, reject });
    });

    const timeoutHandle = setTimeout(() => {
      const resolver = this.pendingResolvers.get(id);
      if (resolver) {
        this.pendingResolvers.delete(id);
        resolver.reject(new Error(`CDP sendCommand timed out after ${timeoutMs}ms: ${method}`));
      }
    }, timeoutMs);

    // Ensure the timeout is cleared once the promise settles
    const timedPromise = promise.finally(() => clearTimeout(timeoutHandle));

    try {
      this.ws.send(JSON.stringify({ id, method, params }));
    } catch (e) {
      clearTimeout(timeoutHandle);
      this.pendingResolvers.delete(id);
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    return timedPromise;
  }

  /**
   * Executes JS in the renderer and returns the result using returnByValue.
   * sendCommand resolves with data.result (the CDP response's result object).
   * For Runtime.evaluate, that's { result: { type, value } }, so we extract .result.value.
   */
  async evaluateInAntigravity(js: string): Promise<unknown> {
    const res = await this.sendCommand("Runtime.evaluate", {
      expression: js,
      returnByValue: true,
      awaitPromise: true,
    });
    const typed = res as { result?: { value?: unknown } } | null;
    return typed?.result?.value;
  }

  /**
   * Finds the center coordinates of an element identified by the selector.
   */
  async findElement(selector: string): Promise<{ x: number; y: number } | null> {
    const js = `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return null;
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2)
        };
      })()
    `;
    const res = await this.evaluateInAntigravity(js);
    return (res as { x: number; y: number } | null) ?? null;
  }

  /**
   * Executes .click() on the DOM element for the given selector.
   */
  async clickElement(selector: string): Promise<boolean> {
    const js = `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.click();
        return true;
      })()
    `;
    const res = await this.evaluateInAntigravity(js);
    return res === true;
  }

  /**
   * Reads visible conversation content from the DOM.
   * Customize the selector depending on Antigravity's DOM structure.
   */
  async getConversationText(selector = "main, .conversation, .log, [role='log']"): Promise<string> {
    const js = `
      (() => {
        // Naive fallback: if we can't find a dedicated conversation area, grab body
        const el = document.querySelector(${JSON.stringify(selector)}) || document.body;
        return el?.innerText || "";
      })()
    `;
    const res = await this.evaluateInAntigravity(js);
    return typeof res === "string" ? res : "";
  }

  isConnected(): boolean {
    return this.connected;
  }

  disconnect(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}
