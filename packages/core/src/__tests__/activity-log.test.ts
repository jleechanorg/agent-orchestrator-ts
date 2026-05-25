import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readLastActivityEntry,
  checkActivityLogState,
  getActivityFallbackState,
  recordTerminalActivity,
  getActivityLogPath,
  appendActivityEntry,
  ACTIVITY_INPUT_STALENESS_MS,
} from "../activity-log.js";
import type { ActivityLogEntry } from "../types.js";

describe("activity-log", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeWorkspace(): string {
    tmpDir = mkdtempSync(join(tmpdir(), "ao-activity-test-"));
    return tmpDir;
  }

  describe("getActivityLogPath", () => {
    it("returns path under .ao directory", () => {
      expect(getActivityLogPath("/workspace")).toBe("/workspace/.ao/activity.jsonl");
    });
  });

  describe("appendActivityEntry", () => {
    it("creates .ao directory and appends entry", async () => {
      const ws = makeWorkspace();
      await appendActivityEntry(ws, "active", "terminal");
      const result = await readLastActivityEntry(ws);
      expect(result).not.toBeNull();
      expect(result!.entry.state).toBe("active");
      expect(result!.entry.source).toBe("terminal");
    });

    it("appends trigger for waiting_input state", async () => {
      const ws = makeWorkspace();
      await appendActivityEntry(ws, "waiting_input", "terminal", "prompt>");
      const result = await readLastActivityEntry(ws);
      expect(result!.entry.state).toBe("waiting_input");
      expect(result!.entry.trigger).toBe("prompt>");
    });

    it("omits trigger for non-actionable states", async () => {
      const ws = makeWorkspace();
      await appendActivityEntry(ws, "active", "terminal", "ignored");
      const result = await readLastActivityEntry(ws);
      expect(result!.entry.trigger).toBeUndefined();
    });
  });

  describe("readLastActivityEntry", () => {
    it("returns null for nonexistent workspace", async () => {
      expect(await readLastActivityEntry("/nonexistent/path")).toBeNull();
    });

    it("returns null for empty file", async () => {
      const ws = makeWorkspace();
      mkdirSync(join(ws, ".ao"), { recursive: true });
      writeFileSync(join(ws, ".ao", "activity.jsonl"), "");
      expect(await readLastActivityEntry(ws)).toBeNull();
    });

    it("reads the last valid entry", async () => {
      const ws = makeWorkspace();
      const logPath = getActivityLogPath(ws);
      mkdirSync(join(ws, ".ao"), { recursive: true });
      writeFileSync(
        logPath,
        JSON.stringify({ ts: new Date().toISOString(), state: "active", source: "terminal" }) +
          "\n" +
          JSON.stringify({ ts: new Date().toISOString(), state: "idle", source: "terminal" }) +
          "\n",
        "utf-8",
      );
      const result = await readLastActivityEntry(ws);
      expect(result!.entry.state).toBe("idle");
    });

    it("returns null for entry with invalid state", async () => {
      const ws = makeWorkspace();
      const logPath = getActivityLogPath(ws);
      mkdirSync(join(ws, ".ao"), { recursive: true });
      writeFileSync(logPath, JSON.stringify({
        ts: new Date().toISOString(),
        state: "invalid_state",
        source: "terminal",
      }) + "\n", "utf-8");
      expect(await readLastActivityEntry(ws)).toBeNull();
    });

    it("returns null for entry with invalid source", async () => {
      const ws = makeWorkspace();
      const logPath = getActivityLogPath(ws);
      mkdirSync(join(ws, ".ao"), { recursive: true });
      writeFileSync(logPath, JSON.stringify({
        ts: new Date().toISOString(),
        state: "active",
        source: "invalid",
      }) + "\n", "utf-8");
      expect(await readLastActivityEntry(ws)).toBeNull();
    });
  });

  describe("checkActivityLogState", () => {
    it("returns null for null input", () => {
      expect(checkActivityLogState(null)).toBeNull();
    });

    it("returns detection for fresh waiting_input", () => {
      const entry: ActivityLogEntry = {
        ts: new Date().toISOString(),
        state: "waiting_input",
        source: "terminal",
      };
      const result = checkActivityLogState({ entry, modifiedAt: new Date() });
      expect(result).not.toBeNull();
      expect(result!.state).toBe("waiting_input");
    });

    it("returns detection for fresh blocked", () => {
      const entry: ActivityLogEntry = {
        ts: new Date().toISOString(),
        state: "blocked",
        source: "terminal",
      };
      const result = checkActivityLogState({ entry, modifiedAt: new Date() });
      expect(result).not.toBeNull();
      expect(result!.state).toBe("blocked");
    });

    it("returns null for non-actionable states (active, ready, idle)", () => {
      for (const state of ["active", "ready", "idle"] as const) {
        const entry: ActivityLogEntry = {
          ts: new Date().toISOString(),
          state,
          source: "terminal",
        };
        expect(checkActivityLogState({ entry, modifiedAt: new Date() })).toBeNull();
      }
    });

    it("returns null for stale waiting_input (older than ACTIVITY_INPUT_STALENESS_MS)", () => {
      const staleTs = new Date(Date.now() - ACTIVITY_INPUT_STALENESS_MS - 60000);
      const entry: ActivityLogEntry = {
        ts: staleTs.toISOString(),
        state: "waiting_input",
        source: "terminal",
      };
      expect(checkActivityLogState({ entry, modifiedAt: new Date() })).toBeNull();
    });

    it("returns null for entry with invalid timestamp", () => {
      const entry: ActivityLogEntry = {
        ts: "not-a-date",
        state: "waiting_input",
        source: "terminal",
      };
      expect(checkActivityLogState({ entry, modifiedAt: new Date() })).toBeNull();
    });
  });

  describe("getActivityFallbackState", () => {
    it("returns null for null input", () => {
      expect(getActivityFallbackState(null, 60000, 300000)).toBeNull();
    });

    it("returns null for entry with invalid timestamp", () => {
      const entry: ActivityLogEntry = {
        ts: "not-a-date",
        state: "active",
        source: "terminal",
      };
      expect(getActivityFallbackState({ entry, modifiedAt: new Date() }, 60000, 300000)).toBeNull();
    });

    it("returns fresh waiting_input as waiting_input", () => {
      const entry: ActivityLogEntry = {
        ts: new Date().toISOString(),
        state: "waiting_input",
        source: "terminal",
      };
      const result = getActivityFallbackState({ entry, modifiedAt: new Date() }, 60000, 300000);
      expect(result!.state).toBe("waiting_input");
    });

    it("returns idle for stale waiting_input", () => {
      const staleTs = new Date(Date.now() - ACTIVITY_INPUT_STALENESS_MS - 60000);
      const entry: ActivityLogEntry = {
        ts: staleTs.toISOString(),
        state: "waiting_input",
        source: "terminal",
      };
      const result = getActivityFallbackState({ entry, modifiedAt: new Date() }, 60000, 300000);
      expect(result!.state).toBe("idle");
    });

    it("decays active to ready after activeWindowMs", () => {
      const entryTs = new Date(Date.now() - 120000);
      const entry: ActivityLogEntry = {
        ts: entryTs.toISOString(),
        state: "active",
        source: "terminal",
      };
      const result = getActivityFallbackState({ entry, modifiedAt: new Date() }, 60000, 300000);
      expect(result!.state).toBe("ready");
    });

    it("decays to idle after thresholdMs", () => {
      const entryTs = new Date(Date.now() - 600000);
      const entry: ActivityLogEntry = {
        ts: entryTs.toISOString(),
        state: "active",
        source: "terminal",
      };
      const result = getActivityFallbackState({ entry, modifiedAt: new Date() }, 60000, 300000);
      expect(result!.state).toBe("idle");
    });

    it("never promotes state above entry state", () => {
      const entryTs = new Date(Date.now() - 600000);
      const entry: ActivityLogEntry = {
        ts: entryTs.toISOString(),
        state: "exited",
        source: "terminal",
      };
      const result = getActivityFallbackState({ entry, modifiedAt: new Date() }, 60000, 300000);
      expect(result!.state).toBe("exited");
    });
  });

  describe("recordTerminalActivity", () => {
    it("writes activity entry for active state", async () => {
      const ws = makeWorkspace();
      await recordTerminalActivity(ws, "working on code", () => "active");
      const result = await readLastActivityEntry(ws);
      expect(result).not.toBeNull();
      expect(result!.entry.state).toBe("active");
    });

    it("writes entry for waiting_input state", async () => {
      const ws = makeWorkspace();
      await recordTerminalActivity(ws, "prompt> enter command", () => "waiting_input");
      const result = await readLastActivityEntry(ws);
      expect(result!.entry.state).toBe("waiting_input");
      expect(result!.entry.trigger).toContain("prompt> enter command");
    });

    it("deduplicates non-actionable state writes within 20s", async () => {
      const ws = makeWorkspace();
      mkdirSync(join(ws, ".ao"), { recursive: true });
      const logPath = getActivityLogPath(ws);
      const ts = new Date().toISOString();
      writeFileSync(logPath, JSON.stringify({ ts, state: "active", source: "terminal" }) + "\n", "utf-8");
      const sizeBefore = statSync(logPath).size;
      await recordTerminalActivity(ws, "still active", () => "active");
      const sizeAfter = statSync(logPath).size;
      expect(sizeAfter).toBe(sizeBefore);
    });
  });
});
