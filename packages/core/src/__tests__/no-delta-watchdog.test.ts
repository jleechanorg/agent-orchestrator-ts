import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  evaluateNoDeltaWatchdog,
  DEFAULT_NO_DELTA_CONFIG,
} from "../no-delta-watchdog.js";
import type { Session } from "../types.js";

const BASE_NOW_MS = new Date("2025-06-01T12:00:00Z").getTime();

function minutesAgo(minutes: number): string {
  return new Date(BASE_NOW_MS - minutes * 60_000).toISOString();
}

function makeSession(metadataOverrides: Record<string, string> = {}): Session {
  return {
    id: "worker-1",
    projectId: "test-project",
    status: "working",
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
      createdAt: minutesAgo(30),
      ...metadataOverrides,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE_NOW_MS));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("evaluateNoDeltaWatchdog", () => {
  describe("disabled watchdog", () => {
    it("returns ok when enabled=false", () => {
      const session = makeSession({ no_delta_last_delta_at: minutesAgo(200) });
      const result = evaluateNoDeltaWatchdog(session, { ...DEFAULT_NO_DELTA_CONFIG, enabled: false });
      expect(result.result).toBe("ok");
      expect(result.shouldNotify).toBe(false);
      expect(result.shouldMarkStuck).toBe(false);
    });
  });

  describe("delta tracking (last_delta_at present)", () => {
    const cfg = DEFAULT_NO_DELTA_CONFIG;

    it("returns ok when delta is recent", () => {
      const session = makeSession({ no_delta_last_delta_at: minutesAgo(5) });
      const result = evaluateNoDeltaWatchdog(session, cfg);
      expect(result.result).toBe("ok");
    });

    it("returns warn when delta is stale (20+ min)", () => {
      const session = makeSession({ no_delta_last_delta_at: minutesAgo(25) });
      const result = evaluateNoDeltaWatchdog(session, cfg);
      expect(result.result).toBe("warn");
      expect(result.shouldNotify).toBe(true);
      expect(result.shouldMarkStuck).toBe(false);
    });

    it("returns stuck when delta is very stale (60+ min)", () => {
      const session = makeSession({ no_delta_last_delta_at: minutesAgo(65) });
      const result = evaluateNoDeltaWatchdog(session, cfg);
      expect(result.result).toBe("stuck");
      expect(result.shouldMarkStuck).toBe(true);
    });

    it("only notifies on first transition to warn (not every check)", () => {
      const session = makeSession({
        no_delta_last_delta_at: minutesAgo(25),
        no_delta_warn_at: minutesAgo(1), // already warned
      });
      const result = evaluateNoDeltaWatchdog(session, cfg);
      expect(result.result).toBe("warn");
      expect(result.shouldNotify).toBe(false); // already warned
    });

    it("only marks stuck on first transition", () => {
      const session = makeSession({
        no_delta_last_delta_at: minutesAgo(65),
        no_delta_stuck_at: minutesAgo(1), // already marked
      });
      const result = evaluateNoDeltaWatchdog(session, cfg);
      expect(result.result).toBe("stuck");
      expect(result.shouldMarkStuck).toBe(false);
    });
  });

  describe("session-start tracking (no last_delta_at)", () => {
    const cfg = DEFAULT_NO_DELTA_CONFIG;

    it("uses session created_at when no delta recorded yet", () => {
      const session = makeSession({}); // no no_delta_last_delta_at
      const result = evaluateNoDeltaWatchdog(session, cfg);
      // created_at = 30 min ago → should be warn (20+)
      expect(result.result).toBe("warn");
      expect(result.shouldNotify).toBe(true);
    });

    it("marks stuck if session is old and no delta recorded", () => {
      const session = makeSession({
        createdAt: minutesAgo(120),
      });
      const result = evaluateNoDeltaWatchdog(session, cfg);
      expect(result.result).toBe("stuck");
      expect(result.shouldMarkStuck).toBe(true);
    });

    it("returns ok for fresh session with no delta", () => {
      const session = makeSession({
        createdAt: minutesAgo(5),
      });
      const result = evaluateNoDeltaWatchdog(session, cfg);
      expect(result.result).toBe("ok");
    });
  });

  describe("custom thresholds", () => {
    it("honors custom warn threshold", () => {
      const session = makeSession({ no_delta_last_delta_at: minutesAgo(12) });
      const result = evaluateNoDeltaWatchdog(session, {
        ...DEFAULT_NO_DELTA_CONFIG,
        warnThresholdMinutes: 10,
        enabled: true,
      });
      expect(result.result).toBe("warn");
    });

    it("honors custom stuck threshold", () => {
      const session = makeSession({ no_delta_last_delta_at: minutesAgo(35) });
      const result = evaluateNoDeltaWatchdog(session, {
        ...DEFAULT_NO_DELTA_CONFIG,
        stuckThresholdMinutes: 30,
        enabled: true,
      });
      expect(result.result).toBe("stuck");
    });
  });
});

describe("DEFAULT_NO_DELTA_CONFIG", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_NO_DELTA_CONFIG.stuckThresholdMinutes).toBe(60);
    expect(DEFAULT_NO_DELTA_CONFIG.warnThresholdMinutes).toBe(20);
    expect(DEFAULT_NO_DELTA_CONFIG.enabled).toBe(true);
  });
});
