import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Runtime, RuntimeHandle } from "@jleechanorg/ao-core";
import { createMcpTools, type McpToolDefinition } from "../mcp-tools.js";

// Mock peekaboo module
vi.mock("../peekaboo.js", () => ({
  windowList: vi.fn(),
  see: vi.fn(),
  click: vi.fn(),
  paste: vi.fn(),
  press: vi.fn(),
  hotkey: vi.fn(),
}));

import * as peekaboo from "../peekaboo.js";

const mockWindowList = vi.mocked(peekaboo.windowList);
const mockSee = vi.mocked(peekaboo.see);

/** Helper to create a window fixture. */
function makeWindow(overrides: { window_id: number; title: string }) {
  return {
    window_id: overrides.window_id,
    title: overrides.title,
    isOnScreen: true,
    isMinimized: false,
    bounds: { x: 0, y: 0, width: 100, height: 100 },
  };
}

/** Helper to create a UI element fixture. */
function makeElement(overrides: { id: string; role: string; title: string; label?: string }) {
  return {
    id: overrides.id,
    role: overrides.role,
    title: overrides.title,
    label: overrides.label ?? overrides.title,
    description: "",
    role_description: "",
    is_actionable: true,
  };
}

function createMockRuntime(): Runtime {
  return {
    name: "antigravity",
    create: vi.fn().mockResolvedValue({
      id: "test-session",
      runtimeName: "antigravity",
      data: { createdAt: Date.now() },
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getOutput: vi.fn().mockResolvedValue("output text"),
    isAlive: vi.fn().mockResolvedValue(true),
  };
}

function findTool(tools: McpToolDefinition[], name: string): McpToolDefinition {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool;
}

describe("createMcpTools", () => {
  let runtime: Runtime;
  let sessionStore: Map<string, RuntimeHandle>;
  let tools: McpToolDefinition[];

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = createMockRuntime();
    sessionStore = new Map();
    tools = createMcpTools(runtime, sessionStore);
  });

  it("returns 5 tool definitions", () => {
    expect(tools).toHaveLength(5);
  });

  it("each tool has name, description, inputSchema, and handler", () => {
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.handler).toBe("function");
    }
  });

  it("tool names match expected set", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "antigravity_kill",
      "antigravity_send",
      "antigravity_spawn",
      "antigravity_status",
      "antigravity_workspaces",
    ]);
  });

  describe("antigravity_spawn", () => {
    it("creates a session and stores the handle", async () => {
      const tool = findTool(tools, "antigravity_spawn");
      const result = await tool.handler({ task: "write tests", workspace: "/tmp/test" });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("created");
      expect(runtime.create).toHaveBeenCalledWith(
        expect.objectContaining({
          workspacePath: "/tmp/test",
          launchCommand: "write tests",
        }),
      );
      expect(sessionStore.size).toBe(1);
    });

    it("returns error when runtime.create fails", async () => {
      vi.mocked(runtime.create).mockRejectedValue(new Error("no window"));
      const tool = findTool(tools, "antigravity_spawn");
      const result = await tool.handler({ task: "test" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("no window");
    });
  });

  describe("antigravity_status", () => {
    it("returns conversation list from Manager", async () => {
      mockWindowList.mockResolvedValue([makeWindow({ window_id: 1, title: "Manager" })]);
      mockSee.mockResolvedValue({
        snapshot_id: "snap1",
        ui_elements: [
          makeElement({ id: "e1", role: "button", title: "progress_activity Building Feature now", label: "progress_activity Building Feature now" }),
          makeElement({ id: "e2", role: "button", title: "Code Review 5m", label: "Code Review 5m" }),
        ],
      });

      const tool = findTool(tools, "antigravity_status");
      const result = await tool.handler({});

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("[ACTIVE]");
      expect(result.content[0].text).toContain("Building Feature");
      expect(result.content[0].text).toContain("[IDLE]");
      expect(result.content[0].text).toContain("Code Review");
    });

    it("returns message when no Manager window found", async () => {
      mockWindowList.mockResolvedValue([]);
      const tool = findTool(tools, "antigravity_status");
      const result = await tool.handler({});
      expect(result.content[0].text).toContain("not found");
    });
  });

  describe("antigravity_kill", () => {
    it("destroys session and removes from store", async () => {
      const handle: RuntimeHandle = {
        id: "s1",
        runtimeName: "antigravity",
        data: {},
      };
      sessionStore.set("s1", handle);

      const tool = findTool(tools, "antigravity_kill");
      const result = await tool.handler({ session_id: "s1" });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("destroyed");
      expect(runtime.destroy).toHaveBeenCalledWith(handle);
      expect(sessionStore.has("s1")).toBe(false);
    });

    it("returns error for unknown session", async () => {
      const tool = findTool(tools, "antigravity_kill");
      const result = await tool.handler({ session_id: "nonexistent" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });
  });

  describe("antigravity_send", () => {
    it("sends message to session", async () => {
      const handle: RuntimeHandle = {
        id: "s1",
        runtimeName: "antigravity",
        data: {},
      };
      sessionStore.set("s1", handle);

      const tool = findTool(tools, "antigravity_send");
      const result = await tool.handler({
        session_id: "s1",
        message: "add logging",
      });

      expect(result.isError).toBeFalsy();
      expect(runtime.sendMessage).toHaveBeenCalledWith(handle, "add logging");
    });

    it("returns error for unknown session", async () => {
      const tool = findTool(tools, "antigravity_send");
      const result = await tool.handler({
        session_id: "nope",
        message: "hi",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("antigravity_workspaces", () => {
    it("lists all Antigravity windows", async () => {
      mockWindowList.mockResolvedValue([
        makeWindow({ window_id: 1, title: "Manager" }),
        makeWindow({ window_id: 2, title: "worktree_ao" }),
      ]);

      const tool = findTool(tools, "antigravity_workspaces");
      const result = await tool.handler({});

      expect(result.content[0].text).toContain("Manager");
      expect(result.content[0].text).toContain("worktree_ao");
    });

    it("handles no windows found", async () => {
      mockWindowList.mockResolvedValue([]);
      const tool = findTool(tools, "antigravity_workspaces");
      const result = await tool.handler({});
      expect(result.content[0].text).toContain("No Antigravity windows");
    });
  });
});
