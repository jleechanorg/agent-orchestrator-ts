import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMcpTools } from "../mcp-tools.js";

vi.mock("../cli-wrapper.js", () => ({
  aoSpawn: vi.fn(),
  aoSend: vi.fn(),
  aoSessionList: vi.fn(),
  aoSessionKill: vi.fn(),
  execAo: vi.fn(),
}));

describe("createMcpTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return an array of tool definitions", () => {
    const tools = createMcpTools();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
  });

  it("should include ao_spawn tool", () => {
    const tools = createMcpTools();
    const spawnTool = tools.find((t) => t.name === "ao_spawn");
    expect(spawnTool).toBeDefined();
    expect(spawnTool?.description).toContain("Spawn a new AO agent session");
    expect(spawnTool?.inputSchema).toBeDefined();
    expect(spawnTool?.inputSchema.type).toBe("object");
  });

  it("should include ao_send tool", () => {
    const tools = createMcpTools();
    const sendTool = tools.find((t) => t.name === "ao_send");
    expect(sendTool).toBeDefined();
    expect(sendTool?.description).toContain("Send a message to an active AO session");
    expect(sendTool?.inputSchema).toBeDefined();
    expect(sendTool?.inputSchema.type).toBe("object");
  });

  it("should include ao_session_list tool", () => {
    const tools = createMcpTools();
    const listTool = tools.find((t) => t.name === "ao_session_list");
    expect(listTool).toBeDefined();
    expect(listTool?.description).toContain("List all AO sessions");
    expect(listTool?.inputSchema).toBeDefined();
  });

  it("should include ao_session_kill tool", () => {
    const tools = createMcpTools();
    const killTool = tools.find((t) => t.name === "ao_session_kill");
    expect(killTool).toBeDefined();
    expect(killTool?.description).toContain("Kill an AO session");
    expect(killTool?.inputSchema).toBeDefined();
  });

  it("should include ao_status tool", () => {
    const tools = createMcpTools();
    const statusTool = tools.find((t) => t.name === "ao_status");
    expect(statusTool).toBeDefined();
    expect(statusTool?.description).toContain("AO status");
  });

  it("each tool should have a handler function", () => {
    const tools = createMcpTools();
    for (const tool of tools) {
      expect(typeof tool.handler).toBe("function");
    }
  });

  it("each tool should have required properties", () => {
    const tools = createMcpTools();
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(typeof tool.inputSchema).toBe("object");
    }
  });
});
