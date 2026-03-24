import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RuntimeHandle } from "@jleechanorg/ao-core";
import type { PeekabooSeeResult } from "../types.js";

// Mock the peekaboo module
vi.mock("../peekaboo.js", () => ({
  windowList: vi.fn(),
  see: vi.fn(),
  click: vi.fn(),
  paste: vi.fn(),
  press: vi.fn(),
}));

// Import after mocks
import * as peekaboo from "../peekaboo.js";
import { createPoller, type PollerCallbacks } from "../poller.js";

const mockSee = peekaboo.see as ReturnType<typeof vi.fn>;

/** Build a RuntimeHandle with Antigravity session data. */
function makeHandle(id: string, windowId = 2): RuntimeHandle {
  return {
    id,
    runtimeName: "antigravity",
    data: {
      createdAt: 1000,
      workspacePath: "/tmp/workspace",
      session: {
        conversationTitle: "Test Conversation",
        workspaceName: "/tmp/workspace",
        windowId,
        managerWindowId: 1,
        status: "running",
        createdAt: 1000,
        lastCheckedAt: 1000,
      },
    },
  };
}

/** Create a PeekabooSeeResult with a given label on a conversation element. */
function makeSeeResult(label: string): PeekabooSeeResult {
  return {
    snapshot_id: "snap-poll",
    ui_elements: [
      {
        id: "conv-el",
        role: "AXStaticText",
        title: "Test Conversation",
        value: label,
        bounds: { x: 0, y: 0, width: 200, height: 30 },
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// =============================================================================
// State Detection
// =============================================================================

describe("state detection", () => {
  it("detects running state from progress_activity", async () => {
    const onIdle = vi.fn();
    const onCapacityWait = vi.fn();
    const callbacks: PollerCallbacks = { onIdle, onCapacityWait };

    const poller = createPoller(15_000, callbacks);
    const handle = makeHandle("running-test");

    mockSee.mockResolvedValue(makeSeeResult("progress_activity Writing code"));

    poller.start(handle, 1);

    // Advance one tick
    await vi.advanceTimersByTimeAsync(15_000);

    expect(mockSee).toHaveBeenCalledWith("Antigravity", 1);
    expect(onIdle).not.toHaveBeenCalled();
    expect(onCapacityWait).not.toHaveBeenCalled();

    poller.stopAll();
  });

  it("detects idle state from time-ago suffix", async () => {
    const onIdle = vi.fn();
    const onCapacityWait = vi.fn();
    const callbacks: PollerCallbacks = { onIdle, onCapacityWait };

    const poller = createPoller(15_000, callbacks);
    const handle = makeHandle("idle-test");

    // First tick: running
    mockSee.mockResolvedValueOnce(makeSeeResult("progress_activity Working"));
    poller.start(handle, 1);
    await vi.advanceTimersByTimeAsync(15_000);

    // Second tick: idle (time-ago suffix)
    mockSee.mockResolvedValueOnce(makeSeeResult("Finished 5m ago"));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(onIdle).toHaveBeenCalledWith(handle);

    poller.stopAll();
  });

  it("detects capacity-wait from capacity text", async () => {
    const onIdle = vi.fn();
    const onCapacityWait = vi.fn();
    const callbacks: PollerCallbacks = { onIdle, onCapacityWait };

    const poller = createPoller(15_000, callbacks);
    const handle = makeHandle("capacity-test");

    mockSee.mockResolvedValue(
      makeSeeResult("Waiting for capacity, please try again later"),
    );

    poller.start(handle, 1);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(onCapacityWait).toHaveBeenCalledWith(handle, expect.any(Number));
    expect(onIdle).not.toHaveBeenCalled();

    poller.stopAll();
  });
});

// =============================================================================
// Transition Logic
// =============================================================================

describe("transition logic", () => {
  it("calls onIdle on transition from running to idle", async () => {
    const onIdle = vi.fn();
    const onCapacityWait = vi.fn();
    const callbacks: PollerCallbacks = { onIdle, onCapacityWait };

    const poller = createPoller(15_000, callbacks);
    const handle = makeHandle("transition-test");

    // Tick 1: running
    mockSee.mockResolvedValueOnce(makeSeeResult("progress_activity Analyzing"));
    poller.start(handle, 1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onIdle).not.toHaveBeenCalled();

    // Tick 2: idle
    mockSee.mockResolvedValueOnce(makeSeeResult("Done 1h ago"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(onIdle).toHaveBeenCalledWith(handle);

    poller.stopAll();
  });

  it("does NOT re-fire onIdle if already idle", async () => {
    const onIdle = vi.fn();
    const onCapacityWait = vi.fn();
    const callbacks: PollerCallbacks = { onIdle, onCapacityWait };

    const poller = createPoller(15_000, callbacks);
    const handle = makeHandle("no-refire-test");

    // Tick 1: running
    mockSee.mockResolvedValueOnce(makeSeeResult("progress_activity Working"));
    poller.start(handle, 1);
    await vi.advanceTimersByTimeAsync(15_000);

    // Tick 2: idle → fires onIdle
    mockSee.mockResolvedValueOnce(makeSeeResult("Completed 10m ago"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onIdle).toHaveBeenCalledTimes(1);

    // Tick 3: still idle → should NOT fire again
    mockSee.mockResolvedValueOnce(makeSeeResult("Completed 11m ago"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onIdle).toHaveBeenCalledTimes(1);

    poller.stopAll();
  });
});

// =============================================================================
// Lifecycle Management
// =============================================================================

describe("lifecycle", () => {
  it("stop() cancels interval for a specific handle", async () => {
    const onIdle = vi.fn();
    const onCapacityWait = vi.fn();
    const callbacks: PollerCallbacks = { onIdle, onCapacityWait };

    const poller = createPoller(15_000, callbacks);
    const handle = makeHandle("stop-test");

    mockSee.mockResolvedValue(makeSeeResult("progress_activity Running"));

    poller.start(handle, 1);

    // First tick works
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mockSee).toHaveBeenCalledTimes(1);

    // Stop the poller
    poller.stop(handle.id);

    // Second tick should not fire
    mockSee.mockClear();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mockSee).not.toHaveBeenCalled();
  });

  it("stopAll() cancels all active pollers", async () => {
    const onIdle = vi.fn();
    const onCapacityWait = vi.fn();
    const callbacks: PollerCallbacks = { onIdle, onCapacityWait };

    const poller = createPoller(15_000, callbacks);

    const handle1 = makeHandle("all-1");
    const handle2 = makeHandle("all-2", 3);

    mockSee.mockResolvedValue(makeSeeResult("progress_activity Running"));

    poller.start(handle1, 1);
    poller.start(handle2, 1);

    // Both fire on first tick
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mockSee).toHaveBeenCalledTimes(2);

    // Stop all
    poller.stopAll();

    // No more ticks
    mockSee.mockClear();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mockSee).not.toHaveBeenCalled();
  });

  it("silently ignores peekaboo errors during polling", async () => {
    const onIdle = vi.fn();
    const onCapacityWait = vi.fn();
    const callbacks: PollerCallbacks = { onIdle, onCapacityWait };

    const poller = createPoller(15_000, callbacks);
    const handle = makeHandle("error-test");

    // First tick: error
    mockSee.mockRejectedValueOnce(new Error("peekaboo crashed"));

    poller.start(handle, 1);

    // Should not throw
    await vi.advanceTimersByTimeAsync(15_000);

    expect(onIdle).not.toHaveBeenCalled();
    expect(onCapacityWait).not.toHaveBeenCalled();

    // Subsequent tick works fine
    mockSee.mockResolvedValueOnce(makeSeeResult("progress_activity Running"));
    await vi.advanceTimersByTimeAsync(15_000);

    poller.stopAll();
  });
});
