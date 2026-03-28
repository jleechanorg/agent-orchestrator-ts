import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";

import { logAoAction, type AoAction } from "../src/ao-action-log.js";

describe("logAoAction", () => {
  const logPath = "/tmp/ao-actions.jsonl";
  let backup: string | null = null;

  beforeEach(() => {
    try {
      backup = readFileSync(logPath, "utf-8");
    } catch {
      backup = null;
    }
  });

  afterEach(() => {
    if (backup !== null) {
      writeFileSync(logPath, backup, { mode: 0o600 });
    }
  });

  it("appends a JSONL line to the log file", () => {
    const action: AoAction = {
      ts: "2026-03-28T10:00:00.000Z",
      session: "test-session",
      action: "pr_merge",
      pr: 42,
      repo: "owner/repo",
      reason: "test",
      detail: "squash (immediate)",
    };

    logAoAction(action);

    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);

    expect(last.session).toBe("test-session");
    expect(last.action).toBe("pr_merge");
    expect(last.pr).toBe(42);
    expect(last.detail).toBe("squash (immediate)");
  });

  it("does not throw on write errors (silent failure contract)", () => {
    expect(() =>
      logAoAction({
        ts: "2026-03-28T10:00:00.000Z",
        session: "s",
        action: "session_kill",
      }),
    ).not.toThrow();
  });

  it("uses current timestamp when ts is empty", () => {
    const before = new Date().toISOString();
    logAoAction({
      ts: "",
      session: "ts-test",
      action: "pr_close",
      pr: 99,
    });
    const after = new Date().toISOString();

    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);

    expect(last.ts).toBeTruthy();
    expect(last.ts >= before).toBe(true);
    expect(last.ts <= after).toBe(true);
  });
});
