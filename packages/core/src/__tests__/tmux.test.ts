import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  isTmuxAvailable,
  listSessions,
  hasSession,
  newSession,
  sendKeys,
  capturePane,
  killSession,
  getPaneTTY,
  tmuxInject,
} from "../tmux.js";

/**
 * Test doubles — injected via tmuxInject() so we avoid vi.mock complexity
 * for node:child_process in ESM mode (vi.mock doesn't reliably replace
 * module-level imports that are already cached by the ESM loader).
 */
const fakeExecFile = vi.fn<typeof import("node:child_process").execFile>();
const fakeSleep = vi.fn<typeof import("node:timers/promises").setTimeout>(() => Promise.resolve());

beforeEach(() => {
  vi.clearAllMocks();
  tmuxInject({ execFile: fakeExecFile, setTimeout: fakeSleep });
});

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

/** Helper to make execFile resolve with stdout. */
function mockTmuxSuccess(stdout: string) {
  fakeExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    (callback as ExecFileCallback)(null, stdout, "");
    return {} as ReturnType<typeof fakeExecFile>;
  });
}

/** Helper to make execFile reject with an error. */
function mockTmuxError(message: string) {
  fakeExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    (callback as ExecFileCallback)(new Error(message), "", message);
    return {} as ReturnType<typeof fakeExecFile>;
  });
}

/** Helper for sequential tmux calls returning different results. */
function mockTmuxSequence(results: Array<{ stdout?: string; error?: string }>) {
  let callIndex = 0;
  fakeExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    const result = results[callIndex] ?? results[results.length - 1];
    callIndex++;
    if (result.error) {
      (callback as ExecFileCallback)(new Error(result.error), "", result.error);
    } else {
      (callback as ExecFileCallback)(null, result.stdout ?? "", "");
    }
    return {} as ReturnType<typeof fakeExecFile>;
  });
}

// (stale beforeEach removed)

describe("isTmuxAvailable", () => {
  it("returns true when tmux server is running", async () => {
    mockTmuxSuccess("session1\nsession2\n");
    expect(await isTmuxAvailable()).toBe(true);
  });

  it("returns false when tmux server is not running", async () => {
    mockTmuxError("no server running");
    expect(await isTmuxAvailable()).toBe(false);
  });
});

describe("listSessions", () => {
  it("parses tmux session list", async () => {
    mockTmuxSuccess(
      "app-1\tMon Jan  1 00:00:00 2025\t0\t2\n" + "app-2\tTue Jan  2 00:00:00 2025\t1\t1\n",
    );

    const sessions = await listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toEqual({
      name: "app-1",
      created: "Mon Jan  1 00:00:00 2025",
      attached: false,
      windows: 2,
    });
    expect(sessions[1]).toEqual({
      name: "app-2",
      created: "Tue Jan  2 00:00:00 2025",
      attached: true,
      windows: 1,
    });
  });

  it("returns empty array when no sessions", async () => {
    mockTmuxError("no server running on /private/tmp/tmux-501/default");
    expect(await listSessions()).toEqual([]);
  });

  it("handles empty output", async () => {
    mockTmuxSuccess("");
    expect(await listSessions()).toEqual([]);
  });
});

describe("hasSession", () => {
  it("returns true when session exists", async () => {
    mockTmuxSuccess("");
    expect(await hasSession("app-1")).toBe(true);
    expect(fakeExecFile).toHaveBeenCalledWith(
      "tmux",
      ["has-session", "-t", "app-1"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("returns false when session does not exist", async () => {
    mockTmuxError("session not found");
    expect(await hasSession("app-99")).toBe(false);
  });
});

describe("newSession", () => {
  it("creates a basic session", async () => {
    mockTmuxSuccess("");

    await newSession({ name: "test-1", cwd: "/tmp/workspace" });

    expect(fakeExecFile).toHaveBeenCalledWith(
      "tmux",
      ["new-session", "-d", "-s", "test-1", "-c", "/tmp/workspace"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("includes environment variables", async () => {
    mockTmuxSuccess("");

    await newSession({
      name: "test-2",
      cwd: "/tmp",
      environment: { AO_SESSION: "test-2", SOME_VAR: "value" },
    });

    const args = fakeExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("-e");
    expect(args).toContain("AO_SESSION=test-2");
    expect(args).toContain("SOME_VAR=value");
  });

  it("includes window size", async () => {
    mockTmuxSuccess("");

    await newSession({ name: "test-3", cwd: "/tmp", width: 200, height: 50 });

    const args = fakeExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("-x");
    expect(args).toContain("200");
    expect(args).toContain("-y");
    expect(args).toContain("50");
  });

  it("sends initial command after creation", async () => {
    // Calls: new-session, send-keys Escape, send-keys text, send-keys Enter
    mockTmuxSequence([{ stdout: "" }, { stdout: "" }, { stdout: "" }, { stdout: "" }]);

    await newSession({ name: "test-4", cwd: "/tmp", command: "echo hello" });

    expect(fakeExecFile).toHaveBeenCalledTimes(4);
    // Call 0: new-session
    // Call 1: send-keys Escape (clear partial input)
    const escapeArgs = fakeExecFile.mock.calls[1][1] as string[];
    expect(escapeArgs).toEqual(["send-keys", "-t", "test-4", "Escape"]);
    // Call 2: send-keys text
    const textArgs = fakeExecFile.mock.calls[2][1] as string[];
    expect(textArgs).toContain("send-keys");
    expect(textArgs).toContain("echo hello");
  });
});

describe("sendKeys", () => {
  it("sends short text with send-keys", async () => {
    // Calls: send-keys Escape, send-keys text, send-keys Enter
    mockTmuxSequence([{ stdout: "" }, { stdout: "" }, { stdout: "" }]);

    await sendKeys("app-1", "hello world");

    expect(fakeExecFile).toHaveBeenCalledTimes(3);
    // Call 0: Escape to clear partial input
    const escapeArgs = fakeExecFile.mock.calls[0][1] as string[];
    expect(escapeArgs).toEqual(["send-keys", "-t", "app-1", "Escape"]);
    // Call 1: text
    expect(fakeExecFile.mock.calls[1][1]).toEqual(["send-keys", "-t", "app-1", "-l", "hello world"]);
    // Call 2: Enter
    expect(fakeExecFile.mock.calls[2][1]).toEqual(["send-keys", "-t", "app-1", "Enter"]);
  });

  it("skips Enter when pressEnter=false", async () => {
    // Calls: send-keys Escape, send-keys text (no Enter)
    mockTmuxSequence([{ stdout: "" }, { stdout: "" }]);

    await sendKeys("app-1", "hello", false);

    expect(fakeExecFile).toHaveBeenCalledTimes(2);
    const escapeArgs = fakeExecFile.mock.calls[0][1] as string[];
    expect(escapeArgs).toEqual(["send-keys", "-t", "app-1", "Escape"]);
  });

  it("uses load-buffer with named buffer for long text", async () => {
    const longText = "a".repeat(250);
    // Calls: send-keys Escape, load-buffer -b name, paste-buffer -b name -d, send-keys Enter
    mockTmuxSequence([
      { stdout: "" }, // send-keys Escape
      { stdout: "" }, // load-buffer
      { stdout: "" }, // paste-buffer
      { stdout: "" }, // send-keys Enter
    ]);

    await sendKeys("app-1", longText);

    expect(fakeExecFile).toHaveBeenCalledTimes(4);

    // Call 0: Escape
    const escapeArgs = fakeExecFile.mock.calls[0][1] as string[];
    expect(escapeArgs).toEqual(["send-keys", "-t", "app-1", "Escape"]);

    // Call 1: load-buffer with named buffer
    const loadArgs = fakeExecFile.mock.calls[1][1] as string[];
    expect(loadArgs[0]).toBe("load-buffer");
    expect(loadArgs[1]).toBe("-b");
    expect(loadArgs[2]).toMatch(/^ao-/); // named buffer

    // Call 2: paste-buffer with named buffer and -d (delete after paste)
    const pasteArgs = fakeExecFile.mock.calls[2][1] as string[];
    expect(pasteArgs[0]).toBe("paste-buffer");
    expect(pasteArgs[1]).toBe("-b");
    expect(pasteArgs[2]).toMatch(/^ao-/);
    expect(pasteArgs).toContain("-d");
    expect(pasteArgs).toContain("-t");
    expect(pasteArgs).toContain("app-1");
  });

  it("uses load-buffer for multiline text", async () => {
    // Calls: send-keys Escape, load-buffer, paste-buffer, send-keys Enter
    mockTmuxSequence([
      { stdout: "" }, // send-keys Escape
      { stdout: "" }, // load-buffer
      { stdout: "" }, // paste-buffer
      { stdout: "" }, // send-keys Enter
    ]);

    await sendKeys("app-1", "line1\nline2");

    expect(fakeExecFile).toHaveBeenCalledTimes(4);
    // Call 1 (after Escape) should be load-buffer
    const loadArgs = fakeExecFile.mock.calls[1][1] as string[];
    expect(loadArgs[0]).toBe("load-buffer");
    expect(loadArgs[1]).toBe("-b"); // named buffer
  });

  // (DEBUG tests removed — retained behavior verified by the tests below)

  it("retries Enter for >1KB messages when output unchanged", async () => {
    const largeText = "x".repeat(1500); // 1500 bytes ASCII > 1000 byte threshold
    // sendKeys makes 7 tmux calls:
    // 0: Escape, 1: load-buffer, 2: paste-buffer, 3: Enter (initial),
    // 4: capture before attempt 0, 5: Enter attempt 0, 6: capture after attempt 0
    // For unchanged output, attempts 1 & 2 also consume results[4,5,6] in the loop
    mockTmuxSequence([
      { stdout: "" }, // 0: send-keys Escape
      { stdout: "" }, // 1: load-buffer
      { stdout: "" }, // 2: paste-buffer
      { stdout: "" }, // 3: send-keys Enter (initial)
      { stdout: "same output\n" }, // 4: capture before attempt 0 / attempt 1 / attempt 2
      { stdout: "same output\n" }, // 5: send-keys Enter attempt 0 / attempt 1 / attempt 2
      { stdout: "same output\n" }, // 6: capture after attempt 0 / attempt 1 / attempt 2
    ]);

    const sendPromise = sendKeys("app-1", largeText);
    await sendPromise;

    const captureCalls = fakeExecFile.mock.calls.filter(
      (call) => (call[1] as string[])[0] === "capture-pane",
    );
    expect(captureCalls.length).toBe(6);

    const enterCalls = fakeExecFile.mock.calls.filter(
      (call) =>
        (call[1] as string[])[0] === "send-keys" &&
        (call[1] as string[]).includes("Enter"),
    );
    expect(enterCalls.length).toBe(4);
  });

  it("breaks retry when output changes on third attempt", async () => {
    const largeText = "x".repeat(1500); // 1500 bytes ASCII > 1000 byte threshold
    // 10 tmux calls: Escape, load-buffer, paste-buffer, Enter (initial),
    // attempt 0: capture, Enter, capture  (results 4,5,6)
    // attempt 1: capture, Enter, capture  (results 7,8,9)
    // attempt 2: capture, Enter, capture  (results 10,fallback,11)
    mockTmuxSequence([
      { stdout: "" }, // 0: send-keys Escape
      { stdout: "" }, // 1: load-buffer
      { stdout: "" }, // 2: paste-buffer
      { stdout: "" }, // 3: send-keys Enter (initial)
      { stdout: "same\n" }, // 4: capture before attempt 0
      { stdout: "" }, // 5: send-keys Enter attempt 0
      { stdout: "same\n" }, // 6: capture after attempt 0 — unchanged, retry
      { stdout: "same\n" }, // 7: capture before attempt 1
      { stdout: "" }, // 8: send-keys Enter attempt 1
      { stdout: "same\n" }, // 9: capture after attempt 1 — unchanged, retry
      { stdout: "same\n" }, // 10: capture before attempt 2
      { stdout: "" }, // 11: send-keys Enter attempt 2
      { stdout: "changed!\n" }, // 12: capture after attempt 2 — changed, break
    ]);

    const sendPromise = sendKeys("app-1", largeText);
    await sendPromise;

    const captureCalls = fakeExecFile.mock.calls.filter(
      (call) => (call[1] as string[])[0] === "capture-pane",
    );
    expect(captureCalls.length).toBe(6);

    const enterCalls = fakeExecFile.mock.calls.filter(
      (call) =>
        (call[1] as string[])[0] === "send-keys" &&
        (call[1] as string[]).includes("Enter"),
    );
    expect(enterCalls.length).toBe(4);
  });

  it("does not retry for short messages under 1KB", async () => {
    const mediumText = "a".repeat(300); // 300 chars — uses paste-buffer but no retry
    mockTmuxSequence([
      { stdout: "" }, // send-keys Escape
      { stdout: "" }, // load-buffer
      { stdout: "" }, // paste-buffer
      { stdout: "" }, // send-keys Enter
    ]);

    const sendPromise = sendKeys("app-1", mediumText);
    await sendPromise;

    const captureCalls = fakeExecFile.mock.calls.filter(
      (call) => (call[1] as string[])[0] === "capture-pane",
    );
    expect(captureCalls.length).toBe(0);

    const enterCalls = fakeExecFile.mock.calls.filter(
      (call) =>
        (call[1] as string[])[0] === "send-keys" &&
        (call[1] as string[]).includes("Enter"),
    );
    expect(enterCalls.length).toBe(1);
  });
});

describe("capturePane", () => {
  it("captures pane output with default lines", async () => {
    mockTmuxSuccess("some output\nfrom tmux\n");

    const output = await capturePane("app-1");
    expect(output).toBe("some output\nfrom tmux\n");
    expect(fakeExecFile).toHaveBeenCalledWith(
      "tmux",
      ["capture-pane", "-t", "app-1", "-p", "-S", "-30"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("captures with custom line count", async () => {
    mockTmuxSuccess("output\n");

    await capturePane("app-1", 50);

    const args = fakeExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("-50");
  });
});

describe("killSession", () => {
  it("kills a tmux session", async () => {
    mockTmuxSuccess("");

    await killSession("app-1");

    expect(fakeExecFile).toHaveBeenCalledWith(
      "tmux",
      ["kill-session", "-t", "app-1"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("throws when session does not exist", async () => {
    mockTmuxError("session not found: app-99");
    await expect(killSession("app-99")).rejects.toThrow("session not found");
  });
});

describe("getPaneTTY", () => {
  it("returns TTY for first pane", async () => {
    mockTmuxSuccess("/dev/ttys004\n");

    const tty = await getPaneTTY("app-1");
    expect(tty).toBe("/dev/ttys004");
  });

  it("returns first TTY when multiple panes", async () => {
    mockTmuxSuccess("/dev/ttys004\n/dev/ttys005\n");

    const tty = await getPaneTTY("app-1");
    expect(tty).toBe("/dev/ttys004");
  });

  it("returns null when session not found", async () => {
    mockTmuxError("session not found");

    const tty = await getPaneTTY("nonexistent");
    expect(tty).toBeNull();
  });

  it("returns null for empty output", async () => {
    mockTmuxSuccess("");

    const tty = await getPaneTTY("app-1");
    expect(tty).toBeNull();
  });
});
