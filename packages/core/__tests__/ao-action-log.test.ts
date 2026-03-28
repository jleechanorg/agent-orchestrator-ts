import { describe, it, expect, vi, beforeEach } from "vitest";
import { logAoAction, type AoAction } from "../src/ao-action-log.js";
import { appendFileSync, mkdirSync } from "node:fs";

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

describe("logAoAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes a JSONL line with the correct fields", () => {
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

    expect(appendFileSync).toHaveBeenCalledOnce();
    const [path, line, opts] = vi.mocked(appendFileSync).mock.calls[0];
    expect(path).toBe("/tmp/ao-actions.jsonl");
    expect(opts).toEqual({ mode: 0o600 });

    const parsed = JSON.parse(String(line).trim());
    expect(parsed.session).toBe("test-session");
    expect(parsed.action).toBe("pr_merge");
    expect(parsed.pr).toBe(42);
    expect(parsed.detail).toBe("squash (immediate)");
  });

  it("does not throw when appendFileSync throws (silent-failure contract)", () => {
    vi.mocked(appendFileSync).mockImplementation(() => {
      throw new Error("ENOSPC");
    });

    expect(() =>
      logAoAction({
        ts: "2026-03-28T10:00:00.000Z",
        session: "silent-fail-test",
        action: "session_kill",
      }),
    ).not.toThrow();

    expect(appendFileSync).toHaveBeenCalledOnce();
  });

  it("calls mkdirSync with the log directory before appending", () => {
    logAoAction({
      ts: "2026-03-28T10:00:00.000Z",
      session: "mkdir-test",
      action: "pr_close",
      pr: 99,
    });

    expect(mkdirSync).toHaveBeenCalledWith("/tmp", { recursive: true });
  });

  it("defaults ts to current ISO timestamp when ts is omitted", () => {
    logAoAction({
      session: "ts-default-test",
      action: "pr_merge",
      pr: 1,
    });

    expect(appendFileSync).toHaveBeenCalledOnce();
    const [, line] = vi.mocked(appendFileSync).mock.calls[0];
    const parsed = JSON.parse(String(line).trim());
    // Should be a valid ISO timestamp (approx: 2026-03-28T...)
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("returns normally when mkdirSync throws (silent-failure contract)", () => {
    // mkdirSync throwing is also swallowed — the catch block covers all fs errors.
    // logAoAction must never propagate a logging failure into the caller.
    vi.mocked(mkdirSync).mockImplementation(() => {
      throw new Error("EROFS");
    });

    expect(() =>
      logAoAction({
        session: "mkdir-fail-test",
        action: "session_kill",
      }),
    ).not.toThrow();
  });
});
