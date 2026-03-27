import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RuntimeHandle } from "@jleechanorg/ao-core";

// Mock the peekaboo module
vi.mock("../peekaboo.js", () => ({
  windowList: vi.fn(),
  see: vi.fn(),
  click: vi.fn(),
  paste: vi.fn(),
  press: vi.fn(),
  hotkey: vi.fn(),
  scroll: vi.fn(),
  setPeekabooBin: vi.fn(),
}));

// Mock preflight — always pass so tests control windowList mocks directly.
vi.mock("../preflight.js", () => ({
  runPreflight: vi.fn().mockResolvedValue({ ok: true, steps: [], elapsedMs: 0 }),
}));

// Mock the fallback module — transparent pass-through to primary.
// Fallback-specific logic is tested in fallback.test.ts.
vi.mock("../fallback.js", () => ({
  executeWithFallback: vi.fn(
    async (primaryFn: () => Promise<string>) => {
      const output = await primaryFn();
      return { success: true, output, fallbackUsed: false };
    },
  ),
}));

// Import after mocks
import antigravityPlugin, { manifest, create } from "../index.js";
import { matchesWorkspace } from "../runtime.js";
import * as peekaboo from "../peekaboo.js";

const mockWindowList = peekaboo.windowList as ReturnType<typeof vi.fn>;
const mockSee = peekaboo.see as ReturnType<typeof vi.fn>;
const mockClick = peekaboo.click as ReturnType<typeof vi.fn>;
const mockPaste = peekaboo.paste as ReturnType<typeof vi.fn>;
const mockPress = peekaboo.press as ReturnType<typeof vi.fn>;
const mockHotkey = peekaboo.hotkey as ReturnType<typeof vi.fn>;
const mockScroll = peekaboo.scroll as ReturnType<typeof vi.fn>;

/** Helper to create a window fixture matching PeekabooWindow shape. */
function makeWindow(overrides: { window_id: number; title: string }) {
  return {
    window_id: overrides.window_id,
    title: overrides.title,
    isOnScreen: true,
    isMinimized: false,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  };
}

/** Helper to create a UI element fixture matching PeekabooUIElement shape. */
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

/** Create a RuntimeHandle with Antigravity session data for testing. */
function makeHandle(
  id: string,
  windowId = 2,
  createdAt?: number,
): RuntimeHandle {
  return {
    id,
    runtimeName: "antigravity",
    data: {
      createdAt: createdAt ?? 1000,
      workspacePath: "/tmp/workspace",
      session: {
        conversationTitle: "Test Conversation",
        workspaceName: "/tmp/workspace",
        windowId,
        managerWindowId: 1,
        status: "running",
        createdAt: createdAt ?? 1000,
        lastCheckedAt: createdAt ?? 1000,
      },
    },
  };
}

/** Create a handle with no session data. */
function makeEmptyHandle(id: string): RuntimeHandle {
  return {
    id,
    runtimeName: "antigravity",
    data: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// Manifest & Default Export
// =============================================================================

describe("manifest", () => {
  it("has name 'antigravity' and slot 'runtime'", () => {
    expect(manifest.name).toBe("antigravity");
    expect(manifest.slot).toBe("runtime");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe(
      "Runtime plugin: Antigravity IDE via Peekaboo",
    );
  });

  it("default export includes manifest and create", () => {
    expect(antigravityPlugin.manifest).toBe(manifest);
    expect(antigravityPlugin.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns a Runtime with name 'antigravity'", () => {
    const runtime = create();
    expect(runtime.name).toBe("antigravity");
  });
});

// =============================================================================
// runtime.create()
// =============================================================================

describe("runtime.create()", () => {
  it("finds Manager window and opens conversation (basename matching + Send button)", async () => {
    const runtime = create();

    // 1. windowList: returns Manager window
    mockWindowList.mockResolvedValueOnce([makeWindow({ window_id: 1, title: "Manager" })]);

    // 2. see: returns snapshot with workspace element (basename only, not full path)
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-1",
      ui_elements: [makeElement({ id: "ws-el", role: "AXButton", title: "workspace" })],
    });

    // 3. click: workspace element
    mockClick.mockResolvedValueOnce({ success: true });

    // 4. windowList: returns conversation window matching workspace basename
    mockWindowList.mockResolvedValueOnce([
      makeWindow({ window_id: 1, title: "Manager" }),
      makeWindow({ window_id: 2, title: "workspace — Conversation" }),
    ]);

    // 5. paste for launch command
    mockPaste.mockResolvedValueOnce(undefined);

    // 6. see for Send button detection (clickSendButton)
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-send",
      ui_elements: [makeElement({ id: "send-btn", role: "AXButton", title: "Send" })],
    });
    // 7. click Send button
    mockClick.mockResolvedValueOnce({ success: true });

    // 8. windowList: re-fetch for session population after fallback wrapper
    mockWindowList.mockResolvedValueOnce([
      makeWindow({ window_id: 1, title: "Manager" }),
      makeWindow({ window_id: 2, title: "workspace — Conversation" }),
    ]);

    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "implement feature X",
      environment: {},
    });

    expect(handle.id).toBe("test-session");
    expect(handle.runtimeName).toBe("antigravity");
    expect(handle.data["workspacePath"]).toBe("/tmp/workspace");

    // Verify peekaboo calls
    expect(mockWindowList).toHaveBeenCalledTimes(3);
    // see() called twice: once for manager snapshot, once for Send button
    expect(mockSee).toHaveBeenCalledWith("Antigravity", 1);
    expect(mockSee).toHaveBeenCalledWith("Antigravity", 2);
    expect(mockClick).toHaveBeenCalledWith("Antigravity", 1, "ws-el", "snap-1");
    // Send button clicked instead of pressing Return
    expect(mockClick).toHaveBeenCalledWith("Antigravity", 2, "send-btn", "snap-send");
    expect(mockPaste).toHaveBeenCalledWith("Antigravity", "implement feature X");
    // press("Return") should NOT be called — Send button was clicked
    expect(mockPress).not.toHaveBeenCalled();
  });

  it("throws when Manager window is not found", async () => {
    const runtime = create();

    mockWindowList.mockResolvedValueOnce([
      makeWindow({ window_id: 5, title: "Some Other Window" }),
    ]);

    await expect(
      runtime.create({
        sessionId: "fail-session",
        workspacePath: "/tmp/workspace",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("Antigravity Manager window not found");
  });

  it("throws when workspace is not found in Manager (after scrolling)", async () => {
    const runtime = create();

    mockWindowList.mockResolvedValueOnce([makeWindow({ window_id: 1, title: "Manager" })]);

    // see() always returns a snapshot with no matching workspace.
    // Title must NOT contain "workspace" or "tmp" (basename/parent of /tmp/workspace).
    const noMatchSnapshot = {
      snapshot_id: "snap-2",
      ui_elements: [
        makeElement({ id: "other-ws", role: "AXButton", title: "unrelated_project" }),
      ],
    };
    // Use mockResolvedValue (permanent) for see — called 6 times (1 initial + 5 scroll retries)
    mockSee.mockResolvedValue(noMatchSnapshot);
    mockScroll.mockResolvedValue(undefined);

    await expect(
      runtime.create({
        sessionId: "fail-session",
        workspacePath: "/tmp/workspace",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow('Workspace "/tmp/workspace" not found');

    // Verify scrolling was attempted 5 times
    expect(mockScroll).toHaveBeenCalledTimes(5);
    // Initial see + 5 scroll retries = 6 see calls
    expect(mockSee).toHaveBeenCalledTimes(6);
  });
});

// =============================================================================
// runtime.destroy()
// =============================================================================

describe("runtime.destroy()", () => {
  it("attempts to close the conversation window via hotkey", async () => {
    const runtime = create();
    const handle = makeHandle("destroy-test");

    mockWindowList.mockResolvedValueOnce([
      makeWindow({ window_id: 2, title: "Conversation" }),
    ]);
    // see() is called to get a snapshot for focusing
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-destroy",
      ui_elements: [makeElement({ id: "el-1", role: "button", title: "close" })],
    });
    mockClick.mockResolvedValueOnce({ success: true });
    mockHotkey.mockResolvedValueOnce(undefined);

    await runtime.destroy(handle);

    expect(mockWindowList).toHaveBeenCalledWith("Antigravity");
    expect(mockSee).toHaveBeenCalledWith("Antigravity", 2);
    expect(mockHotkey).toHaveBeenCalledWith("Antigravity", "cmd+w");
  });

  it("does not throw when window is already closed", async () => {
    const runtime = create();
    const handle = makeHandle("already-dead");

    mockWindowList.mockResolvedValueOnce([]);

    await expect(runtime.destroy(handle)).resolves.toBeUndefined();
  });

  it("does not throw when handle has no session data", async () => {
    const runtime = create();
    const handle = makeEmptyHandle("no-session");

    await expect(runtime.destroy(handle)).resolves.toBeUndefined();
  });
});

// =============================================================================
// runtime.sendMessage()
// =============================================================================

describe("runtime.sendMessage()", () => {
  it("uses managerWindowId, finds text field, clicks Send button", async () => {
    const runtime = create();
    const handle = makeHandle("msg-test");

    // see() on managerWindowId (1), not windowId (2) — Bug 5
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-msg",
      ui_elements: [
        makeElement({ id: "input-field", role: "AXTextArea", title: "" }),
      ],
    });
    mockClick.mockResolvedValueOnce({ success: true }); // click text field
    mockPaste.mockResolvedValueOnce(undefined);

    // clickSendButton: see() for Send button
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-send",
      ui_elements: [
        makeElement({ id: "send-btn", role: "AXButton", title: "Send" }),
      ],
    });
    mockClick.mockResolvedValueOnce({ success: true }); // click Send

    await runtime.sendMessage(handle, "hello world");

    // Bug 5: targets managerWindowId (1), not windowId (2)
    expect(mockSee).toHaveBeenCalledWith("Antigravity", 1);
    expect(mockClick).toHaveBeenCalledWith(
      "Antigravity",
      1,
      "input-field",
      "snap-msg",
    );
    expect(mockPaste).toHaveBeenCalledWith("Antigravity", "hello world");
    // Bug 4: clicks Send button instead of pressing Return
    expect(mockClick).toHaveBeenCalledWith("Antigravity", 1, "send-btn", "snap-send");
    expect(mockPress).not.toHaveBeenCalled();
  });

  it("falls back to press Return when no Send button found", async () => {
    const runtime = create();
    const handle = makeHandle("msg-no-send");

    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-msg",
      ui_elements: [
        makeElement({ id: "input-field", role: "AXTextArea", title: "" }),
      ],
    });
    mockClick.mockResolvedValueOnce({ success: true });
    mockPaste.mockResolvedValueOnce(undefined);

    // clickSendButton: see() returns no Send button
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-no-send",
      ui_elements: [
        makeElement({ id: "other-btn", role: "AXButton", title: "Cancel" }),
      ],
    });
    mockPress.mockResolvedValueOnce(undefined);

    await runtime.sendMessage(handle, "hello fallback");

    // Falls back to press Return
    expect(mockPress).toHaveBeenCalledWith("Antigravity", "Return");
  });

  it("pastes directly when no text field is found", async () => {
    const runtime = create();
    const handle = makeHandle("msg-no-field");

    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-nf",
      ui_elements: [
        makeElement({ id: "some-button", role: "AXButton", title: "Submit" }),
      ],
    });
    mockPaste.mockResolvedValueOnce(undefined);

    // clickSendButton: no Send button found
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-nf2",
      ui_elements: [],
    });
    mockPress.mockResolvedValueOnce(undefined);

    await runtime.sendMessage(handle, "message without field");

    // click should NOT be called for text field focus (no text field found)
    // but clickSendButton does see() + press() as fallback
    expect(mockPaste).toHaveBeenCalledWith(
      "Antigravity",
      "message without field",
    );
    expect(mockPress).toHaveBeenCalledWith("Antigravity", "Return");
  });

  it("throws when handle has no session data", async () => {
    const runtime = create();
    const handle = makeEmptyHandle("no-session");

    await expect(runtime.sendMessage(handle, "hello")).rejects.toThrow(
      "No session data",
    );
  });
});

// =============================================================================
// runtime.getOutput()
// =============================================================================

describe("runtime.getOutput()", () => {
  it("captures visible text content from the window using label field", async () => {
    const runtime = create();
    const handle = makeHandle("output-test");

    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-out",
      ui_elements: [
        makeElement({ id: "text-1", role: "AXStaticText", title: "", label: "Line 1" }),
        makeElement({ id: "text-2", role: "AXStaticText", title: "", label: "Line 2" }),
      ],
    });

    const output = await runtime.getOutput(handle);

    expect(output).toBe("Line 1\nLine 2");
  });

  it("returns empty string when handle has no session", async () => {
    const runtime = create();
    const handle = makeEmptyHandle("no-session");

    const output = await runtime.getOutput(handle);
    expect(output).toBe("");
  });

  it("returns empty string on error", async () => {
    const runtime = create();
    const handle = makeHandle("output-err");

    mockSee.mockRejectedValueOnce(new Error("window not found"));

    const output = await runtime.getOutput(handle);
    expect(output).toBe("");
  });
});

// =============================================================================
// runtime.isAlive()
// =============================================================================

describe("runtime.isAlive()", () => {
  it("returns true when conversation window exists", async () => {
    const runtime = create();
    const handle = makeHandle("alive-test");

    mockWindowList.mockResolvedValueOnce([
      makeWindow({ window_id: 2, title: "Conversation" }),
    ]);

    const alive = await runtime.isAlive(handle);
    expect(alive).toBe(true);
  });

  it("returns false when conversation window is gone", async () => {
    const runtime = create();
    const handle = makeHandle("dead-test");

    mockWindowList.mockResolvedValueOnce([
      makeWindow({ window_id: 1, title: "Manager" }),
    ]);

    const alive = await runtime.isAlive(handle);
    expect(alive).toBe(false);
  });

  it("returns false when handle has no session", async () => {
    const runtime = create();
    const handle = makeEmptyHandle("no-session");

    const alive = await runtime.isAlive(handle);
    expect(alive).toBe(false);
  });

  it("returns false when windowList fails", async () => {
    const runtime = create();
    const handle = makeHandle("error-test");

    mockWindowList.mockRejectedValueOnce(new Error("peekaboo error"));

    const alive = await runtime.isAlive(handle);
    expect(alive).toBe(false);
  });
});

// =============================================================================
// runtime.getMetrics()
// =============================================================================

describe("runtime.getMetrics()", () => {
  it("returns uptimeMs based on createdAt", async () => {
    const runtime = create();
    const now = Date.now();
    const handle = makeHandle("metrics-test", 2, now - 5000);

    const metrics = await runtime.getMetrics!(handle);

    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(5000);
    expect(metrics.uptimeMs).toBeLessThan(6000);
  });

  it("handles missing createdAt by using Date.now()", async () => {
    const runtime = create();
    const handle = makeEmptyHandle("metrics-no-created");

    const metrics = await runtime.getMetrics!(handle);

    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.uptimeMs).toBeLessThan(1000);
  });
});

// =============================================================================
// runtime.getAttachInfo()
// =============================================================================

describe("runtime.getAttachInfo()", () => {
  it("returns web type with window info for GUI sessions", async () => {
    const runtime = create();
    const handle = makeHandle("attach-test");

    const info = await runtime.getAttachInfo!(handle);

    expect(info).toEqual({
      type: "web",
      target: "Antigravity window 2: Test Conversation",
    });
  });

  it("returns process type with workspace for CLI fallback sessions", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "fallback-test",
      runtimeName: "antigravity",
      data: {
        workspacePath: "/tmp/workspace",
        session: {
          conversationTitle: "CLI fallback: /tmp/workspace",
          workspaceName: "/tmp/workspace",
          windowId: -1,
          managerWindowId: -1,
          status: "running",
          createdAt: 1000,
          lastCheckedAt: 1000,
          fallbackPid: 12345,
        },
      },
    };

    const info = await runtime.getAttachInfo!(handle);

    expect(info).toEqual({
      type: "process",
      target: "Antigravity CLI fallback: /tmp/workspace",
    });
  });

  it("returns web type when no session data", async () => {
    const runtime = create();
    const handle = makeEmptyHandle("no-session");

    const info = await runtime.getAttachInfo!(handle);

    expect(info).toEqual({
      type: "web",
      target: "Antigravity (unknown window)",
    });
  });
});

// =============================================================================
// matchesWorkspace() — Bug 1: basename and parent dir matching
// =============================================================================

describe("matchesWorkspace()", () => {
  it("matches full path (direct substring)", () => {
    expect(matchesWorkspace("/Users/jleechan/project_worldaiclaw/worldai_claw", "/Users/jleechan/project_worldaiclaw/worldai_claw")).toBe(true);
  });

  it("matches basename only (sidebar shows 'worldai_claw')", () => {
    expect(matchesWorkspace("worldai_claw", "/Users/jleechan/project_worldaiclaw/worldai_claw")).toBe(true);
  });

  it("matches parent directory name", () => {
    expect(matchesWorkspace("project_worldaiclaw", "/Users/jleechan/project_worldaiclaw/worldai_claw")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(matchesWorkspace("WorldAI_Claw", "/users/jleechan/project_worldaiclaw/worldai_claw")).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(matchesWorkspace("some_other_workspace", "/Users/jleechan/project_worldaiclaw/worldai_claw")).toBe(false);
  });

  it("handles trailing slash in workspace path", () => {
    expect(matchesWorkspace("worldai_claw", "/Users/jleechan/project_worldaiclaw/worldai_claw/")).toBe(true);
  });
});

// =============================================================================
// Scroll retry — Bug 2: workspace found after scrolling
// =============================================================================

describe("runtime.create() scroll retry", () => {
  it("finds workspace after scrolling down", async () => {
    const runtime = create();

    // 1. windowList: Manager window
    mockWindowList.mockResolvedValueOnce([makeWindow({ window_id: 1, title: "Manager" })]);

    // 2. Initial see: workspace NOT in viewport
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-empty",
      ui_elements: [makeElement({ id: "other", role: "AXButton", title: "other_project" })],
    });

    // Scroll + re-see (first scroll attempt finds it)
    mockScroll.mockResolvedValueOnce(undefined);
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-scrolled",
      ui_elements: [makeElement({ id: "ws-el", role: "AXButton", title: "workspace" })],
    });

    // click workspace
    mockClick.mockResolvedValueOnce({ success: true });

    // post-click windowList
    mockWindowList.mockResolvedValueOnce([
      makeWindow({ window_id: 1, title: "Manager" }),
      makeWindow({ window_id: 3, title: "workspace — Conversation" }),
    ]);

    // No launch command

    // re-fetch windowList for session
    mockWindowList.mockResolvedValueOnce([
      makeWindow({ window_id: 1, title: "Manager" }),
      makeWindow({ window_id: 3, title: "workspace — Conversation" }),
    ]);

    const handle = await runtime.create({
      sessionId: "scroll-test",
      workspacePath: "/tmp/workspace",
      launchCommand: "",
      environment: {},
    });

    expect(handle.id).toBe("scroll-test");
    expect(mockScroll).toHaveBeenCalledTimes(1);
    expect(mockScroll).toHaveBeenCalledWith("Antigravity", 1, "down", 5);
  });
});
