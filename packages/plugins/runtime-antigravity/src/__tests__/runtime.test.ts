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
  screencapture: vi.fn(),
  clickCoordinates: vi.fn(),
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
const mockScreencapture = peekaboo.screencapture as ReturnType<typeof vi.fn>;
const mockClickCoordinates = peekaboo.clickCoordinates as ReturnType<typeof vi.fn>;

/** Helper to create a window fixture matching PeekabooWindow shape. */
function makeWindow(overrides: { window_id: number; title: string }) {
  return {
    window_id: overrides.window_id,
    title: overrides.title,
    isOnScreen: true,
    isMinimized: false,
    bounds: { x: 100, y: 200, width: 800, height: 600 },
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

/** Create a RuntimeHandle with Antigravity session data for testing.
 *  windowId defaults to 1 (same as managerWindowId) since conversations
 *  live inside the Manager window. */
function makeHandle(
  id: string,
  windowId = 1,
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
  // Default: screencapture returns empty buffer (no Allow prompt)
  mockScreencapture.mockResolvedValue(Buffer.alloc(0));
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
// TDD: runtime.create() — correct Manager UI flow
// =============================================================================

/**
 * Helper to set up standard mocks for a successful create() flow.
 * Returns immediately after setting up mocks — caller invokes create().
 */
function setupSuccessfulCreateMocks() {
  // 1. windowList: Manager window (called inside primaryFn)
  mockWindowList.mockResolvedValueOnce([makeWindow({ window_id: 1, title: "Manager" })]);

  // 2. scroll UP (resolves)
  mockScroll.mockResolvedValue(undefined);

  // 3. see: returns "add Start new conversation" button
  mockSee.mockResolvedValueOnce({
    snapshot_id: "snap-1",
    ui_elements: [
      makeElement({ id: "ws-label", role: "AXStaticText", title: "workspace" }),
      makeElement({ id: "new-conv-btn", role: "AXButton", title: "add Start new conversation", label: "add Start new conversation" }),
    ],
  });

  // 4. click new conversation button
  mockClick.mockResolvedValueOnce({ success: true });

  // 5. see: text field in new conversation view
  mockSee.mockResolvedValueOnce({
    snapshot_id: "snap-2",
    ui_elements: [
      makeElement({ id: "text-input", role: "textField", title: "", label: "text entry area" }),
    ],
  });

  // 6. click text field
  mockClick.mockResolvedValueOnce({ success: true });

  // 7. paste (resolves)
  mockPaste.mockResolvedValueOnce(undefined);

  // 8. press Return (resolves)
  mockPress.mockResolvedValueOnce(undefined);

  // 9. Verify: see() returns progress_activity on first check
  mockSee.mockResolvedValueOnce({
    snapshot_id: "snap-verify",
    ui_elements: [
      makeElement({ id: "spinner", role: "AXProgressIndicator", title: "progress_activity", label: "progress_activity" }),
    ],
  });

  // 10. Post-create windowList for session population (called after executeWithFallback)
  mockWindowList.mockResolvedValueOnce([makeWindow({ window_id: 1, title: "Manager" })]);
}

describe("runtime.create() — Manager UI flow", () => {
  it("should click 'add Start new conversation' button, not workspace label", async () => {
    const runtime = create();
    setupSuccessfulCreateMocks();

    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "implement feature X",
      environment: {},
    });

    expect(handle.id).toBe("test-session");
    expect(handle.runtimeName).toBe("antigravity");

    // Key assertion: the 'add Start new conversation' button was clicked
    expect(mockClick).toHaveBeenCalledWith(
      "Antigravity", 1, "new-conv-btn", "snap-1",
    );
    // workspace label should NOT have been clicked
    expect(mockClick).not.toHaveBeenCalledWith(
      "Antigravity", 1, "ws-label", expect.any(String),
    );
  });

  it("should use Manager window for all operations, not look for separate conversation windows", async () => {
    const runtime = create();
    setupSuccessfulCreateMocks();

    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "do work",
      environment: {},
    });

    const session = handle.data["session"] as Record<string, unknown>;

    // Session windowId should equal managerWindowId (conversations inside Manager)
    expect(session.windowId).toBe(1);
    expect(session.managerWindowId).toBe(1);

    // All see() calls should target Manager window (id=1)
    for (const call of mockSee.mock.calls) {
      expect(call[1]).toBe(1);
    }
  });

  it("should include workspace path in prompt text as scoping workaround", async () => {
    const runtime = create();
    setupSuccessfulCreateMocks();

    await runtime.create({
      sessionId: "test-session",
      workspacePath: "/Users/jleechan/project_worldaiclaw/worldai_claw",
      launchCommand: "implement feature X",
      environment: {},
    });

    // The paste call should include the workspace path in the prompt
    expect(mockPaste).toHaveBeenCalledTimes(1);
    const pastedText = mockPaste.mock.calls[0][1] as string;
    expect(pastedText).toContain("/Users/jleechan/project_worldaiclaw/worldai_claw");
    expect(pastedText).toContain("implement feature X");
  });

  it("should use Return key to send, not Send button", async () => {
    const runtime = create();
    setupSuccessfulCreateMocks();

    await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "implement feature",
      environment: {},
    });

    // press("Return") should be called for sending
    expect(mockPress).toHaveBeenCalledWith("Antigravity", "Return");

    // No click should target a "Send" button
    for (const call of mockClick.mock.calls) {
      const elementId = call[2] as string;
      expect(elementId).not.toMatch(/send/i);
    }
  });

  it("should verify conversation started via progress_activity", async () => {
    const runtime = create();

    // 1. windowList: Manager
    mockWindowList.mockResolvedValueOnce([makeWindow({ window_id: 1, title: "Manager" })]);
    mockScroll.mockResolvedValue(undefined);

    // 2. see: new conversation button
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-1",
      ui_elements: [
        makeElement({ id: "new-conv-btn", role: "AXButton", title: "add Start new conversation", label: "add Start new conversation" }),
      ],
    });
    mockClick.mockResolvedValueOnce({ success: true });

    // 3. see: text field
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-2",
      ui_elements: [
        makeElement({ id: "text-input", role: "textField", title: "", label: "text entry area" }),
      ],
    });
    mockClick.mockResolvedValueOnce({ success: true });
    mockPaste.mockResolvedValueOnce(undefined);
    mockPress.mockResolvedValueOnce(undefined);

    // 4. Verify: first check — no progress_activity
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-no-activity",
      ui_elements: [
        makeElement({ id: "idle", role: "AXStaticText", title: "idle", label: "idle" }),
      ],
    });
    // 5. Verify: second check — progress_activity found
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-activity",
      ui_elements: [
        makeElement({ id: "spinner", role: "AXProgressIndicator", title: "progress_activity", label: "progress_activity" }),
      ],
    });

    // Post-create windowList
    mockWindowList.mockResolvedValueOnce([makeWindow({ window_id: 1, title: "Manager" })]);

    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "do work",
      environment: {},
    });

    // Verification see() calls should have happened (at least 4 total see calls)
    // snap-1 (find button) + snap-2 (find text field) + snap-no-activity + snap-activity
    expect(mockSee.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(handle.data["session"]).toBeDefined();
  });

  it("should handle 'Allow this conversation' directory access prompt via screencapture", async () => {
    const runtime = create();
    setupSuccessfulCreateMocks();

    // Override screencapture: return a non-empty buffer (simulates captured image)
    // The actual python3 blue-pixel detection is tested as integration
    mockScreencapture.mockResolvedValueOnce(Buffer.from("fake-png-data"));

    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "do work",
      environment: {},
    });

    // handleAllowPrompt is called inside create() — screencapture should have been invoked
    // with the Manager window bounds
    expect(mockScreencapture).toHaveBeenCalled();
    expect(handle.data["session"]).toBeDefined();
  });

  it("should scroll sidebar UP first to find 'Start new conversation' button", async () => {
    const runtime = create();
    setupSuccessfulCreateMocks();

    await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "do work",
      environment: {},
    });

    // Scroll UP should have been called first (before finding button)
    expect(mockScroll).toHaveBeenCalledWith("Antigravity", 1, "up", 10);
  });

  it("should retry scrolling if button not found initially", async () => {
    const runtime = create();

    // 1. windowList: Manager
    mockWindowList.mockResolvedValueOnce([makeWindow({ window_id: 1, title: "Manager" })]);
    mockScroll.mockResolvedValue(undefined);

    // 2. Initial see: button NOT found
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-empty",
      ui_elements: [
        makeElement({ id: "ws-label", role: "AXStaticText", title: "some workspace" }),
      ],
    });

    // 3. After scrolling retry, button found
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-found",
      ui_elements: [
        makeElement({ id: "new-conv-btn", role: "AXButton", title: "add Start new conversation", label: "add Start new conversation" }),
      ],
    });
    mockClick.mockResolvedValueOnce({ success: true });

    // 4. Text field
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-2",
      ui_elements: [
        makeElement({ id: "text-input", role: "textField", title: "", label: "text entry area" }),
      ],
    });
    mockClick.mockResolvedValueOnce({ success: true });
    mockPaste.mockResolvedValueOnce(undefined);
    mockPress.mockResolvedValueOnce(undefined);

    // 5. Verify started
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-3",
      ui_elements: [
        makeElement({ id: "spinner", role: "AXProgressIndicator", title: "progress_activity", label: "progress_activity" }),
      ],
    });

    // Post-create windowList
    mockWindowList.mockResolvedValueOnce([makeWindow({ window_id: 1, title: "Manager" })]);

    await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "do work",
      environment: {},
    });

    // Scroll UP was called at least twice (initial + retry)
    const scrollUpCalls = mockScroll.mock.calls.filter(
      (call) => call[2] === "up",
    );
    expect(scrollUpCalls.length).toBeGreaterThanOrEqual(2);
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

  it("throws when 'Start new conversation' button is not found after scrolling", async () => {
    const runtime = create();

    mockWindowList.mockResolvedValueOnce([makeWindow({ window_id: 1, title: "Manager" })]);
    mockScroll.mockResolvedValue(undefined);

    // see() always returns no matching button
    mockSee.mockResolvedValue({
      snapshot_id: "snap-no-btn",
      ui_elements: [
        makeElement({ id: "other", role: "AXStaticText", title: "some text" }),
      ],
    });

    await expect(
      runtime.create({
        sessionId: "fail-session",
        workspacePath: "/tmp/workspace",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow(/Start new conversation.*button not found/i);
  });
});

// =============================================================================
// runtime.destroy()
// =============================================================================

describe("runtime.destroy()", () => {
  it("marks session as idle (conversations persist in Manager)", async () => {
    const runtime = create();
    const handle = makeHandle("destroy-test");

    await runtime.destroy(handle);

    const session = handle.data["session"] as Record<string, unknown>;
    expect(session.status).toBe("idle");
  });

  it("does not try to close windows (conversations persist)", async () => {
    const runtime = create();
    const handle = makeHandle("destroy-test");

    await runtime.destroy(handle);

    // No window list, no hotkey (cmd+w) — conversations persist
    expect(mockWindowList).not.toHaveBeenCalled();
    expect(mockHotkey).not.toHaveBeenCalled();
  });

  it("does not throw when handle has no session data", async () => {
    const runtime = create();
    const handle = makeEmptyHandle("no-session");

    await expect(runtime.destroy(handle)).resolves.toBeUndefined();
  });

  it("prevents double-destroy", async () => {
    const runtime = create();
    const handle = makeHandle("double-destroy");

    await runtime.destroy(handle);
    await runtime.destroy(handle); // Should silently no-op

    // Only one idle transition
    const session = handle.data["session"] as Record<string, unknown>;
    expect(session.status).toBe("idle");
  });
});

// =============================================================================
// runtime.sendMessage() — use Return key, not Send button
// =============================================================================

describe("runtime.sendMessage()", () => {
  it("uses Manager window, finds text field, and presses Return (not Send button)", async () => {
    const runtime = create();
    const handle = makeHandle("msg-test");

    // see() on managerWindowId (1)
    mockSee.mockResolvedValueOnce({
      snapshot_id: "snap-msg",
      ui_elements: [
        makeElement({ id: "input-field", role: "textField", title: "", label: "text entry area" }),
      ],
    });
    mockClick.mockResolvedValueOnce({ success: true }); // click text field
    mockPaste.mockResolvedValueOnce(undefined);
    mockPress.mockResolvedValueOnce(undefined); // Return key

    await runtime.sendMessage(handle, "hello world");

    // Targets managerWindowId (1)
    expect(mockSee).toHaveBeenCalledWith("Antigravity", 1);
    expect(mockClick).toHaveBeenCalledWith("Antigravity", 1, "input-field", "snap-msg");
    expect(mockPaste).toHaveBeenCalledWith("Antigravity", "hello world");

    // KEY: press Return, NOT click Send button
    expect(mockPress).toHaveBeenCalledWith("Antigravity", "Return");
  });

  it("pastes and presses Return even when no text field is found", async () => {
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

    // Paste + press Return even without text field
    expect(mockPaste).toHaveBeenCalledWith("Antigravity", "message without field");
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
  it("captures visible text content from Manager window using label field", async () => {
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
    // Should use Manager window (managerWindowId=1)
    expect(mockSee).toHaveBeenCalledWith("Antigravity", 1);
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
  it("returns true when Manager window exists", async () => {
    const runtime = create();
    const handle = makeHandle("alive-test");

    mockWindowList.mockResolvedValueOnce([
      makeWindow({ window_id: 1, title: "Manager" }),
    ]);

    const alive = await runtime.isAlive(handle);
    expect(alive).toBe(true);
  });

  it("returns false when Manager window is gone", async () => {
    const runtime = create();
    const handle = makeHandle("dead-test");

    mockWindowList.mockResolvedValueOnce([]);

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
    const handle = makeHandle("metrics-test", 1, now - 5000);

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
      target: "Antigravity window 1: Test Conversation",
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
// matchesWorkspace() — basename and parent dir matching
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
