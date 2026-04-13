import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMcpTools } from "../mcp-tools.js";
import * as cli from "../cli-wrapper.js";

vi.mock("../cli-wrapper.js", () => ({
  aoSpawn: vi.fn(),
  aoSend: vi.fn(),
  aoSessionList: vi.fn(),
  aoSessionKill: vi.fn(),
  execAo: vi.fn(),
}));

const mockCli = vi.mocked(cli);

describe("createMcpTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

describe("ao_spawn handler", () => {
  it("calls aoSpawn with correct args on success", async () => {
    mockCli.aoSpawn.mockResolvedValueOnce({ success: true, stdout: "spawned", stderr: "", exitCode: 0 });
    const tools = createMcpTools();
    const spawnTool = tools.find((t) => t.name === "ao_spawn")!;
    const result = await spawnTool.handler({ task: "fix bug", agent: "codex" });
    expect(mockCli.aoSpawn).toHaveBeenCalledWith({
      task: "fix bug",
      issue: undefined,
      project: undefined,
      agent: "codex",
      runtime: undefined,
      open: undefined,
      claimPr: undefined,
    });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("spawned");
  });

  it("returns error result on aoSpawn failure", async () => {
    mockCli.aoSpawn.mockResolvedValueOnce({ success: false, stdout: "", stderr: "not found", exitCode: 1 });
    const tools = createMcpTools();
    const spawnTool = tools.find((t) => t.name === "ao_spawn")!;
    const result = await spawnTool.handler({ task: "bad task" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });
});

describe("ao_send handler", () => {
  it("calls aoSend with correct args on success", async () => {
    mockCli.aoSend.mockResolvedValueOnce({ success: true, stdout: "sent", stderr: "", exitCode: 0 });
    const tools = createMcpTools();
    const sendTool = tools.find((t) => t.name === "ao_send")!;
    const result = await sendTool.handler({ session: "my-session", message: "hello world" });
    expect(mockCli.aoSend).toHaveBeenCalledWith({
      session: "my-session",
      message: "hello world",
      file: undefined,
      wait: true,
      timeout: undefined,
    });
    expect(result.isError).toBe(false);
  });

  it("returns error result on aoSend failure", async () => {
    mockCli.aoSend.mockResolvedValueOnce({ success: false, stdout: "", stderr: "session not found", exitCode: 1 });
    const tools = createMcpTools();
    const sendTool = tools.find((t) => t.name === "ao_send")!;
    const result = await sendTool.handler({ session: "ghost", message: "hi" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("session not found");
  });
});

describe("ao_session_list handler", () => {
  it("calls aoSessionList with project filter on success", async () => {
    mockCli.aoSessionList.mockResolvedValueOnce({ success: true, stdout: "s1\ns2", stderr: "", exitCode: 0 });
    const tools = createMcpTools();
    const listTool = tools.find((t) => t.name === "ao_session_list")!;
    const result = await listTool.handler({ project: "my-project" });
    expect(mockCli.aoSessionList).toHaveBeenCalledWith({ project: "my-project" });
    expect(result.isError).toBe(false);
  });

  it("returns error result on aoSessionList failure", async () => {
    mockCli.aoSessionList.mockResolvedValueOnce({ success: false, stdout: "", stderr: "list failed", exitCode: 1 });
    const tools = createMcpTools();
    const listTool = tools.find((t) => t.name === "ao_session_list")!;
    const result = await listTool.handler({});
    expect(result.isError).toBe(true);
  });
});

describe("ao_session_kill handler", () => {
  it("calls aoSessionKill with correct args on success", async () => {
    mockCli.aoSessionKill.mockResolvedValueOnce({ success: true, stdout: "killed", stderr: "", exitCode: 0 });
    const tools = createMcpTools();
    const killTool = tools.find((t) => t.name === "ao_session_kill")!;
    const result = await killTool.handler({ session: "old-session", keep_session: true });
    expect(mockCli.aoSessionKill).toHaveBeenCalledWith({
      session: "old-session",
      keepSession: true,
      purgeSession: undefined,
    });
    expect(result.isError).toBe(false);
  });

  it("returns error result on aoSessionKill failure", async () => {
    mockCli.aoSessionKill.mockResolvedValueOnce({ success: false, stdout: "", stderr: "kill failed", exitCode: 1 });
    const tools = createMcpTools();
    const killTool = tools.find((t) => t.name === "ao_session_kill")!;
    const result = await killTool.handler({ session: "ghost-session" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("kill failed");
  });
});

describe("ao_status handler", () => {
  it("calls execAo with status on success", async () => {
    mockCli.execAo.mockResolvedValueOnce({ success: true, stdout: "running", stderr: "", exitCode: 0 });
    const tools = createMcpTools();
    const statusTool = tools.find((t) => t.name === "ao_status")!;
    const result = await statusTool.handler({});
    expect(mockCli.execAo).toHaveBeenCalledWith(["status"]);
    expect(result.isError).toBe(false);
  });

  it("returns error result on execAo failure", async () => {
    mockCli.execAo.mockResolvedValueOnce({ success: false, stdout: "", stderr: "not running", exitCode: 1 });
    const tools = createMcpTools();
    const statusTool = tools.find((t) => t.name === "ao_status")!;
    const result = await statusTool.handler({});
    expect(result.isError).toBe(true);
  });
});
