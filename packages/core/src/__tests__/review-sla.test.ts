import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  evaluateReviewSLA,
  getSLAState,
  DEFAULT_REVIEW_SLA_CONFIG,
} from "../review-sla.js";
import type { Session } from "../types.js";

const BASE_NOW_MS = new Date("2025-06-01T12:00:00Z").getTime();

function minutesAgo(minutes: number): string {
  return new Date(BASE_NOW_MS - minutes * 60_000).toISOString();
}

function makeSession(overrides: Partial<Session["metadata"]> = {}): Session {
  return {
    id: "worker-1",
    projectId: "test-project",
    status: "changes_requested",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/worker-1",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {
      review_sla_first_seen_at: minutesAgo(10),
      review_sla_last_escalate_at: "",
      review_sla_cycle_count: "0",
      review_sla_level: "ok",
      ...overrides,
    },
  };
}

beforeEach(() => {
  // Freeze Date.now() so minutesSince() in the implementation
  // uses the same reference as the test's minutesAgo()
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE_NOW_MS));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getSLAState", () => {
  it("returns correct defaults for empty session", () => {
    const session = makeSession({});
    const state = getSLAState(session);
    expect(state.firstSeenAt).toBeTruthy();
    expect(state.cycleCount).toBe(0);
    expect(state.currentLevel).toBe("ok");
  });

  it("reads cycle count from metadata", () => {
    const session = makeSession({ review_sla_cycle_count: "3" });
    expect(getSLAState(session).cycleCount).toBe(3);
  });

  it("reads current level from metadata", () => {
    const session = makeSession({ review_sla_level: "escalate" });
    expect(getSLAState(session).currentLevel).toBe("escalate");
  });
});

describe("evaluateReviewSLA", () => {
  describe("default thresholds (15m warn, 45m escalate, 120m abandon)", () => {
    const cfg = DEFAULT_REVIEW_SLA_CONFIG;

    it("returns ok when SLA has not started", () => {
      const session = makeSession({ review_sla_first_seen_at: "" });
      const result = evaluateReviewSLA(session, cfg);
      expect(result.level).toBe("ok");
      expect(result.shouldWarn).toBe(false);
      expect(result.shouldEscalate).toBe(false);
      expect(result.shouldAbandon).toBe(false);
    });

    it("returns ok when session is fresh (< 15 min)", () => {
      const session = makeSession({ review_sla_first_seen_at: minutesAgo(5) });
      const result = evaluateReviewSLA(session, cfg);
      expect(result.level).toBe("ok");
      expect(result.shouldWarn).toBe(false);
    });

    it("returns warn when > 15 min but < 45 min and currentLevel is ok", () => {
      const session = makeSession({
        review_sla_first_seen_at: minutesAgo(20),
        review_sla_level: "ok",
      });
      const result = evaluateReviewSLA(session, cfg);
      expect(result.level).toBe("warn");
      expect(result.shouldWarn).toBe(true);
      expect(result.shouldEscalate).toBe(false);
    });

    it("returns escalate when > 45 min", () => {
      const session = makeSession({
        review_sla_first_seen_at: minutesAgo(50),
        review_sla_level: "ok",
      });
      const result = evaluateReviewSLA(session, cfg);
      expect(result.level).toBe("escalate");
      expect(result.shouldEscalate).toBe(true);
    });

    it("returns escalate when warn level and > 45 min", () => {
      const session = makeSession({
        review_sla_first_seen_at: minutesAgo(50),
        review_sla_level: "warn",
      });
      const result = evaluateReviewSLA(session, cfg);
      expect(result.level).toBe("escalate");
      expect(result.shouldEscalate).toBe(true);
    });

    it("returns abandon when > 120 min", () => {
      const session = makeSession({
        review_sla_first_seen_at: minutesAgo(130),
        review_sla_level: "escalate",
      });
      const result = evaluateReviewSLA(session, cfg);
      expect(result.level).toBe("abandon");
      expect(result.shouldAbandon).toBe(true);
    });

    it("reports correct minutesInState", () => {
      const session = makeSession({ review_sla_first_seen_at: minutesAgo(25) });
      const result = evaluateReviewSLA(session, cfg);
      expect(result.minutesInState).toBeCloseTo(25, 0);
    });

    it("returns levelTransition true when transitioning", () => {
      const session = makeSession({
        review_sla_first_seen_at: minutesAgo(50),
        review_sla_level: "ok",
      });
      const result = evaluateReviewSLA(session, cfg);
      expect(result.levelTransition).toBe(true);
    });

    it("returns levelTransition false when already at same level", () => {
      const session = makeSession({
        review_sla_first_seen_at: minutesAgo(50),
        review_sla_level: "escalate",
      });
      const result = evaluateReviewSLA(session, cfg);
      expect(result.levelTransition).toBe(false);
    });
  });

  describe("escalation interval increases per cycle", () => {
    const cfg = DEFAULT_REVIEW_SLA_CONFIG;

    it("cycle 0 escalates after 45 min", () => {
      const session = makeSession({
        review_sla_first_seen_at: minutesAgo(46),
        review_sla_cycle_count: "0",
        review_sla_last_escalate_at: "",
        review_sla_level: "ok",
      });
      const result = evaluateReviewSLA(session, cfg);
      expect(result.shouldEscalate).toBe(true);
    });

    it("cycle 1 escalates after 90 min (45 × (1+1))", () => {
      const session = makeSession({
        review_sla_first_seen_at: minutesAgo(80),
        review_sla_cycle_count: "1",
        review_sla_last_escalate_at: minutesAgo(10),
        review_sla_level: "escalate",
      });
      const result = evaluateReviewSLA(session, cfg);
      // 80 min in state, last escalate 10 min ago → escalation interval for cycle 1 = 90 min
      // elapsed since last escalate = 10 min < 90 min → should not escalate yet
      expect(result.shouldEscalate).toBe(false);
    });
  });

  describe("custom thresholds", () => {
    it("honors custom warn threshold", () => {
      const session = makeSession({
        review_sla_first_seen_at: minutesAgo(10),
        review_sla_level: "ok",
      });
      const result = evaluateReviewSLA(session, { ...DEFAULT_REVIEW_SLA_CONFIG, warnAfterMinutes: 5 });
      expect(result.shouldWarn).toBe(true);
    });

    it("honors custom abandon threshold", () => {
      const session = makeSession({
        review_sla_first_seen_at: minutesAgo(15),
        review_sla_level: "escalate",
      });
      const result = evaluateReviewSLA(session, { ...DEFAULT_REVIEW_SLA_CONFIG, abandonAfterMinutes: 10 });
      expect(result.shouldAbandon).toBe(true);
    });
  });
});
