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
import { setScrollSettleMs } from "../runtime.js";
import * as peekaboo from "../peekaboo.js";

const mockWindowList = vi.mocked(peekaboo.windowList);
const mockSee = vi.mocked(peekaboo.see);
const mockClick = vi.mocked(peekaboo.click);
const mockPaste = vi.mocked(peekaboo.paste);
const mockPress = vi.mocked(peekaboo.press);
const mockHotkey = vi.mocked(peekaboo.hotkey);
const mockScroll = vi.mocked(peekaboo.scroll);

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

// Need to import mocked modules to re-setup implementations after reset
import { executeWithFallback } from "../fallback.js";
import { runPreflight } from "../preflight.js";
const mockExecuteWithFallback = vi.mocked(executeWithFallback);
const mockRunPreflight = vi.mocked(runPreflight);

beforeEach(() => {
  // resetAllMocks clears mockResolvedValueOnce queues (clearAllMocks does not)
  vi.resetAllMocks();
  // Re-setup module-level mock implementations after reset
  mockExecuteWithFallback.mockImplementation(
    async (primaryFn: () => Promise<string>) => {
      const output = await primaryFn();
      return { success: true, output, fallbackUsed: false };
    },
  );
  mockRunPreflight.mockResolvedValue({ ok: true, steps: [], elapsedMs: 0 });
  // Default implementations (prevent "undefined.find" crashes after Once values consumed)
  mockSee.mockImplementation(async () => ({
    snapshot_id: "default",
    ui_elements: [],
  }));
  mockScroll.mockImplementation(async () => undefined);
  // Disable scroll settle delay for fast tests
  setScrollSettleMs(0);
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
  it("finds Manager window and opens conversation with Send button", async () => {
    const runtime = create();

    // 1. windowList: returns Manager window
    mockWindowList.mockResolvedValueOnce([makeWindow({ window_id: 1, title: "Manager" })]);

    // 2. see (findWorkspaceElement): returns snapshot with workspace element
    //    Workspace matching uses basename ("workspace") not full path
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-1",
      ui_elements: [makeElement({ id: "ws-el", role: "other", title: "workspace" })],
    });

    // 3. click: workspace element
    mockClick.mockResolvedValueOnce({ success: true });

    // 4. windowList: returns conversation window after click
    mockWindowList.mockResolvedValueOnce([
      makeWindow({ window_id: 1, title: "Manager" }),
      makeWindow({ window_id: 2, title: "workspace" }),
    ]);

    // 5. see (Manager): find text field + Send button for launch command
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-2",
      ui_elements: [
        makeElement({ id: "input-field", role: "textField", title: "" }),
        makeElement({ id: "send-btn", role: "button", title: "Send", label: "Send" }),
      ],
    });

    // 6. click text field, paste, click Send button
    mockClick.mockResolvedValueOnce({ success: true }); // focus text field
    mockPaste.mockResolvedValueOnce(undefined);
    mockClick.mockResolvedValueOnce({ success: true }); // click Send

    // 7. windowList: re-fetch for session population after fallback wrapper
    mockWindowList.mockResolvedValueOnce([
      makeWindow({ window_id: 1, title: "Manager" }),
      makeWindow({ window_id: 2, title: "workspace" }),
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
    expect(mockSee).toHaveBeenCalledTimes(2);
    // Workspace click
    expect(mockClick).toHaveBeenCalledWith("Antigravity", 1, "ws-el", "snap-1");
    // Paste includes workspace context prefix
    expect(mockPaste).toHaveBeenCalledWith(
      "Antigravity",
      "You are working in /tmp/workspace. implement feature X",
    );
    // Send button clicked (not Return pressed)
    expect(mockClick).toHaveBeenCalledWith("Antigravity", 1, "send-btn", "snap-2");
    expect(mockPress).not.toHaveBeenCalled();
  });

  it("falls back to Return when Send button not found", async () => {
    const runtime = create();

    mockWindowList.mockResolvedValueOnce([makeWindow({ window_id: 1, title: "Manager" })]);
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-1",
      ui_elements: [makeElement({ id: "ws-el", role: "other", title: "workspace" })],
    });
    mockClick.mockResolvedValueOnce({ success: true });
    mockWindowList.mockResolvedValueOnce([
      makeWindow({ window_id: 1, title: "Manager" }),
      makeWindow({ window_id: 2, title: "workspace" }),
    ]);

    // Manager snapshot without Send button
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-2",
      ui_elements: [
        makeElement({ id: "input-field", role: "textField", title: "" }),
      ],
    });
    mockClick.mockResolvedValueOnce({ success: true }); // focus text field
    mockPaste.mockResolvedValueOnce(undefined);
    mockPress.mockResolvedValueOnce(undefined); // Return fallback

    mockWindowList.mockResolvedValueOnce([
      makeWindow({ window_id: 1, title: "Manager" }),
      makeWindow({ window_id: 2, title: "workspace" }),
    ]);

    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "hello",
      environment: {},
    });

    expect(handle.id).toBe("test-session");
    expect(mockPress).toHaveBeenCalledWith("Antigravity", "Return");
  });

  it("scrolls to find workspace not in viewport", async () => {
    const runtime = create();

    mockWindowList.mockResolvedValueOnce([makeWindow({ window_id: 1, title: "Manager" })]);

    // First see: workspace not visible
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-1",
      ui_elements: [makeElement({ id: "other", role: "button", title: "unrelated" })],
    });
    mockScroll.mockResolvedValueOnce(undefined);

    // Second see after scroll: workspace found
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-2",
      ui_elements: [makeElement({ id: "ws-el", role: "other", title: "workspace" })],
    });
    mockClick.mockResolvedValueOnce({ success: true });
    mockWindowList.mockResolvedValueOnce([
      makeWindow({ window_id: 1, title: "Manager" }),
      makeWindow({ window_id: 2, title: "workspace" }),
    ]);
    // No launch command — skip send
    mockWindowList.mockResolvedValueOnce([
      makeWindow({ window_id: 1, title: "Manager" }),
      makeWindow({ window_id: 2, title: "workspace" }),
    ]);

    const handle = await runtime.create({
      sessionId: "scroll-test",
      workspacePath: "/tmp/workspace",
      launchCommand: "",
      environment: {},
    });

    expect(handle.id).toBe("scroll-test");
    expect(mockScroll).toHaveBeenCalledWith("Antigravity", 1, "down", 5);
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

  it("throws when workspace is not found after scrolling", async () => {
    const runtime = create();

    mockWindowList.mockResolvedValueOnce([makeWindow({ window_id: 1, title: "Manager" })]);

    // Make see() always return unrelated elements (use mockImplementation
    // instead of mockResolvedValueOnce to ensure consistent behavior)
    mockSee.mockImplementation(async () => ({
      snapshot_id: "snap-scroll",
      ui_elements: [
        makeElement({ id: "other-ws", role: "AXButton", title: "some-other-project" }),
      ],
    }));

    await expect(
      runtime.create({
        sessionId: "fail-session",
        workspacePath: "/tmp/workspace",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("not found in Antigravity Manager after");
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
  it("uses Manager window, finds text field, clicks Send button", async () => {
    const runtime = create();
    const handle = makeHandle("msg-test");

    // sendMessage targets Manager window (id 1), not conversation window
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-msg",
      ui_elements: [
        makeElement({ id: "input-field", role: "AXTextArea", title: "" }),
        makeElement({ id: "send-btn", role: "button", title: "Send", label: "Send" }),
      ],
    });
    mockClick.mockResolvedValueOnce({ success: true }); // focus text field
    mockPaste.mockResolvedValueOnce(undefined);
    mockClick.mockResolvedValueOnce({ success: true }); // click Send

    await runtime.sendMessage(handle, "hello world");

    // Target is Manager window (id 1), not conversation window (id 2)
    expect(mockSee).toHaveBeenCalledWith("Antigravity", 1);
    expect(mockClick).toHaveBeenCalledWith(
      "Antigravity",
      1,
      "input-field",
      "snap-msg",
    );
    expect(mockPaste).toHaveBeenCalledWith("Antigravity", "hello world");
    // Send button clicked, not Return
    expect(mockClick).toHaveBeenCalledWith(
      "Antigravity",
      1,
      "send-btn",
      "snap-msg",
    );
    expect(mockPress).not.toHaveBeenCalled();
  });

  it("falls back to Return when no Send button found", async () => {
    const runtime = create();
    const handle = makeHandle("msg-no-send");

    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-nf",
      ui_elements: [
        makeElement({ id: "input-field", role: "AXTextArea", title: "" }),
      ],
    });
    mockClick.mockResolvedValueOnce({ success: true }); // focus text field
    mockPaste.mockResolvedValueOnce(undefined);
    mockPress.mockResolvedValueOnce(undefined); // Return fallback

    await runtime.sendMessage(handle, "message without send btn");

    expect(mockPaste).toHaveBeenCalledWith(
      "Antigravity",
      "message without send btn",
    );
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
    mockPress.mockResolvedValueOnce(undefined);

    await runtime.sendMessage(handle, "message without field");

    // click should NOT be called for text field since none found
    expect(mockClick).not.toHaveBeenCalled();
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
  it("reads from Manager window and captures visible text content", async () => {
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

    // Should target Manager window (id 1), not conversation window (id 2)
    expect(mockSee).toHaveBeenCalledWith("Antigravity", 1);
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
