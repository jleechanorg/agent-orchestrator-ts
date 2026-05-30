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
  hotkey: vi.fn(),
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

/** Create a PeekabooSeeResult with a given status label on a conversation element. */
function makeSeeResult(statusLabel: string): PeekabooSeeResult {
  return {
    snapshot_id: "snap-poll",
    ui_elements: [
      {
        id: "conv-el",
        role: "AXStaticText",
        title: "Test Conversation",
        label: statusLabel,
        description: "",
        role_description: "",
        is_actionable: false,
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

  it("does NOT fire onIdle on unknown → idle (prevents false idle from unrelated Manager rows)", async () => {
    // Guard: unknown → idle must NOT fire onIdle because conversationTitle equals
    // the Manager window title, which matches all conversations via fallback scan.
    // An older idle conversation row could cause a false idle event for a newly-
    // spawned session before it has been seen as "running". (bd-5o2)
    const onIdle = vi.fn();
    const onCapacityWait = vi.fn();
    const callbacks: PollerCallbacks = { onIdle, onCapacityWait };

    const poller = createPoller(15_000, callbacks);
    const handle = makeHandle("unknown-idle-test");

    // First tick returns idle directly — lastState starts as "unknown"
    mockSee.mockResolvedValueOnce(makeSeeResult("Done 2m ago"));
    poller.start(handle, 1);
    await vi.advanceTimersByTimeAsync(15_000);

    // onIdle must NOT fire from unknown → idle to prevent false positives
    expect(onIdle).not.toHaveBeenCalled();

    poller.stopAll();
  });

  it("fires onIdle on capacity-wait → idle transition", async () => {
    const onIdle = vi.fn();
    const onCapacityWait = vi.fn();
    const callbacks: PollerCallbacks = { onIdle, onCapacityWait };

    const poller = createPoller(15_000, callbacks);
    const handle = makeHandle("capacity-wait-idle-test");

    poller.start(handle, 1);
    // Poll 1: "running" label returns detectStateFromLabel→"unknown"; tick exits early.
    // lastState stays "unknown" — capacity-wait only needs to precede idle, not running.
    mockSee.mockResolvedValueOnce(makeSeeResult("running"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onIdle).not.toHaveBeenCalled();

    // Poll 2: capacity-wait
    mockSee.mockResolvedValueOnce(makeSeeResult("Waiting for capacity"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onIdle).not.toHaveBeenCalled();

    // Poll 3: idle — transition from capacity-wait → idle must fire onIdle
    mockSee.mockResolvedValueOnce(makeSeeResult("Done 2m ago"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(onIdle).toHaveBeenCalledWith(handle);

    poller.stopAll();
  });

  it("onIdle throw does NOT update lastState — subsequent poll retries and fires again", async () => {
    // Regression: if onIdle throws (e.g. updateMetadata fails), lastState must
    // NOT be updated so the next poll can retry.
    let onIdleThrow = true;
    const onIdle = vi.fn().mockImplementation(() => {
      if (onIdleThrow) {
        onIdleThrow = false;
        throw new Error("filesystem error");
      }
    });
    const onCapacityWait = vi.fn();
    const callbacks: PollerCallbacks = { onIdle, onCapacityWait };

    const poller = createPoller(15_000, callbacks);
    const handle = makeHandle("throw-retry-test");

    // Use mockImplementation with closure to control each call (avoids
    // mockResolvedValueOnce queue exhaustion with vi.asyncFn).
    let peekabooResolve: (v: PeekabooSeeResult) => void;
    mockSee.mockImplementation(() => new Promise((r) => { peekabooResolve = r; }));

    poller.start(handle, 1);

    // Tick 0: advance time → resolve running — establishes lastState = "running"
    // (unknown → idle no longer fires onIdle; need running first per bd-5o2 fix)
    await vi.advanceTimersByTimeAsync(15_000);
    const runningEls = makeSeeResult("progress_activity Working").ui_elements[0];
    peekabooResolve!({ snapshot_id: "s0", ui_elements: [runningEls] });
    await vi.advanceTimersByTimeAsync(0); // flush microtasks
    expect(onIdle).not.toHaveBeenCalled();

    // Tick 1: advance time → resolve idle — running → idle fires onIdle (throws)
    await vi.advanceTimersByTimeAsync(15_000);
    const idleEls1 = makeSeeResult("Done 3m ago").ui_elements[0];
    peekabooResolve!({ snapshot_id: "s1", ui_elements: [idleEls1] });
    await vi.advanceTimersByTimeAsync(0); // flush microtasks → onIdle throws
    expect(onIdle).toHaveBeenCalledTimes(1);

    // Tick 2: advance time → resolve idle → onIdle succeeds (lastState still "running")
    await vi.advanceTimersByTimeAsync(15_000);
    const idleEls2 = makeSeeResult("Done 4m ago").ui_elements[0];
    peekabooResolve!({ snapshot_id: "s2", ui_elements: [idleEls2] });
    await vi.advanceTimersByTimeAsync(0); // flush microtasks → onIdle succeeds
    expect(onIdle).toHaveBeenCalledTimes(2);

    poller.stopAll();
  });

  it("fallback scan (conversationFound=false) does NOT advance lastState — real transition still fires", async () => {
    // Regression: if the UI snapshot has no element matching conversationTitle,
    // the fallback scan runs with conversationFound=false. The buggy code would
    // advance lastState to "idle" even without a confirmed row match, suppressing
    // the later real running→idle transition. (bd-5o2)
    const onIdle = vi.fn();
    const onCapacityWait = vi.fn();
    const callbacks: PollerCallbacks = { onIdle, onCapacityWait };

    const poller = createPoller(15_000, callbacks);
    const handle = makeHandle("fallback-state-test");

    poller.start(handle, 1);

    // Poll 1: "Test Conversation" row is running — lastState advances to "running"
    mockSee.mockResolvedValueOnce(makeSeeResult("progress_activity Working"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onIdle).not.toHaveBeenCalled();

    // Poll 2: snapshot has an UNRELATED row (not "Test Conversation").
    // Fallback scan detects "idle" but conversationFound=false —
    // lastState must NOT advance to "idle".
    const unrelatedIdle: PeekabooSeeResult = {
      snapshot_id: "snap-other",
      ui_elements: [
        {
          id: "other",
          role: "AXStaticText",
          title: "Other Conversation",
          label: "Done 3m ago",
          description: "",
          role_description: "",
          is_actionable: false,
        },
      ],
    };
    mockSee.mockResolvedValueOnce(unrelatedIdle);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onIdle).not.toHaveBeenCalled(); // guard already prevents firing

    // Poll 3: "Test Conversation" row is now idle — lastState is still "running"
    // so the running→idle transition fires correctly.
    mockSee.mockResolvedValueOnce(makeSeeResult("Done 4m ago"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(onIdle).toHaveBeenCalledWith(handle);

    poller.stopAll();
  });

  it("in-flight guard skips poll tick while previous peekaboo.see is still pending", async () => {
    // Regression: if peekaboo.see is slow, a second setInterval tick must not
    // start another overlapping peekaboo call.
    const onIdle = vi.fn();
    const onCapacityWait = vi.fn();
    const callbacks: PollerCallbacks = { onIdle, onCapacityWait };

    const poller = createPoller(15_000, callbacks);
    const handle = makeHandle("inflight-test");

    // peekaboo.see is slow — never resolves on its own
    let resolveSee: (v: PeekabooSeeResult) => void = () => {};
    mockSee.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSee = resolve;
        }),
    );

    poller.start(handle, 1);

    // First tick fires — inFlight=true, peekaboo called once
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mockSee).toHaveBeenCalledTimes(1);

    // Second tick would fire — must be skipped (inFlight guard)
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mockSee).toHaveBeenCalledTimes(1); // still 1, not 2

    // Now let peekaboo resolve so inFlight=false
    resolveSee({ snapshot_id: "snap", ui_elements: [makeSeeResult("progress_activity Running").ui_elements[0]] });
    await vi.advanceTimersByTimeAsync(0); // flush microtasks

    // Third tick — peekaboo called again (inFlight=false now)
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mockSee).toHaveBeenCalledTimes(2);

    poller.stopAll();
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

  it("start() with managerWindowId=-1 does not schedule any timer", async () => {
    const onIdle = vi.fn();
    const onCapacityWait = vi.fn();
    const callbacks: PollerCallbacks = { onIdle, onCapacityWait };

    const poller = createPoller(15_000, callbacks);
    const handle = makeHandle("noop-window", -1); // windowId = -1

    // Start with managerWindowId = -1 (fallback session — no GUI)
    poller.start(handle, -1);

    // Advance well past when a tick would have fired
    await vi.advanceTimersByTimeAsync(60_000);

    // No peekaboo.see() calls should have been made
    expect(mockSee).not.toHaveBeenCalled();
    expect(onIdle).not.toHaveBeenCalled();
  });
});

describe("callback resilience", () => {
  it("onIdle throw does not update lastState — next poll retries and succeeds", async () => {
    const onIdle = vi.fn().mockImplementation(() => {
      throw new Error("transient failure");
    });
    const onCapacityWait = vi.fn();
    const callbacks: PollerCallbacks = { onIdle, onCapacityWait };

    const poller = createPoller(15_000, callbacks);
    const handle = makeHandle("retry-test");

    // Tick 1: running (transitions unknown → running)
    mockSee.mockResolvedValueOnce(makeSeeResult("progress_activity Working"));
    poller.start(handle, 1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onIdle).not.toHaveBeenCalled(); // unknown → running, not idle

    // Tick 2: idle, but onIdle throws — lastState must NOT update
    mockSee.mockResolvedValueOnce(makeSeeResult("Finished 5m ago"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onIdle).toHaveBeenCalledTimes(1); // running → idle, threw

    // Tick 3: idle again — lastState was NOT updated, so retry fires
    mockSee.mockResolvedValueOnce(makeSeeResult("Finished 6m ago"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onIdle).toHaveBeenCalledTimes(2); // retry succeeded

    poller.stopAll();
  });

  it("onCapacityWait throw does not update lastState", async () => {
    const onIdle = vi.fn();
    const onCapacityWait = vi.fn().mockImplementation(() => {
      throw new Error("transient capacity error");
    });
    const callbacks: PollerCallbacks = { onIdle, onCapacityWait };

    const poller = createPoller(15_000, callbacks);
    const handle = makeHandle("capacity-retry-test");

    mockSee.mockResolvedValueOnce(makeSeeResult("Waiting for capacity"));
    poller.start(handle, 1);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(onCapacityWait).toHaveBeenCalledTimes(1);

    // Next tick: still capacity-wait
    mockSee.mockResolvedValueOnce(makeSeeResult("Waiting for capacity"));
    await vi.advanceTimersByTimeAsync(15_000);

    // Should have retried
    expect(onCapacityWait).toHaveBeenCalledTimes(2);

    poller.stopAll();
  });
});
