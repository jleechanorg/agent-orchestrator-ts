import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "node:child_process";
import {
  isTmuxAvailable,
  listSessions,
  hasSession,
  newSession,
  sendKeys,
  capturePane,
  killSession,
  getPaneTTY,
} from "../tmux.js";

// Mock child_process.execFile
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(childProcess.execFile);

/** Helper to make execFile resolve with stdout. */
function mockTmuxSuccess(stdout: string) {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    (callback as Function)(null, stdout, "");
    return {} as any;
  });
}

/** Helper to make execFile reject with an error. */
function mockTmuxError(message: string) {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    (callback as Function)(new Error(message), "", message);
    return {} as any;
  });
}

/** Helper for sequential tmux calls returning different results. */
function mockTmuxSequence(results: Array<{ stdout?: string; error?: string }>) {
  let callIndex = 0;
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    const result = results[callIndex] ?? results[results.length - 1];
    callIndex++;
    if (result.error) {
      (callback as Function)(new Error(result.error), "", result.error);
    } else {
      (callback as Function)(null, result.stdout ?? "", "");
    }
    return {} as any;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

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
      "app-1\tMon Jan  1 00:00:00 2025\t0\t2\n" +
      "app-2\tTue Jan  2 00:00:00 2025\t1\t1\n"
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
    expect(mockExecFile).toHaveBeenCalledWith(
      "tmux",
      ["has-session", "-t", "app-1"],
      expect.any(Object),
      expect.any(Function)
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

    expect(mockExecFile).toHaveBeenCalledWith(
      "tmux",
      ["new-session", "-d", "-s", "test-1", "-c", "/tmp/workspace"],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("includes environment variables", async () => {
    mockTmuxSuccess("");

    await newSession({
      name: "test-2",
      cwd: "/tmp",
      environment: { AO_SESSION: "test-2", SOME_VAR: "value" },
    });

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("-e");
    expect(args).toContain("AO_SESSION=test-2");
    expect(args).toContain("SOME_VAR=value");
  });

  it("includes window size", async () => {
    mockTmuxSuccess("");

    await newSession({ name: "test-3", cwd: "/tmp", width: 200, height: 50 });

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("-x");
    expect(args).toContain("200");
    expect(args).toContain("-y");
    expect(args).toContain("50");
  });

  it("sends initial command after creation", async () => {
    // First call: new-session, Second call: send-keys, Third call: send-keys Enter
    mockTmuxSequence([
      { stdout: "" },
      { stdout: "" },
      { stdout: "" },
    ]);

    await newSession({ name: "test-4", cwd: "/tmp", command: "echo hello" });

    // Should have called new-session then send-keys twice (text + Enter)
    expect(mockExecFile).toHaveBeenCalledTimes(3);
    const secondCallArgs = mockExecFile.mock.calls[1][1] as string[];
    expect(secondCallArgs).toContain("send-keys");
    expect(secondCallArgs).toContain("echo hello");
  });
});

describe("sendKeys", () => {
  it("sends short text with send-keys", async () => {
    mockTmuxSequence([{ stdout: "" }, { stdout: "" }]);

    await sendKeys("app-1", "hello world");

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    const firstArgs = mockExecFile.mock.calls[0][1] as string[];
    expect(firstArgs).toEqual(["send-keys", "-t", "app-1", "hello world"]);
    // Second call is Enter
    const secondArgs = mockExecFile.mock.calls[1][1] as string[];
    expect(secondArgs).toEqual(["send-keys", "-t", "app-1", "Enter"]);
  });

  it("skips Enter when pressEnter=false", async () => {
    mockTmuxSuccess("");

    await sendKeys("app-1", "hello", false);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("uses load-buffer for long text", async () => {
    const longText = "a".repeat(250);
    mockTmuxSequence([
      { stdout: "" }, // load-buffer
      { stdout: "" }, // paste-buffer
      { stdout: "" }, // send-keys Enter
    ]);

    await sendKeys("app-1", longText);

    const firstArgs = mockExecFile.mock.calls[0][1] as string[];
    expect(firstArgs[0]).toBe("load-buffer");

    const secondArgs = mockExecFile.mock.calls[1][1] as string[];
    expect(secondArgs).toEqual(["paste-buffer", "-t", "app-1"]);
  });

  it("uses load-buffer for multiline text", async () => {
    mockTmuxSequence([
      { stdout: "" }, // load-buffer
      { stdout: "" }, // paste-buffer
      { stdout: "" }, // send-keys Enter
    ]);

    await sendKeys("app-1", "line1\nline2");

    const firstArgs = mockExecFile.mock.calls[0][1] as string[];
    expect(firstArgs[0]).toBe("load-buffer");
  });
});

describe("capturePane", () => {
  it("captures pane output with default lines", async () => {
    mockTmuxSuccess("some output\nfrom tmux\n");

    const output = await capturePane("app-1");
    expect(output).toBe("some output\nfrom tmux\n");
    expect(mockExecFile).toHaveBeenCalledWith(
      "tmux",
      ["capture-pane", "-t", "app-1", "-p", "-S", "-30"],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("captures with custom line count", async () => {
    mockTmuxSuccess("output\n");

    await capturePane("app-1", 50);

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("-50");
  });
});

describe("killSession", () => {
  it("kills a tmux session", async () => {
    mockTmuxSuccess("");

    await killSession("app-1");

    expect(mockExecFile).toHaveBeenCalledWith(
      "tmux",
      ["kill-session", "-t", "app-1"],
      expect.any(Object),
      expect.any(Function)
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
