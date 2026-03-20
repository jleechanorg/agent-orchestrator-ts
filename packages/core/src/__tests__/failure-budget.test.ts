import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { FailureBudgetTracker, routeExhaustedBudget } from "../failure-budget.js";
import type { ReactionConfig, ReactionResult } from "../types.js";

describe("FailureBudgetTracker", () => {
  let tracker: FailureBudgetTracker;

  beforeEach(() => {
    tracker = new FailureBudgetTracker({ max: 3 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with zero count", () => {
    expect(tracker.getCount("session-1", "ci-retry")).toBe(0);
  });

  it("recordFailure increments count for session+reaction", () => {
    tracker.recordFailure("session-1", "ci-retry");
    tracker.recordFailure("session-1", "ci-retry");
    expect(tracker.getCount("session-1", "ci-retry")).toBe(2);
  });

  it("isExhausted returns false when under budget", () => {
    tracker.recordFailure("session-1", "ci-retry");
    tracker.recordFailure("session-1", "ci-retry");
    expect(tracker.isExhausted("session-1", "ci-retry")).toBe(false);
  });

  it("isExhausted returns true when at budget max", () => {
    tracker.recordFailure("session-1", "ci-retry");
    tracker.recordFailure("session-1", "ci-retry");
    tracker.recordFailure("session-1", "ci-retry");
    expect(tracker.isExhausted("session-1", "ci-retry")).toBe(true);
  });

  it("isExhausted returns true when over budget max", () => {
    tracker.recordFailure("session-1", "ci-retry");
    tracker.recordFailure("session-1", "ci-retry");
    tracker.recordFailure("session-1", "ci-retry");
    tracker.recordFailure("session-1", "ci-retry");
    expect(tracker.isExhausted("session-1", "ci-retry")).toBe(true);
  });

  it("different sessions have independent budgets", () => {
    tracker.recordFailure("session-1", "ci-retry");
    tracker.recordFailure("session-1", "ci-retry");
    tracker.recordFailure("session-1", "ci-retry");
    expect(tracker.isExhausted("session-1", "ci-retry")).toBe(true);
    expect(tracker.isExhausted("session-2", "ci-retry")).toBe(false);
  });

  it("different reaction types have independent budgets", () => {
    tracker.recordFailure("session-1", "ci-retry");
    tracker.recordFailure("session-1", "ci-retry");
    tracker.recordFailure("session-1", "ci-retry");
    expect(tracker.isExhausted("session-1", "ci-retry")).toBe(true);
    expect(tracker.isExhausted("session-1", "stuck-recovery")).toBe(false);
  });

  it("reset clears count for session+reaction", () => {
    tracker.recordFailure("session-1", "ci-retry");
    tracker.recordFailure("session-1", "ci-retry");
    tracker.recordFailure("session-1", "ci-retry");
    tracker.reset("session-1", "ci-retry");
    expect(tracker.getCount("session-1", "ci-retry")).toBe(0);
    expect(tracker.isExhausted("session-1", "ci-retry")).toBe(false);
  });

  it("resetExpiredWindows removes entries past the window", () => {
    vi.useFakeTimers();
    const windowedTracker = new FailureBudgetTracker({ max: 3, window: "1h" });
    windowedTracker.recordFailure("session-1", "ci-retry");
    windowedTracker.recordFailure("session-1", "ci-retry");
    windowedTracker.recordFailure("session-1", "ci-retry");
    expect(windowedTracker.isExhausted("session-1", "ci-retry")).toBe(true);

    // Advance time past the window
    vi.advanceTimersByTime(2 * 60 * 60 * 1000); // 2 hours
    windowedTracker.resetExpiredWindows();

    expect(windowedTracker.getCount("session-1", "ci-retry")).toBe(0);
    expect(windowedTracker.isExhausted("session-1", "ci-retry")).toBe(false);
  });

  it("resetExpiredWindows does not remove entries within the window", () => {
    vi.useFakeTimers();
    const windowedTracker = new FailureBudgetTracker({ max: 3, window: "1h" });
    windowedTracker.recordFailure("session-1", "ci-retry");
    windowedTracker.recordFailure("session-1", "ci-retry");
    windowedTracker.recordFailure("session-1", "ci-retry");
    expect(windowedTracker.isExhausted("session-1", "ci-retry")).toBe(true);

    // Advance time within the window
    vi.advanceTimersByTime(30 * 60 * 1000); // 30 minutes
    windowedTracker.resetExpiredWindows();

    expect(windowedTracker.getCount("session-1", "ci-retry")).toBe(3);
    expect(windowedTracker.isExhausted("session-1", "ci-retry")).toBe(true);
  });

  it("tracker with no window never auto-expires", () => {
    vi.useFakeTimers();
    tracker.recordFailure("session-1", "ci-retry");
    tracker.recordFailure("session-1", "ci-retry");
    tracker.recordFailure("session-1", "ci-retry");
    vi.advanceTimersByTime(100 * 60 * 60 * 1000); // 100 hours
    tracker.resetExpiredWindows();
    expect(tracker.getCount("session-1", "ci-retry")).toBe(3);
  });
});

describe("routeExhaustedBudget", () => {
  it("escalate action emits escalation event and notifies human", async () => {
    const config: ReactionConfig = {
      auto: true,
      action: "send-to-agent",
      onBudgetExhausted: "escalate",
      failureBudget: { max: 3 },
    };
    const notify = vi.fn().mockResolvedValue(undefined);
    const result = await routeExhaustedBudget(config, "session-1", "ci-retry", {
      notify,
      projectId: "my-app",
      spawnSession: vi.fn(),
    });
    expect(result.escalated).toBe(true);
    expect(result.action).toBe("escalate");
    expect(result.success).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: "urgent",
      }),
    );
  });

  it("disable action returns disabled result without side effects", async () => {
    const config: ReactionConfig = {
      auto: true,
      action: "send-to-agent",
      onBudgetExhausted: "disable",
      failureBudget: { max: 3 },
    };
    const notify = vi.fn().mockResolvedValue(undefined);
    const result = await routeExhaustedBudget(config, "session-1", "ci-retry", {
      notify,
      projectId: "my-app",
      spawnSession: vi.fn(),
    });
    expect(result.action).toBe("disable");
    expect(result.escalated).toBe(false);
    expect(result.success).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it("notify action sends notification without escalation flag", async () => {
    const config: ReactionConfig = {
      auto: true,
      action: "send-to-agent",
      onBudgetExhausted: "notify",
      failureBudget: { max: 3 },
    };
    const notify = vi.fn().mockResolvedValue(undefined);
    const result = await routeExhaustedBudget(config, "session-1", "ci-retry", {
      notify,
      projectId: "my-app",
      spawnSession: vi.fn(),
    });
    expect(result.action).toBe("notify");
    expect(result.escalated).toBe(false);
    expect(result.success).toBe(true);
    expect(notify).toHaveBeenCalled();
  });

  it("route-to action includes agent name in result", async () => {
    const config: ReactionConfig = {
      auto: true,
      action: "send-to-agent",
      onBudgetExhausted: "route-to",
      routeToAgent: "fallback-agent",
      failureBudget: { max: 3 },
    };
    const spawnSession = vi.fn().mockResolvedValue(undefined);
    const result = await routeExhaustedBudget(config, "session-1", "ci-retry", {
      notify: vi.fn().mockResolvedValue(undefined),
      projectId: "my-app",
      spawnSession,
    });
    expect(result.action).toBe("route-to");
    expect(result.message).toContain("fallback-agent");
    expect(result.escalated).toBe(false);
    expect(result.success).toBe(true);
    expect(spawnSession).toHaveBeenCalledWith("fallback-agent");
  });

  it("route-to without routeToAgent falls back to escalate", async () => {
    const config: ReactionConfig = {
      auto: true,
      action: "send-to-agent",
      onBudgetExhausted: "route-to",
      // routeToAgent deliberately omitted
      failureBudget: { max: 3 },
    };
    const notify = vi.fn().mockResolvedValue(undefined);
    const result = await routeExhaustedBudget(config, "session-1", "ci-retry", {
      notify,
      projectId: "my-app",
      spawnSession: vi.fn(),
    });
    expect(result.escalated).toBe(true);
    expect(notify).toHaveBeenCalled();
  });
});
