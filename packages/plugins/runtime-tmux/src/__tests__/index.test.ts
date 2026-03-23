import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import type { RuntimeHandle } from "@jleechanorg/ao-core";

// Mock node:child_process with custom promisify support
vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  // promisify(execFile) checks for a custom promisify symbol. Set it so
  // await execFileAsync(...) returns { stdout, stderr } properly.
  (mockExecFile as any)[Symbol.for("nodejs.util.promisify.custom")] = vi.fn();
  return { execFile: mockExecFile };
});

// Mock node:crypto for deterministic UUIDs
vi.mock("node:crypto", () => ({
  randomUUID: () => "test-uuid-1234",
}));

// Mock node:fs for writeFileSync / unlinkSync
vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Mock node:timers/promises so sleep() calls resolve immediately in tests
vi.mock("node:timers/promises", () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

// Get reference to the promisify-custom mock — this is what the plugin actually calls
const mockExecFileCustom = (childProcess.execFile as any)[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;
const expectedTmuxOptions = { timeout: 5_000 };

/** Queue a successful tmux command with the given stdout. */
function mockTmuxSuccess(stdout = "") {
  mockExecFileCustom.mockResolvedValueOnce({ stdout: stdout + "\n", stderr: "" });
}

/** Queue a failed tmux command. */
function mockTmuxError(message: string) {
  mockExecFileCustom.mockRejectedValueOnce(new Error(message));
}

/** Create a RuntimeHandle for testing (bd-tln: includes launchCommand). */
function makeHandle(id: string, createdAt?: number, launchCommand?: string): RuntimeHandle {
  return {
    id,
    runtimeName: "tmux",
    data: {
      createdAt: createdAt ?? 1000,
      workspacePath: "/tmp/workspace",
      // launchCommand stored for restartAgentCli (bd-tln)
      launchCommand: launchCommand ?? "claude --session test",
    },
  };
}

// Import after mocks are set up
import tmuxPlugin, { manifest, create, isAgentAliveInPane, restartAgentCli } from "../index.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("manifest", () => {
  it("has name 'tmux' and slot 'runtime'", () => {
    expect(manifest.name).toBe("tmux");
    expect(manifest.slot).toBe("runtime");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe("Runtime plugin: tmux sessions");
  });

  it("default export includes manifest and create", () => {
    expect(tmuxPlugin.manifest).toBe(manifest);
    expect(tmuxPlugin.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns a Runtime with name 'tmux'", () => {
    const runtime = create();
    expect(runtime.name).toBe("tmux");
  });
});

describe("runtime.create()", () => {
  it("calls new-session with correct args", async () => {
    const runtime = create();

    // 1: new-session, 2: send-keys (launch command)
    mockTmuxSuccess();
    mockTmuxSuccess();

    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "echo hello",
      environment: {},
    });

    expect(handle.id).toBe("test-session");
    expect(handle.runtimeName).toBe("tmux");
    expect(handle.data.workspacePath).toBe("/tmp/workspace");

    // First call: new-session
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      ["new-session", "-d", "-s", "test-session", "-c", "/tmp/workspace"],
      expectedTmuxOptions,
    );
  });

  it("stores launchCommand in handle.data for restart capability (bd-tln)", async () => {
    const runtime = create();

    mockTmuxSuccess();
    mockTmuxSuccess();

    const handle = await runtime.create({
      sessionId: "launch-store-test",
      workspacePath: "/tmp/workspace",
      launchCommand: "claude --session abc",
      environment: {},
    });

    expect(handle.data.launchCommand).toBe("claude --session abc");
  });

  it("includes -e KEY=VALUE flags for environment variables", async () => {
    const runtime = create();

    mockTmuxSuccess();
    mockTmuxSuccess();

    await runtime.create({
      sessionId: "env-session",
      workspacePath: "/tmp/ws",
      launchCommand: "bash",
      environment: { AO_SESSION: "env-session", FOO: "bar" },
    });

    // First call: new-session with env args
    const firstCallArgs = mockExecFileCustom.mock.calls[0];
    const args = firstCallArgs[1] as string[];
    expect(args).toContain("-e");
    expect(args).toContain("AO_SESSION=env-session");
    expect(args).toContain("FOO=bar");
  });

  it("sends launch command via send-keys", async () => {
    const runtime = create();

    mockTmuxSuccess();
    mockTmuxSuccess();

    await runtime.create({
      sessionId: "launch-test",
      workspacePath: "/tmp/ws",
      launchCommand: "claude --session abc",
      environment: {},
    });

    // Second call: send-keys with the launch command
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      ["send-keys", "-t", "launch-test", "claude --session abc", "Enter"],
      expectedTmuxOptions,
    );
  });

  it("cleans up session if send-keys fails", async () => {
    const runtime = create();

    // 1: new-session succeeds
    mockTmuxSuccess();
    // 2: send-keys fails
    mockTmuxError("send-keys failed");
    // 3: kill-session (cleanup attempt)
    mockTmuxSuccess();

    await expect(
      runtime.create({
        sessionId: "fail-session",
        workspacePath: "/tmp/ws",
        launchCommand: "bad-command",
        environment: {},
      }),
    ).rejects.toThrow('Failed to send launch command to session "fail-session"');

    // Verify kill-session was called for cleanup
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      ["kill-session", "-t", "fail-session"],
      expectedTmuxOptions,
    );
  });

  it("rejects invalid session IDs with special characters", async () => {
    const runtime = create();

    await expect(
      runtime.create({
        sessionId: "bad session!",
        workspacePath: "/tmp/ws",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow('Invalid session ID "bad session!"');
  });

  it("rejects session IDs with dots", async () => {
    const runtime = create();

    await expect(
      runtime.create({
        sessionId: "bad.session",
        workspacePath: "/tmp/ws",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("Invalid session ID");
  });

  it("accepts valid session IDs with hyphens and underscores", async () => {
    const runtime = create();

    mockTmuxSuccess();
    mockTmuxSuccess();

    const handle = await runtime.create({
      sessionId: "valid-session_123",
      workspacePath: "/tmp/ws",
      launchCommand: "echo",
      environment: {},
    });

    expect(handle.id).toBe("valid-session_123");
  });

  it("handles no environment (undefined)", async () => {
    const runtime = create();

    mockTmuxSuccess();
    mockTmuxSuccess();

    await runtime.create({
      sessionId: "no-env",
      workspacePath: "/tmp/ws",
      launchCommand: "echo hi",
    } as any);

    // First call should not contain -e flags
    const firstCallArgs = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(firstCallArgs).toEqual(["new-session", "-d", "-s", "no-env", "-c", "/tmp/ws"]);
  });
});

describe("runtime.destroy()", () => {
  it("calls kill-session with the handle id", async () => {
    const runtime = create();
    const handle = makeHandle("destroy-test");

    mockTmuxSuccess();

    await runtime.destroy(handle);

    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      ["kill-session", "-t", "destroy-test"],
      expectedTmuxOptions,
    );
  });

  it("does not throw if session is already gone", async () => {
    const runtime = create();
    const handle = makeHandle("already-dead");

    mockTmuxError("session not found: already-dead");

    // Should not throw
    await expect(runtime.destroy(handle)).resolves.toBeUndefined();
  });
});

describe("runtime.sendMessage()", () => {
  // Helper to build the full mock sequence for sendMessage.
  //
  // sendMessage call sequence:
  //   Pre-flight:  capture-pane (isAgentAliveInPane pre-check)
  //   Step 1:      send-keys C-u
  //   Step 2a/b:   send-keys -l <text>  OR  load-buffer + paste-buffer + delete-buffer
  //   Step 3:      send-keys Enter
  //   Enter retry: capture-pane×N for ALL messages (short + long) until agent responds
  //   Post-send:   capture-pane (isAgentAliveInPane post-check, +500ms/2s sleep)

  it("sends short text with send-keys -l (literal) + Enter", async () => {
    const runtime = create();
    const handle = makeHandle("msg-short");

    // Pre-flight isAgentAliveInPane → returns non-prompt output (agent alive)
    mockTmuxSuccess("✻ Claude is thinking");
    // C-u, send-keys -l, Enter
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    // Enter-retry: agent is alive (✻) → didAgentStart=true → break immediately
    mockTmuxSuccess("✻ still working");
    // Post-send isAgentAliveInPane
    mockTmuxSuccess("✻ still working");

    await runtime.sendMessage(handle, "hello world");

    // 6 calls total: capture-pane(pre), C-u, send-keys -l, Enter, capture-pane(retry), capture-pane(post)
    expect(mockExecFileCustom).toHaveBeenCalledTimes(6);

    // Call 1: pre-flight capture-pane
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      1,
      "tmux",
      ["capture-pane", "-t", "msg-short", "-p", "-S", "-30"],
      expectedTmuxOptions,
    );

    // Call 2: Clear partial input
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      2,
      "tmux",
      ["send-keys", "-t", "msg-short", "C-u"],
      expectedTmuxOptions,
    );

    // Call 3: Literal text
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      3,
      "tmux",
      ["send-keys", "-t", "msg-short", "-l", "hello world"],
      expectedTmuxOptions,
    );

    // Call 4: Enter
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      4,
      "tmux",
      ["send-keys", "-t", "msg-short", "Enter"],
      expectedTmuxOptions,
    );

    // Call 5: Enter-retry capture-pane (agent alive → breaks immediately)
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      5,
      "tmux",
      ["capture-pane", "-t", "msg-short", "-p", "-S", "-20"],
      expectedTmuxOptions,
    );

    // Call 6: post-send capture-pane
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      6,
      "tmux",
      ["capture-pane", "-t", "msg-short", "-p", "-S", "-30"],
      expectedTmuxOptions,
    );
  });

  it("retries Enter for short messages when pane unchanged (swallowed Enter)", async () => {
    const runtime = create();
    const handle = makeHandle("msg-short-retry");

    // Pre-flight: agent alive
    mockTmuxSuccess("✻ thinking");
    // C-u, send-keys -l, Enter (first attempt)
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    // Enter-retry 1: pane still shows short message (no change) → retry
    mockTmuxSuccess("hello world");
    // Enter retry 1
    mockTmuxSuccess();
    // Enter-retry 2: agent started responding
    mockTmuxSuccess("✻ working");
    // Post-send isAgentAliveInPane
    mockTmuxSuccess("✻ still working");

    await runtime.sendMessage(handle, "hello world");

    // 8 calls: pre-capture, C-u, send-keys -l, Enter, retry-capture(unchanged)→Enter, retry-capture(alive)→break, post-capture
    expect(mockExecFileCustom).toHaveBeenCalledTimes(8);
    const allCalls = mockExecFileCustom.mock.calls.map((c) => c[1] as string[]);
    const enterCalls = allCalls.filter(
      (args) => args[0] === "send-keys" && args[args.length - 1] === "Enter",
    );
    // 1 initial + 1 retry = 2 total Enter sends
    expect(enterCalls).toHaveLength(2);
    const retryCaptureCalls = allCalls.filter(
      (args) => args[0] === "capture-pane" && args.includes("-20"),
    );
    // 2 retry capture-pane checks
    expect(retryCaptureCalls).toHaveLength(2);
  });

  it("uses load-buffer + paste-buffer for long text (> 200 chars)", async () => {
    const runtime = create();
    const handle = makeHandle("msg-long");
    const longText = "x".repeat(250);

    // Pre-flight: agent alive
    mockTmuxSuccess("✻ working");
    // C-u, load-buffer, paste-buffer, delete-buffer (finally)
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    // Enter
    mockTmuxSuccess();
    // Enter-retry capture-pane: agent started (output doesn't end with message tail)
    mockTmuxSuccess("agent is responding now");
    // Post-send isAgentAliveInPane
    mockTmuxSuccess("✻ working");

    await runtime.sendMessage(handle, longText);

    // 8 calls: pre-capture, C-u, load-buffer, paste-buffer, delete-buffer, Enter,
    //          retry-capture, post-capture
    expect(mockExecFileCustom).toHaveBeenCalledTimes(8);

    // Call 2: C-u
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      2,
      "tmux",
      ["send-keys", "-t", "msg-long", "C-u"],
      expectedTmuxOptions,
    );

    // Call 3: load-buffer with named buffer
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      3,
      "tmux",
      [
        "load-buffer",
        "-b",
        "ao-test-uuid-1234",
        expect.stringContaining("ao-send-test-uuid-1234.txt"),
      ],
      expectedTmuxOptions,
    );

    // Call 4: paste-buffer
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      4,
      "tmux",
      ["paste-buffer", "-b", "ao-test-uuid-1234", "-t", "msg-long", "-d"],
      expectedTmuxOptions,
    );

    // Call 6: Enter
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      6,
      "tmux",
      ["send-keys", "-t", "msg-long", "Enter"],
      expectedTmuxOptions,
    );

    // Call 7: capture-pane for Enter retry check (20 lines)
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      7,
      "tmux",
      ["capture-pane", "-t", "msg-long", "-p", "-S", "-20"],
      expectedTmuxOptions,
    );

    // Verify writeFileSync and unlinkSync were called
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("ao-send-test-uuid-1234.txt"),
      longText,
      { encoding: "utf-8", mode: 0o600 },
    );
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      expect.stringContaining("ao-send-test-uuid-1234.txt"),
    );
  });

  it("retries Enter when pane still ends with message tail (swallowed Enter)", async () => {

    const runtime = create();
    const handle = makeHandle("msg-retry");
    const longText = "x".repeat(250);
    const messageTail = longText.slice(-80).trim();

    // Pre-flight: alive
    mockTmuxSuccess("✻ working");
    // C-u, load-buffer, paste-buffer, delete-buffer
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    // Enter (first attempt)
    mockTmuxSuccess();
    // retry capture attempt 1: pane still ends with message tail → retry
    mockTmuxSuccess(messageTail);
    // Enter retry 1
    mockTmuxSuccess();
    // retry capture attempt 2: agent started responding
    mockTmuxSuccess("agent response ✻ working");
    // Post-send isAgentAliveInPane
    mockTmuxSuccess("✻ still working");


    await runtime.sendMessage(handle, longText);





    const allCalls = mockExecFileCustom.mock.calls.map((c: unknown[]) => (c[1] as string[]));
    const enterCalls = allCalls.filter(
      (args: string[]) => args[0] === "send-keys" && args[args.length - 1] === "Enter",
    );
    // capture-pane with -S -20 = Enter-retry checks; -S -30 = isAgentAliveInPane checks
    const retryCaptureCalls = allCalls.filter(
      (args: string[]) => args[0] === "capture-pane" && args.includes("-20"),
    );

    // 1 initial Enter + 1 retry = 2 total Enter sends
    expect(enterCalls).toHaveLength(2);
    // 2 retry capture-pane checks
    expect(retryCaptureCalls).toHaveLength(2);
  });

  it("retries Enter up to 3 times if pane never changes", async () => {

    const runtime = create();
    const handle = makeHandle("msg-max-retry");
    const longText = "z".repeat(250);
    const messageTail = longText.slice(-80).trim();

    // Pre-flight: alive
    mockTmuxSuccess("✻ working");
    // C-u, load-buffer, paste-buffer, delete-buffer
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    // Enter (first attempt)
    mockTmuxSuccess();
    // All 3 retry capture-pane checks show stuck pane
    mockTmuxSuccess(messageTail); // retry capture 1
    mockTmuxSuccess(); // Enter retry 1
    mockTmuxSuccess(messageTail); // retry capture 2
    mockTmuxSuccess(); // Enter retry 2
    mockTmuxSuccess(messageTail); // retry capture 3
    mockTmuxSuccess(); // Enter retry 3
    // Post-send isAgentAliveInPane
    mockTmuxSuccess("✻ working now");

    await runtime.sendMessage(handle, longText);





    const allCalls = mockExecFileCustom.mock.calls.map((c: unknown[]) => (c[1] as string[]));
    const enterCalls = allCalls.filter(
      (args: string[]) => args[0] === "send-keys" && args[args.length - 1] === "Enter",
    );
    const retryCaptureCalls = allCalls.filter(
      (args: string[]) => args[0] === "capture-pane" && args.includes("-20"),
    );

    // 1 initial Enter + 3 retries = 4 total
    expect(enterCalls).toHaveLength(4);
    // 3 retry capture-pane checks
    expect(retryCaptureCalls).toHaveLength(3);
  });

  it("uses load-buffer for multiline text", async () => {
    const runtime = create();
    const handle = makeHandle("msg-multi");

    // Pre-flight: alive
    mockTmuxSuccess("✻ working");
    // C-u, load-buffer, paste-buffer, delete-buffer
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    // Enter
    mockTmuxSuccess();
    // Enter-retry capture-pane: agent started (output doesn't end with message tail)
    mockTmuxSuccess("agent started responding");
    // Post-send isAgentAliveInPane
    mockTmuxSuccess("✻ working");

    await runtime.sendMessage(handle, "line1\nline2\nline3");

    // Should use buffer path, not send-keys -l
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      3,
      "tmux",
      [
        "load-buffer",
        "-b",
        "ao-test-uuid-1234",
        expect.stringContaining("ao-send-test-uuid-1234.txt"),
      ],
      expectedTmuxOptions,
    );

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("ao-send-test-uuid-1234.txt"),
      "line1\nline2\nline3",
      { encoding: "utf-8", mode: 0o600 },
    );
  });

  it("cleans up buffer and temp file on paste failure", async () => {
    const runtime = create();
    const handle = makeHandle("msg-fail");
    const longText = "y".repeat(250);

    // Pre-flight: alive
    mockTmuxSuccess("✻ working");
    // C-u
    mockTmuxSuccess();
    // load-buffer succeeds
    mockTmuxSuccess();
    // paste-buffer fails
    mockTmuxError("paste-buffer failed");
    // finally block: delete-buffer
    mockTmuxSuccess();
    // Error propagates — no Enter call, no retry loop, no post-send check

    await expect(runtime.sendMessage(handle, longText)).rejects.toThrow("paste-buffer failed");

    // unlinkSync should still be called for temp file cleanup
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      expect.stringContaining("ao-send-test-uuid-1234.txt"),
    );

    // delete-buffer should be called in finally block
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      ["delete-buffer", "-b", "ao-test-uuid-1234"],
      expectedTmuxOptions,
    );
  });
});

describe("runtime.getOutput()", () => {
  it("calls capture-pane with correct args and default lines", async () => {
    const runtime = create();
    const handle = makeHandle("output-test");

    mockTmuxSuccess("some output\nfrom tmux");

    const output = await runtime.getOutput(handle);

    expect(output).toBe("some output\nfrom tmux");
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      ["capture-pane", "-t", "output-test", "-p", "-S", "-50"],
      expectedTmuxOptions,
    );
  });

  it("passes custom line count", async () => {
    const runtime = create();
    const handle = makeHandle("output-custom");

    mockTmuxSuccess("output");

    await runtime.getOutput(handle, 100);

    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      ["capture-pane", "-t", "output-custom", "-p", "-S", "-100"],
      expectedTmuxOptions,
    );
  });

  it("returns empty string on error", async () => {
    const runtime = create();
    const handle = makeHandle("output-err");

    mockTmuxError("session not found");

    const output = await runtime.getOutput(handle);

    expect(output).toBe("");
  });
});

describe("runtime.isAlive()", () => {
  it("returns true when has-session succeeds", async () => {
    const runtime = create();
    const handle = makeHandle("alive-test");

    mockTmuxSuccess();

    const alive = await runtime.isAlive(handle);

    expect(alive).toBe(true);
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      ["has-session", "-t", "alive-test"],
      expectedTmuxOptions,
    );
  });

  it("returns false when has-session fails", async () => {
    const runtime = create();
    const handle = makeHandle("dead-test");

    mockTmuxError("session not found");

    const alive = await runtime.isAlive(handle);

    expect(alive).toBe(false);
  });
});

describe("runtime.getMetrics()", () => {
  it("returns uptimeMs based on createdAt", async () => {
    const runtime = create();
    const now = Date.now();
    const handle = makeHandle("metrics-test", now - 5000);

    const metrics = await runtime.getMetrics!(handle);

    // uptimeMs should be approximately 5000ms (allow some wiggle room)
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(5000);
    expect(metrics.uptimeMs).toBeLessThan(6000);
  });

  it("handles missing createdAt by using Date.now()", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "metrics-no-created",
      runtimeName: "tmux",
      data: {},
    };

    const metrics = await runtime.getMetrics!(handle);

    // uptimeMs should be very close to 0 since createdAt defaults to Date.now()
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.uptimeMs).toBeLessThan(1000);
  });
});

describe("runtime.getAttachInfo()", () => {
  it("returns tmux type and attach command", async () => {
    const runtime = create();
    const handle = makeHandle("attach-test");

    const info = await runtime.getAttachInfo!(handle);

    expect(info).toEqual({
      type: "tmux",
      target: "attach-test",
      command: "tmux attach -t attach-test",
    });
  });
});

// =============================================================================
// isAgentAliveInPane — dead-agent detection (bd-tln)
// =============================================================================

describe("isAgentAliveInPane() — dead-agent detection (bd-tln)", () => {
  it("returns false when pane ends with bash $ prompt", async () => {
    mockTmuxSuccess("some output\n/workspace $");
    const alive = await isAgentAliveInPane("test-session");
    expect(alive).toBe(false);
  });

  it("returns false when pane ends with zsh % prompt", async () => {
    mockTmuxSuccess("some output\nuser@host %");
    const alive = await isAgentAliveInPane("test-session");
    expect(alive).toBe(false);
  });

  it("returns false when pane ends with starship ❯ prompt", async () => {
    mockTmuxSuccess("some output\n❯");
    const alive = await isAgentAliveInPane("test-session");
    expect(alive).toBe(false);
  });

  it("returns false when pane ends with root # prompt", async () => {
    mockTmuxSuccess("root output\nroot@container #");
    const alive = await isAgentAliveInPane("test-session");
    expect(alive).toBe(false);
  });

  it("returns true when pane contains Claude ✻ thinking indicator", async () => {
    mockTmuxSuccess("✻ Thinking...\nSome reasoning");
    const alive = await isAgentAliveInPane("test-session");
    expect(alive).toBe(true);
  });

  it("returns true when pane contains ● progress indicator", async () => {
    mockTmuxSuccess("● Running tool: read_file\npath: /tmp/foo");
    const alive = await isAgentAliveInPane("test-session");
    expect(alive).toBe(true);
  });

  it("returns true when pane contains ◆ tool indicator", async () => {
    mockTmuxSuccess("◆ Tool result\nsome output here");
    const alive = await isAgentAliveInPane("test-session");
    expect(alive).toBe(true);
  });

  it("returns true when pane contains braille spinner (codex)", async () => {
    mockTmuxSuccess("⠋ Processing...");
    const alive = await isAgentAliveInPane("test-session");
    expect(alive).toBe(true);
  });

  it("returns true when pane contains Thinking... text", async () => {
    mockTmuxSuccess("Thinking...\nsome content");
    const alive = await isAgentAliveInPane("test-session");
    expect(alive).toBe(true);
  });

  it("returns true when pane has no conclusive indicator (conservative default)", async () => {
    mockTmuxSuccess("some random output line\nwithout a clear indicator");
    const alive = await isAgentAliveInPane("test-session");
    expect(alive).toBe(true);
  });

  it("returns false when capture-pane fails (session dead)", async () => {
    mockTmuxError("no session found");
    const alive = await isAgentAliveInPane("test-session");
    expect(alive).toBe(false);
  });

  it("returns true when pane is empty (conservative default)", async () => {
    mockTmuxSuccess("");
    const alive = await isAgentAliveInPane("test-session");
    expect(alive).toBe(true);
  });

  it("calls capture-pane with -30 line window", async () => {
    mockTmuxSuccess("output");
    await isAgentAliveInPane("my-session");
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      ["capture-pane", "-t", "my-session", "-p", "-S", "-30"],
      expectedTmuxOptions,
    );
  });

  it("returns false when last line is shell prompt even if stale ✻ Thinking appears in history (detection order)", async () => {
    // Critical: stale spinner in history must NOT mask a dead agent at the prompt.
    // Shell prompt check must happen BEFORE alive-token check.
    const paneWithStaleSpinner = [
      "✻ Thinking...",
      "Some earlier reasoning output",
      "Process exited with code 1",
      "user@host /workspace $",
    ].join("\n");
    mockTmuxSuccess(paneWithStaleSpinner);
    const alive = await isAgentAliveInPane("test-session");
    expect(alive).toBe(false);
  });

  // Regression: mixed-window — spinner/tool line in older scrollback followed by
  // a shell prompt on the last line. The shell prompt takes precedence (agent dead),
  // but when the last line has NO shell prompt, spinner evidence is still checked
  // in the trailing 5-line window only (stale tokens don't mask a live agent).
  it("returns true when last line has no shell prompt but recent window shows spinner", async () => {
    // Last line is NOT a shell prompt — no spinner in last 5 lines → dead
    mockTmuxSuccess("Loading workspace\nDone\n/workspace: repo-main");
    const alive = await isAgentAliveInPane("test-session");
    expect(alive).toBe(true); // no shell prompt, no conclusive evidence → conservative true
  });

  it("returns true when spinner appears in last 5 lines (recent activity)", async () => {
    // Spinner in last 5 non-empty lines, no shell prompt on last line
    mockTmuxSuccess("Loading\n✻ Thinking...\n/workspace: repo-main");
    const alive = await isAgentAliveInPane("test-session");
    expect(alive).toBe(true);
  });
});

// =============================================================================
// restartAgentCli — dead-agent restart (bd-tln)
// =============================================================================

describe("restartAgentCli() — dead-agent restart (bd-tln)", () => {
  it("throws if launchCommand is not stored in handle.data", async () => {
    const handle: RuntimeHandle = {
      id: "no-launch-cmd",
      runtimeName: "tmux",
      data: { createdAt: 1000 },
    };

    await expect(restartAgentCli(handle)).rejects.toThrow(
      'Cannot restart agent CLI in session "no-launch-cmd": launchCommand not stored in handle.data',
    );
  });

  it("sends C-c twice, then re-launches the agent CLI (short command)", async () => {
    const handle = makeHandle("restart-test", 1000, "claude --session abc");

    mockTmuxSuccess(); // C-c #1
    mockTmuxSuccess(); // C-c #2
    mockTmuxSuccess(); // send-keys -l with launch command (literal)
    mockTmuxSuccess(); // send-keys Enter
    mockTmuxSuccess("✻ Thinking..."); // poll: alive indicator

    await restartAgentCli(handle);

    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      1,
      "tmux",
      ["send-keys", "-t", "restart-test", "C-c"],
      expectedTmuxOptions,
    );
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      2,
      "tmux",
      ["send-keys", "-t", "restart-test", "C-c"],
      expectedTmuxOptions,
    );
    // Short command now uses -l (literal) flag to avoid interpreting "Enter" as keypress
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      3,
      "tmux",
      ["send-keys", "-t", "restart-test", "-l", "claude --session abc"],
      expectedTmuxOptions,
    );
    // Separate Enter keypress
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      4,
      "tmux",
      ["send-keys", "-t", "restart-test", "Enter"],
      expectedTmuxOptions,
    );
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      5,
      "tmux",
      ["capture-pane", "-t", "restart-test", "-p", "-S", "-30"],
      expectedTmuxOptions,
    );
  });

  it("resolves on first poll if agent shows alive indicator immediately", async () => {
    const handle = makeHandle("restart-fast", 1000, "codex");

    mockTmuxSuccess(); // C-c #1
    mockTmuxSuccess(); // C-c #2
    mockTmuxSuccess(); // send-keys -l launch (literal)
    mockTmuxSuccess(); // send-keys Enter
    mockTmuxSuccess("● Running tool"); // first poll → alive

    await expect(restartAgentCli(handle)).resolves.toBeUndefined();

    const captureCalls = mockExecFileCustom.mock.calls.filter(
      (c: unknown[]) => (c[1] as string[])[0] === "capture-pane",
    );
    expect(captureCalls).toHaveLength(1);
  });

  it("throws after 6 polls if agent does not restart", async () => {
    const handle = makeHandle("restart-timeout", 1000, "claude");

    mockTmuxSuccess(); // C-c #1
    mockTmuxSuccess(); // C-c #2
    mockTmuxSuccess(); // send-keys -l launch (literal)
    mockTmuxSuccess(); // send-keys Enter

    for (let i = 0; i < 6; i++) {
      mockTmuxSuccess("/workspace $"); // all 6 polls return shell prompt
    }

    await expect(restartAgentCli(handle)).rejects.toThrow(
      'Agent CLI did not restart within 30s in session "restart-timeout"',
    );

    const captureCalls = mockExecFileCustom.mock.calls.filter(
      (c: unknown[]) => (c[1] as string[])[0] === "capture-pane",
    );
    expect(captureCalls).toHaveLength(6);
  });
});

// =============================================================================
// sendMessage — dead-agent restart integration (bd-tln)
// =============================================================================

describe("runtime.sendMessage() — dead-agent restart integration (bd-tln)", () => {
  it("restarts agent before sending when pre-send check detects dead agent", async () => {
    const runtime = create();
    const handle = makeHandle("msg-dead-pre", 1000, "claude --session test");

    // Pre-send alive check → dead (shell prompt)
    mockTmuxSuccess("/workspace $");

    // restartAgentCli: C-c, C-c, send-keys -l launch, send-keys Enter, poll → alive
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess(); // Enter for restart
    mockTmuxSuccess("✻ Thinking");

    // doSend after restart: C-u, send-keys -l, Enter
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    // Enter-retry: capture-pane → agent alive (✻) → break immediately
    mockTmuxSuccess("✻ Thinking");
    // Post-send alive check
    mockTmuxSuccess("✻ Thinking");

    await runtime.sendMessage(handle, "do the task");

    const allCalls = mockExecFileCustom.mock.calls.map((c: unknown[]) => c[1] as string[]);
    const cCalls = allCalls.filter(
      (args) => args[0] === "send-keys" && args[args.length - 1] === "C-c",
    );
    expect(cCalls.length).toBe(2);

    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      ["send-keys", "-t", "msg-dead-pre", "-l", "do the task"],
      expectedTmuxOptions,
    );
  });

  it("restarts agent and resends when post-send check detects dead agent", async () => {
    const runtime = create();
    const handle = makeHandle("msg-dead-post", 1000, "claude --session test");

    // Pre-flight alive check → alive
    mockTmuxSuccess("✻ Thinking");
    // doSend initial: C-u, sendContent (send-keys -l), Enter
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    // didAgentStart attempt 0: capture-pane → pane shows shell, ≠ sent msg → true → break
    mockTmuxSuccess("/workspace $");
    // sendMessage post-send isAgentAliveInPane → dead (shell prompt → false)
    mockTmuxSuccess("/workspace $");
    // restartAgentCli: C-c, C-c, send-keys -l launch, Enter, poll → alive
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess("✻ Thinking");
    // C-u before retry doSend
    mockTmuxSuccess();
    // doSend retry: sendContent (send-keys -l), Enter
    mockTmuxSuccess();
    mockTmuxSuccess();
    // didAgentStart attempt 0: capture-pane → alive (✻) → break
    mockTmuxSuccess("✻ Thinking");

    await runtime.sendMessage(handle, "important task");

    // Message sent twice (original + retry after restart)
    const sendKeysCalls = mockExecFileCustom.mock.calls.filter(
      (c: unknown[]) =>
        (c[1] as string[])[0] === "send-keys" &&
        (c[1] as string[]).includes("-l") &&
        (c[1] as string[]).includes("important task"),
    );
    expect(sendKeysCalls.length).toBe(2);
  });
});
