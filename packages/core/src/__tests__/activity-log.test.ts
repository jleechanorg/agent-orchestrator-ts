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
import type { ActivityDetection, ActivityLogEntry, ActivityState } from "../types.js";

const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

const toActivityResult = (
  entry: ActivityLogEntry,
): { entry: ActivityLogEntry; modifiedAt: Date } => ({
  entry,
  modifiedAt: new Date(entry.ts),
});

const detectWithProcessCheck = (
  isProcessRunning: boolean,
  activityResult: { entry: ActivityLogEntry; modifiedAt: Date } | null,
): ActivityDetection | null => {
  if (!isProcessRunning) return { state: "exited", timestamp: new Date() };
  return checkActivityLogState(activityResult) ?? getActivityFallbackState(activityResult, 30_000, 5 * 60_000);
};

describe("classifyTerminalActivity", () => {
  it("returns active state with no trigger", () => {
    const detect = () => "active" as ActivityState;
    const result = classifyTerminalActivity("some output", detect);
    expect(result).toEqual({ state: "active", trigger: undefined });
  });

  it("returns waiting_input with trigger from last 3 lines", () => {
    const detect = () => "waiting_input" as ActivityState;
    const result = classifyTerminalActivity("line1\nline2\nprompt?", detect);
    expect(result.state).toBe("waiting_input");
    expect(result.trigger).toContain("prompt?");
  });

  it("returns blocked with trigger", () => {
    const detect = () => "blocked" as ActivityState;
    const result = classifyTerminalActivity("error occurred", detect);
    expect(result.state).toBe("blocked");
    expect(result.trigger).toBeDefined();
  });
});

describe("checkActivityLogState", () => {
  it("returns null for null input", () => {
    expect(checkActivityLogState(null)).toBeNull();
  });

  it("returns waiting_input when entry is fresh", () => {
    const result = checkActivityLogState({
      entry: { ts: new Date().toISOString(), state: "waiting_input", source: "terminal" },
      modifiedAt: new Date(),
    });
    expect(result?.state).toBe("waiting_input");
  });

  it("returns blocked when entry is fresh", () => {
    const result = checkActivityLogState({
      entry: { ts: new Date().toISOString(), state: "blocked", source: "terminal" },
      modifiedAt: new Date(),
    });
    expect(result?.state).toBe("blocked");
  });

  it("returns waiting_input even when older than the former wallclock cap", () => {
    const result = checkActivityLogState({
      entry: { ts: minutesAgo(10), state: "waiting_input", source: "terminal" },
      modifiedAt: new Date(),
    });
    expect(result?.state).toBe("waiting_input");
  });

  it("returns blocked even when older than the former wallclock cap", () => {
    const result = checkActivityLogState({
      entry: { ts: minutesAgo(6), state: "blocked", source: "terminal" },
      modifiedAt: new Date(),
    });
    expect(result?.state).toBe("blocked");
  });

  it("returns null for non-critical states", () => {
    const result = checkActivityLogState({
      entry: { ts: new Date().toISOString(), state: "active", source: "terminal" },
      modifiedAt: new Date(),
    });
    expect(result).toBeNull();
  });

  it("returns null for invalid entry.ts", () => {
    const result = checkActivityLogState({
      entry: { ts: "not-a-date", state: "waiting_input", source: "terminal" },
      modifiedAt: new Date(),
    });
    expect(result).toBeNull();
  });
});

describe("getActivityFallbackState", () => {
  it("returns waiting_input for a 10-minute-old entry instead of decaying to idle", () => {
    const result = getActivityFallbackState(
      toActivityResult({ ts: minutesAgo(10), state: "waiting_input", source: "terminal" }),
      30_000,
      5 * 60_000,
    );

    expect(result?.state).toBe("waiting_input");
  });

  it("returns blocked for a 6-minute-old entry instead of decaying to idle", () => {
    const result = getActivityFallbackState(
      toActivityResult({ ts: minutesAgo(6), state: "blocked", source: "terminal" }),
      30_000,
      5 * 60_000,
    );

    expect(result?.state).toBe("blocked");
  });

  it("returns blocked for a 1-minute-old entry with unchanged behavior", () => {
    const result = getActivityFallbackState(
      toActivityResult({ ts: minutesAgo(1), state: "blocked", source: "terminal" }),
      30_000,
      5 * 60_000,
    );

    expect(result?.state).toBe("blocked");
  });

  it("lets a newer active entry override an older waiting_input entry", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "ao-test-"));
    try {
      await mkdir(join(tmpDir, ".ao"), { recursive: true });
      const waitingEntry: ActivityLogEntry = {
        ts: minutesAgo(6),
        state: "waiting_input",
        source: "terminal",
      };
      const activeEntry: ActivityLogEntry = {
        ts: new Date(Date.now() - 1000).toISOString(),
        state: "active",
        source: "terminal",
      };
      await writeFile(
        getActivityLogPath(tmpDir),
        `${JSON.stringify(waitingEntry)}\n${JSON.stringify(activeEntry)}\n`,
        "utf-8",
      );

      const activityResult = await readLastActivityEntry(tmpDir);
      const result = getActivityFallbackState(activityResult, 30_000, 5 * 60_000);

      expect(activityResult?.entry.state).toBe("active");
      expect(result?.state).toBe("active");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns exited when the process check fails before a stale waiting_input can fall through", () => {
    const result = detectWithProcessCheck(
      false,
      toActivityResult({ ts: minutesAgo(6), state: "waiting_input", source: "terminal" }),
    );

    expect(result?.state).toBe("exited");
  });
});

describe("readLastActivityEntry", () => {
>>>>>>> ce6b47adf (fix(core): keep actionable activity sticky (#1902))
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

  it("returns null for missing required fields", async () => {
    await mkdir(join(tmpDir, ".ao"), { recursive: true });
    const bad = JSON.stringify({ ts: new Date().toISOString() });
    await writeFile(getActivityLogPath(tmpDir), bad + "\n", "utf-8");
    const result = await readLastActivityEntry(tmpDir);
    expect(result).toBeNull();
  });

  it("falls back to the previous complete line when a read races a truncated tail", async () => {
    await mkdir(join(tmpDir, ".ao"), { recursive: true });
    const completeEntry: ActivityLogEntry = {
      ts: minutesAgo(10),
      state: "waiting_input",
      source: "terminal",
      trigger: "approve?",
    };
    await writeFile(
      getActivityLogPath(tmpDir),
      `${JSON.stringify(completeEntry)}\n{"ts":"${new Date().toISOString()}","state":`,
      "utf-8",
    );

    const result = await readLastActivityEntry(tmpDir);

    expect(result?.entry).toEqual(completeEntry);
  });
});

describe("recordTerminalActivity", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ao-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes activity entry to JSONL", async () => {
    const detect = () => "active" as ActivityState;
    await recordTerminalActivity(tmpDir, "output", detect);
    const result = await readLastActivityEntry(tmpDir);
    expect(result!.entry.state).toBe("active");
    expect(result!.entry.source).toBe("terminal");
  });

  it("writes waiting_input with trigger", async () => {
    const detect = () => "waiting_input" as ActivityState;
    await recordTerminalActivity(tmpDir, "line1\nline2\nprompt?", detect);
    const result = await readLastActivityEntry(tmpDir);
    expect(result!.entry.state).toBe("waiting_input");
    expect(result!.entry.trigger).toBeDefined();
  });

  it("deduplicates same state within 20s", async () => {
    const detect = () => "active" as ActivityState;
    await recordTerminalActivity(tmpDir, "output1", detect);
    await recordTerminalActivity(tmpDir, "output2", detect);

    const { readFile: rf } = await import("node:fs/promises");
    const content = await rf(getActivityLogPath(tmpDir), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it("always writes actionable states even if same", async () => {
    const detect = () => "waiting_input" as ActivityState;
    await recordTerminalActivity(tmpDir, "prompt1", detect);
    await recordTerminalActivity(tmpDir, "prompt2", detect);

    const { readFile: rf } = await import("node:fs/promises");
    const content = await rf(getActivityLogPath(tmpDir), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
  });
  });
});
