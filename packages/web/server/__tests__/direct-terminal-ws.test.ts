import { describe, it, expect } from "vitest";
import { createDirectTerminalServer } from "../direct-terminal-ws.js";

describe("direct-terminal-ws integration", () => {
  it("should initialize the direct terminal server without throwing TypeError", () => {
    const serverInstance = createDirectTerminalServer();
    expect(serverInstance).toBeDefined();
    expect(serverInstance.wss).toBeDefined();
    serverInstance.shutdown();
  });
});
