import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  analyzePaneContent,
  recordIdleCycle,
  resetIdleCycles,
  resetAllIdleCycles,
  getIdleCycleState,
  checkStuckWorker,
  DEFAULT_IDLE_CYCLE_THRESHOLD,
  DEFAULT_NUDGE_TEXT,
} from "../stuck-worker-detector.js";

beforeEach(() => {
  resetAllIdleCycles();
});

// ─── analyzePaneContent ──────────────────────────────────────────────────────

describe("analyzePaneContent", () => {
  it("returns kill for empty pane output", () => {
    const result = analyzePaneContent("");
    expect(result.action).toBe("kill");
  });

  it("returns kill for whitespace-only pane output", () => {
    const result = analyzePaneContent("   \n  \n  ");
    expect(result.action).toBe("kill");
  });

  // ── Agent exited (shell prompt, no activity) ──

  it("returns kill when bash prompt visible with no activity indicators", () => {
    const pane = "some old output\nuser@host:~/project$ ";
    const result = analyzePaneContent(pane);
    expect(result.action).toBe("kill");
    expect(result.reason).toMatch(/shell prompt/i);
  });

  it("returns kill when zsh prompt visible with no activity indicators", () => {
    const pane = "some old output\nuser@host ~/project% ";
    const result = analyzePaneContent(pane);
    expect(result.action).toBe("kill");
  });

  it("returns kill when starship prompt visible with no activity indicators", () => {
    const pane = "some old output\n❯ ";
    const result = analyzePaneContent(pane);
    expect(result.action).toBe("kill");
  });

  it("returns kill when root prompt visible with no activity indicators", () => {
    const pane = "some old output\nroot@host:/# ";
    const result = analyzePaneContent(pane);
    expect(result.action).toBe("kill");
  });

  it("returns none when shell prompt present but activity indicators also present", () => {
    // Agent might be rendering — shell prompt on last line but spinner above
    const pane = "✻ Thinking about the problem...\nuser@host:~/project$ ";
    const result = analyzePaneContent(pane);
    expect(result.action).toBe("none");
  });

  // ── Agent waiting for input ──

  it("returns nudge when 'Waiting for user' detected", () => {
    const pane = "Processing...\nWaiting for user feedback\n";
    const result = analyzePaneContent(pane);
    expect(result.action).toBe("nudge");
    expect(result.nudgeText).toBe(DEFAULT_NUDGE_TEXT);
  });

  it("returns nudge when Y/N permission prompt detected", () => {
    const pane = "Do you want to proceed? (Y)es / (N)o\n";
    const result = analyzePaneContent(pane);
    expect(result.action).toBe("nudge");
  });

  it("returns nudge when bypass permissions prompt detected", () => {
    const pane = "Would you like to bypass permissions for this operation?\n";
    const result = analyzePaneContent(pane);
    expect(result.action).toBe("nudge");
  });

  it("returns nudge when [y/n] prompt detected", () => {
    const pane = "Apply changes? [y/n]\n";
    const result = analyzePaneContent(pane);
    expect(result.action).toBe("nudge");
  });

  it("returns nudge when approval required detected", () => {
    const pane = "Some output\napproval required\n";
    const result = analyzePaneContent(pane);
    expect(result.action).toBe("nudge");
  });

  // ── Agent exiting ──

  it("returns kill when 'Exiting' detected", () => {
    const pane = "Completed all tasks.\nExiting\n";
    const result = analyzePaneContent(pane);
    expect(result.action).toBe("kill");
    expect(result.reason).toMatch(/exit/i);
  });

  it("returns kill when 'Exiting...' detected", () => {
    const pane = "Done.\nExiting...\nuser@host:~/project$ ";
    const result = analyzePaneContent(pane);
    expect(result.action).toBe("kill");
  });

  it("returns kill when 'session ended' detected", () => {
    const pane = "All work complete.\nsession ended\n";
    const result = analyzePaneContent(pane);
    expect(result.action).toBe("kill");
  });

  // ── Agent still working ──

  it("returns none when Claude Code spinner visible", () => {
    const pane = "Reading file...\n✻ Thinking about the implementation\n";
    const result = analyzePaneContent(pane);
    expect(result.action).toBe("none");
    expect(result.reason).toMatch(/activity/i);
  });

  it("returns none when braille spinner visible", () => {
    const pane = "⠋ Loading...\n";
    const result = analyzePaneContent(pane);
    expect(result.action).toBe("none");
  });

  it("returns none when no conclusive indicator", () => {
    const pane = "Some random output that doesn't match any pattern\n";
    const result = analyzePaneContent(pane);
    expect(result.action).toBe("none");
    expect(result.reason).toMatch(/no conclusive/i);
  });

  // ── Priority: exiting > waiting > shell prompt ──

  it("exiting takes priority over waiting patterns", () => {
    const pane = "Do you want to proceed? (Y)es / (N)o\nExiting\n";
    const result = analyzePaneContent(pane);
    expect(result.action).toBe("kill");
  });

  it("waiting takes priority over shell prompt", () => {
    // Waiting pattern in recent lines, shell prompt on last line
    const pane = "Do you want to proceed? (Y)es / (N)o\nuser@host:~/project$ ";
    const result = analyzePaneContent(pane);
    expect(result.action).toBe("nudge");
  });
});

// ─── Idle cycle tracking ────────────────────────────────────────────────────

describe("recordIdleCycle", () => {
  it("increments count on each idle cycle", () => {
    expect(recordIdleCycle("s1", false)).toBe(1);
    expect(recordIdleCycle("s1", false)).toBe(2);
    expect(recordIdleCycle("s1", false)).toBe(3);
  });

  it("resets count when new PRs detected", () => {
    recordIdleCycle("s1", false);
    recordIdleCycle("s1", false);
    expect(recordIdleCycle("s1", true)).toBe(0);
    expect(recordIdleCycle("s1", false)).toBe(1);
  });

  it("tracks sessions independently", () => {
    recordIdleCycle("s1", false);
    recordIdleCycle("s1", false);
    expect(recordIdleCycle("s2", false)).toBe(1);
    expect(recordIdleCycle("s1", false)).toBe(3);
  });
});

describe("getIdleCycleState", () => {
  it("returns null for untracked sessions", () => {
    expect(getIdleCycleState("unknown")).toBeNull();
  });

  it("returns state with count and firstIdleAt", () => {
    recordIdleCycle("s1", false);
    const state = getIdleCycleState("s1");
    expect(state).not.toBeNull();
    expect(state!.count).toBe(1);
    expect(state!.firstIdleAt).toBeInstanceOf(Date);
  });

  it("preserves firstIdleAt across increments", () => {
    recordIdleCycle("s1", false);
    const first = getIdleCycleState("s1")!.firstIdleAt;
    recordIdleCycle("s1", false);
    expect(getIdleCycleState("s1")!.firstIdleAt).toBe(first);
  });
});

describe("resetIdleCycles", () => {
  it("clears tracking for a specific session", () => {
    recordIdleCycle("s1", false);
    recordIdleCycle("s2", false);
    resetIdleCycles("s1");
    expect(getIdleCycleState("s1")).toBeNull();
    expect(getIdleCycleState("s2")).not.toBeNull();
  });
});

// ─── checkStuckWorker ────────────────────────────────────────────────────────

describe("checkStuckWorker", () => {
  const mockCapture = vi.fn<(name: string, lines?: number) => Promise<string>>();
  const mockKill = vi.fn<(name: string) => Promise<void>>();
  const mockSend = vi.fn<(name: string, text: string) => Promise<void>>();

  beforeEach(() => {
    mockCapture.mockReset();
    mockKill.mockReset();
    mockSend.mockReset();
    mockKill.mockResolvedValue(undefined);
    mockSend.mockResolvedValue(undefined);
  });

  const baseOpts = {
    sessionName: "bb5e6b7f8db3-ao-42",
    sessionId: "ao-42",
    hasNewPRs: false,
    capturePane: mockCapture,
    killSession: mockKill,
    sendKeys: mockSend,
  };

  it("does not inspect before threshold is reached", async () => {
    const r1 = await checkStuckWorker({ ...baseOpts });
    expect(r1.inspected).toBe(false);
    expect(r1.idleCycleCount).toBe(1);
    expect(mockCapture).not.toHaveBeenCalled();

    const r2 = await checkStuckWorker({ ...baseOpts });
    expect(r2.inspected).toBe(false);
    expect(r2.idleCycleCount).toBe(2);
  });

  it("inspects after threshold is reached (default 3)", async () => {
    mockCapture.mockResolvedValue("✻ Working hard...\n");

    // Cycles 1 and 2: no inspection
    await checkStuckWorker({ ...baseOpts });
    await checkStuckWorker({ ...baseOpts });

    // Cycle 3: threshold reached, should inspect
    const result = await checkStuckWorker({ ...baseOpts });
    expect(result.inspected).toBe(true);
    expect(result.verdict).not.toBeNull();
    expect(result.verdict!.action).toBe("none"); // activity detected
    expect(mockCapture).toHaveBeenCalledOnce();
  });

  it("kills session when agent has exited", async () => {
    mockCapture.mockResolvedValue("user@host:~/project$ ");

    // Reach threshold
    for (let i = 0; i < DEFAULT_IDLE_CYCLE_THRESHOLD - 1; i++) {
      await checkStuckWorker({ ...baseOpts });
    }

    const result = await checkStuckWorker({ ...baseOpts });
    expect(result.inspected).toBe(true);
    expect(result.verdict!.action).toBe("kill");
    expect(result.actionTaken).toBe(true);
    expect(mockKill).toHaveBeenCalledWith("bb5e6b7f8db3-ao-42");
  });

  it("sends nudge when agent is waiting for input", async () => {
    mockCapture.mockResolvedValue("Do you want to proceed? (Y)es / (N)o\n");

    for (let i = 0; i < DEFAULT_IDLE_CYCLE_THRESHOLD - 1; i++) {
      await checkStuckWorker({ ...baseOpts });
    }

    const result = await checkStuckWorker({ ...baseOpts });
    expect(result.inspected).toBe(true);
    expect(result.verdict!.action).toBe("nudge");
    expect(result.actionTaken).toBe(true);
    expect(mockSend).toHaveBeenCalledWith("bb5e6b7f8db3-ao-42", DEFAULT_NUDGE_TEXT);
  });

  it("resets idle cycles after kill", async () => {
    mockCapture.mockResolvedValue("user@host:~/project$ ");

    for (let i = 0; i < DEFAULT_IDLE_CYCLE_THRESHOLD; i++) {
      await checkStuckWorker({ ...baseOpts });
    }

    // After kill, cycles should reset
    expect(getIdleCycleState("ao-42")).toBeNull();
  });

  it("resets idle cycles after nudge", async () => {
    mockCapture.mockResolvedValue("Waiting for user feedback\n");

    for (let i = 0; i < DEFAULT_IDLE_CYCLE_THRESHOLD; i++) {
      await checkStuckWorker({ ...baseOpts });
    }

    expect(getIdleCycleState("ao-42")).toBeNull();
  });

  it("resets idle cycles when new PRs appear", async () => {
    recordIdleCycle("ao-42", false);
    recordIdleCycle("ao-42", false);

    const result = await checkStuckWorker({ ...baseOpts, hasNewPRs: true });
    expect(result.idleCycleCount).toBe(0);
    expect(result.inspected).toBe(false);
  });

  it("respects custom idle cycle threshold", async () => {
    mockCapture.mockResolvedValue("✻ Working\n");

    // With threshold of 1, should inspect immediately
    const result = await checkStuckWorker({ ...baseOpts, idleCycleThreshold: 1 });
    expect(result.inspected).toBe(true);
    expect(mockCapture).toHaveBeenCalledOnce();
  });

  it("handles capture failure gracefully", async () => {
    mockCapture.mockRejectedValue(new Error("session dead"));

    for (let i = 0; i < DEFAULT_IDLE_CYCLE_THRESHOLD - 1; i++) {
      await checkStuckWorker({ ...baseOpts });
    }

    const result = await checkStuckWorker({ ...baseOpts });
    expect(result.inspected).toBe(true);
    expect(result.verdict!.action).toBe("kill");
    expect(result.verdict!.reason).toMatch(/capture/i);
    // Should not have called kill (no actionTaken since capture failed path doesn't auto-kill)
    expect(result.actionTaken).toBe(false);
  });

  it("does not take action without kill/send callbacks", async () => {
    mockCapture.mockResolvedValue("user@host:~/project$ ");

    for (let i = 0; i < DEFAULT_IDLE_CYCLE_THRESHOLD - 1; i++) {
      await checkStuckWorker({
        ...baseOpts,
        killSession: undefined,
        sendKeys: undefined,
      });
    }

    const result = await checkStuckWorker({
      ...baseOpts,
      killSession: undefined,
      sendKeys: undefined,
    });
    expect(result.verdict!.action).toBe("kill");
    expect(result.actionTaken).toBe(false);
  });

  it("handles kill failure gracefully", async () => {
    mockCapture.mockResolvedValue("user@host:~/project$ ");
    mockKill.mockRejectedValue(new Error("already dead"));

    for (let i = 0; i < DEFAULT_IDLE_CYCLE_THRESHOLD - 1; i++) {
      await checkStuckWorker({ ...baseOpts });
    }

    // Should not throw
    const result = await checkStuckWorker({ ...baseOpts });
    expect(result.verdict!.action).toBe("kill");
    expect(result.actionTaken).toBe(false);
  });
});
