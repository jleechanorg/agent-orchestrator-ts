import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import type { RuntimeCreateConfig, RuntimeHandle } from "@jleechanorg/ao-core";

// Mock node:child_process (tmux calls go through execFile)
vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
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


/** Find the call whose args begin with the given tmux subcommand. */
function findCall(startsWith: string): unknown[] | undefined {
  return mockExecFileCustom.mock.calls.find(
    (c) => Array.isArray(c[1]) && c[1][0] === startsWith,
  );
}

/** Args of a tmux subcommand call (e.g. "new-session", "kill-session"). */
function argsOf(startsWith: string): string[] {
  const call = findCall(startsWith);
  if (!call) throw new Error(`no call found starting with ${startsWith}`);
  return call[1] as string[];
}

/** Content of the ao-launch-*.sh script written by writeLaunchScript(). */
function getScriptContent(): string {
  const writeCalls = (fs.writeFileSync as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  const launchCall = writeCalls.find(
    (c) => typeof c[0] === "string" && (c[0] as string).includes("ao-launch-"),
  );
  if (!launchCall) throw new Error("no launch script write found");
  return launchCall[1] as string;
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

    // Happy path (no collision): 0: new-session, 1: set-option status, 2: set-option allow-rename, 3: set-option automatic-rename
    mockTmuxSuccess();
    mockTmuxSuccess();
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

    // First tmux call: new-session — invokes a bash -i launch script so
    // guarded .bashrc files (case $- in *i*) guards) still load secrets.
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      [
        "new-session",
        "-d",
        "-s",
        "test-session",
        "-c",
        "/tmp/workspace",
        expect.stringMatching(/^bash -i '.*ao-launch-test-uuid-1234\.sh'$/),
      ],
      expectedTmuxOptions,
    );
    const scriptBody = getScriptContent();
    expect(scriptBody).toContain("echo hello");
    expect(scriptBody).toMatch(/\. "\$\{HOME\}\/\.bashrc" 2>\/dev\/null \|\| true/);
  });

  it("kills stale session and retries when new-session reports duplicate", async () => {
    const runtime = create();

    // 0: new-session → duplicate error, 1: kill-session, 2: new-session (retry), 3: set-option, 4-5: allow-rename/automatic-rename
    mockTmuxError("duplicate session: dup-session");
    mockTmuxSuccess(); // kill-session
    mockTmuxSuccess(); // new-session retry
    mockTmuxSuccess(); // set-option status
    mockTmuxSuccess(); // set-option allow-rename
    mockTmuxSuccess(); // set-option automatic-rename

    const handle = await runtime.create({
      sessionId: "dup-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "echo hello",
      environment: {},
    });

    expect(handle.id).toBe("dup-session");
    // 6 calls: new-session (fail), kill-session, new-session (retry), set-option status, allow-rename, automatic-rename
    expect(mockExecFileCustom).toHaveBeenCalledTimes(6);
    // Walk tmux calls in order.
    const tmuxSubcommands = mockExecFileCustom.mock.calls
      .map((c) => c[0] === "tmux" ? (c[1] as string[])[0] : null)
      .filter((sub): sub is string => sub !== null);
    expect(tmuxSubcommands[0]).toBe("new-session");
    expect(tmuxSubcommands[1]).toBe("kill-session");
    expect(tmuxSubcommands[2]).toBe("new-session");
  });

  it("propagates non-duplicate new-session errors without killing existing session", async () => {
    const runtime = create();

    // 0: new-session fails (not duplicate)
    mockTmuxError("permission denied");

    await expect(
      runtime.create({
        sessionId: "fail-session",
        workspacePath: "/tmp/workspace",
        launchCommand: "echo hello",
        environment: { SECRET_KEY: "mysecret" },
      }),
    ).rejects.toThrow("permission denied");

    // 1 call: new-session — no kill-session issued
    expect(mockExecFileCustom).toHaveBeenCalledTimes(1);

    // Launch script must be unlinked — rm -- "$0" never ran because tmux failed
    // before starting the script; secret values from environment must not linger on disk.
    const os = await import("node:os");
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`${os.tmpdir().replace(/\//g, "\\/")}.*ao-launch.*\\.sh`)),
    );
  });

  it("stores launchCommand in handle.data for restart capability (bd-tln)", async () => {
    const runtime = create();

    // 0: new-session, 1-3: set-option calls
    mockTmuxSuccess();
    mockTmuxSuccess();
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

  it("injects config.environment vars as inline exports before the launch command", async () => {
    const runtime = create();

    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();

    await runtime.create({
      sessionId: "env-session",
      workspacePath: "/tmp/ws",
      launchCommand: "bash",
      environment: { AO_SESSION: "env-session", FOO: "bar" },
    });

    const scriptBody = getScriptContent();
    expect(scriptBody).toContain("export AO_SESSION='env-session'");
    expect(scriptBody).toContain("export FOO='bar'");
    expect(argsOf("new-session")).not.toContain("-e");
    expect(scriptBody).toMatch(/exec "\$\{SHELL:-\/bin\/bash\}" -i/);
  });

  it("sends launch command via send-keys", async () => {
    const runtime = create();

    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();

    await runtime.create({
      sessionId: "launch-test",
      workspacePath: "/tmp/ws",
      launchCommand: "claude --session abc",
      environment: {},
    });

    // new-session passes a bash -i launch script; script contains preamble +
    // launch command + keep-alive shell tail.
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      [
        "new-session",
        "-d",
        "-s",
        "launch-test",
        "-c",
        "/tmp/ws",
        expect.stringMatching(/^bash -i '.*ao-launch-test-uuid-1234\.sh'$/),
      ],
      expectedTmuxOptions,
    );
    const scriptBody = getScriptContent();
    expect(scriptBody).toContain("claude --session abc");
  });

  it("appends an interactive shell tail so the tmux pane survives agent exit (regression for #1756)", async () => {
    const runtime = create();

    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();

    await runtime.create({
      sessionId: "keep-alive",
      workspacePath: "/tmp/ws",
      launchCommand: "claude --session abc",
      environment: {},
    });

    const finalArg = argsOf("new-session").at(-1)!;
    expect(finalArg).toMatch(/^bash -i '.*ao-launch-.+\.sh'$/);
    const scriptBody = getScriptContent();
    expect(scriptBody).toContain("claude --session abc");
    expect(scriptBody).toMatch(/exec "\$\{SHELL:-\/bin\/bash\}" -i/);
  });

  it("keeps the keep-alive tail in the temp script for long launch commands", async () => {
    const runtime = create();
    const longCommand = "x".repeat(250);

    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();

    await runtime.create({
      sessionId: "launch-long",
      workspacePath: "/tmp/ws",
      launchCommand: longCommand,
      environment: {},
    });

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("ao-launch-test-uuid-1234.sh"),
      expect.stringContaining(longCommand),
      { encoding: "utf-8", mode: 0o700 },
    );

    // The script body includes the interactive shell tail — without it
    // long-command sessions would still nuke tmux on agent exit (#1756).
    const scriptBody = getScriptContent();
    expect(scriptBody).toMatch(/exec "\$\{SHELL:-\/bin\/bash\}" -i/);

    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      [
        "new-session",
        "-d",
        "-s",
        "launch-long",
        "-c",
        "/tmp/ws",
        expect.stringMatching(/^bash -i '.*ao-launch-test-uuid-1234\.sh'$/),
      ],
      expectedTmuxOptions,
    );
  });

  it("surfaces tmux set-option failures and cleans up", async () => {
    const runtime = create();

    // 0: new-session succeeds, 1: set-option fails, 2: kill-session (cleanup)
    mockTmuxSuccess();
    mockTmuxError("set-option failed");
    mockTmuxSuccess();

    await expect(
      runtime.create({
        sessionId: "fail-session",
        workspacePath: "/tmp/ws",
        launchCommand: "bad-command",
        environment: {},
      }),
    ).rejects.toThrow('Failed to configure session "fail-session"');

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
    mockTmuxSuccess();
    mockTmuxSuccess();

    const noEnvConfig: RuntimeCreateConfig = {
      sessionId: "no-env",
      workspacePath: "/tmp/ws",
      launchCommand: "echo hi",
    };
    await runtime.create(noEnvConfig);

    // No -e flags; launches via bash -i script (preamble + command inside script)
    expect(argsOf("new-session")).toEqual([
      "new-session",
      "-d",
      "-s",
      "no-env",
      "-c",
      "/tmp/ws",
      expect.stringMatching(/^bash -i '.*ao-launch-test-uuid-1234\.sh'$/),
    ]);
    const scriptBody = getScriptContent();
    expect(scriptBody).toContain("echo hi");
    expect(scriptBody).toMatch(/\. "\$\{HOME\}\/\.bashrc" 2>\/dev\/null \|\| true/);
  });

  it("sets allow-rename and automatic-rename to off on create", async () => {
    const runtime = create();

    mockTmuxSuccess(); // new-session
    mockTmuxSuccess(); // set-option status off
    mockTmuxSuccess(); // set-option allow-rename off
    mockTmuxSuccess(); // set-option automatic-rename off

    await runtime.create({
      sessionId: "rename-test",
      workspacePath: "/tmp/ws",
      launchCommand: "echo",
      environment: {},
    });

    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      ["set-option", "-t", "rename-test", "allow-rename", "off"],
      expectedTmuxOptions,
    );
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      ["set-option", "-t", "rename-test", "automatic-rename", "off"],
      expectedTmuxOptions,
    );
  });
});

describe("runtime.create() — direct bashrc source", () => {
  it("launch script contains bashrc source preamble", async () => {
    const runtime = create();

    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();

    await runtime.create({
      sessionId: "preamble-test",
      workspacePath: "/tmp/ws",
      launchCommand: "echo hi",
      environment: {},
    });

    const shellCmd = argsOf("new-session").at(-1) as string;
    expect(shellCmd).toMatch(/^bash -i '.*ao-launch-.+\.sh'$/);
    const scriptBody = getScriptContent();
    expect(scriptBody).toMatch(/\. "\$\{HOME\}\/\.bashrc" 2>\/dev\/null \|\| true/);
    expect(scriptBody).toContain("echo hi");
    expect(argsOf("new-session")).not.toContain("-e");
  });

  it("config.environment vars appear as inline exports after the bashrc source", async () => {
    const runtime = create();

    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();

    await runtime.create({
      sessionId: "export-order",
      workspacePath: "/tmp/ws",
      launchCommand: "echo",
      environment: { MY_KEY: "my-value", OTHER: "other-val" },
    });

    const scriptBody = getScriptContent();
    // bashrc source comes first
    expect(scriptBody).toMatch(/\. "\$\{HOME\}\/\.bashrc" 2>\/dev\/null \|\| true/);
    // inline exports follow
    expect(scriptBody).toContain("export MY_KEY='my-value'");
    expect(scriptBody).toContain("export OTHER='other-val'");
    // no -e flags
    expect(argsOf("new-session")).not.toContain("-e");
    // keep-alive tail in script
    expect(scriptBody).toMatch(/exec "\$\{SHELL:-\/bin\/bash\}" -i/);
  });

  it("skips empty-valued config.environment entries in inline exports", async () => {
    const runtime = create();

    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();

    await runtime.create({
      sessionId: "skip-empty",
      workspacePath: "/tmp/ws",
      launchCommand: "echo",
      environment: { GOOD: "val", EMPTY: "" },
    });

    const scriptBody = getScriptContent();
    expect(scriptBody).toContain("export GOOD='val'");
    expect(scriptBody).not.toContain("EMPTY=");
    expect(argsOf("new-session")).not.toContain("-e");
  });

  it("silently skips malformed config.environment keys to prevent shell injection", async () => {
    const runtime = create();

    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();

    await runtime.create({
      sessionId: "safe-key-test",
      workspacePath: "/tmp/ws",
      launchCommand: "echo",
      environment: {
        VALID_KEY: "ok",
        "INVALID KEY": "bad",
        "1STARTS_WITH_NUM": "bad",
        "FOO; rm -rf /": "injection",
      },
    });

    const scriptBody = getScriptContent();
    expect(scriptBody).toContain("export VALID_KEY='ok'");
    expect(scriptBody).not.toContain("INVALID KEY");
    expect(scriptBody).not.toContain("1STARTS_WITH_NUM");
    expect(scriptBody).not.toContain("rm -rf");
  });

  it("all sessions use bash -i so interactive .bashrc guards don't block secrets", async () => {
    const runtime = create();
    // Use a SHORT command to prove bash -i is universal, not just for long commands.
    const shortCommand = "claude --session abc";

    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();

    await runtime.create({
      sessionId: "short-bash-i",
      workspacePath: "/tmp/ws",
      launchCommand: shortCommand,
      environment: {},
    });

    // Every session — short or long — uses bash -i so .bashrc is sourced with
    // interactive semantics — guards like `case $- in *i*) ;; *) return ;; esac`
    // won't prevent secrets from loading (bd-l5ty).
    const shellCmd = argsOf("new-session").at(-1) as string;
    expect(shellCmd).toMatch(/^bash -i '.*ao-launch-.+\.sh'$/);

    const scriptBody = getScriptContent();
    // Script body has the explicit .bashrc source (belt-and-suspenders),
    // plus the launch command and the keep-alive tail.
    expect(scriptBody).toMatch(/\. "\$\{HOME\}\/\.bashrc" 2>\/dev\/null \|\| true/);
    expect(scriptBody).toContain(shortCommand);
    expect(scriptBody).toMatch(/exec "\$\{SHELL:-\/bin\/bash\}" -i/);
    expect(argsOf("new-session")).not.toContain("-e");
  });

  it("overflow regression: 200+ config.environment entries produce no -e args", async () => {
    const runtime = create();

    // Construct 243 env entries — same cardinality as the real macOS bashrc
    // that triggered the pre-fix tmux buffer overflow (243 vars × 2 args = 486
    // extra -e args → per-line buffer overflow → 60s hang). The old code passed
    // ALL config.environment entries as -e KEY=VAL args to tmux new-session.
    const manyEnv = Object.fromEntries(
      Array.from({ length: 243 }, (_, i) => [`VAR_${i}`, `value_${i}`])
    );

    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();

    await runtime.create({
      sessionId: "overflow-test",
      workspacePath: "/tmp/ws",
      launchCommand: "echo test",
      environment: manyEnv,
    });

    // Critical: no -e args regardless of env cardinality.
    expect(argsOf("new-session")).not.toContain("-e");
    // All commands go through bash -i launch script.
    expect(argsOf("new-session").at(-1)).toMatch(/^bash -i '.*ao-launch-.+\.sh'$/);
    // All 243 env vars are inline exports in the script body.
    const scriptBody = getScriptContent();
    expect(scriptBody).toContain("export VAR_0='value_0'");
    expect(scriptBody).toContain("export VAR_242='value_242'");
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

describe("runtime.isAvailable()", () => {
  it("returns true when tmux server is running", async () => {
    const runtime = create();
    mockTmuxSuccess("session1\nsession2");
    await expect(runtime.isAvailable!()).resolves.toBe(true);
  });

  it("returns false when tmux server is unavailable", async () => {
    const runtime = create();
    mockTmuxError("no server running");
    await expect(runtime.isAvailable!()).resolves.toBe(false);
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
  //   For long:    capture-pane×N (Enter retry loop, 1 per attempt until agent responds)
  //   Post-send:   capture-pane (isAgentAliveInPane post-check, +2s sleep)

  it("sends short text with send-keys -l (literal) + Enter", async () => {
    const runtime = create();
    const handle = makeHandle("msg-short");

    // Pre-flight isAgentAliveInPane → returns non-prompt output (agent alive)
    mockTmuxSuccess("✻ Claude is thinking");
    // C-u, send-keys -l, Enter
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    // Post-send isAgentAliveInPane (short message: no Enter-retry loop)
    mockTmuxSuccess("✻ still working");

    await runtime.sendMessage(handle, "hello world");

    // 5 calls total: capture-pane, C-u, send-keys -l, Enter, capture-pane
    expect(mockExecFileCustom).toHaveBeenCalledTimes(5);

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

    // Call 5: post-send capture-pane
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      5,
      "tmux",
      ["capture-pane", "-t", "msg-short", "-p", "-S", "-30"],
      expectedTmuxOptions,
    );
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

  it("skips C-u clear for gemini agents (gemini CLI doesn't handle input clearing)", async () => {
    const runtime = create();
    // Create handle with gemini launch command to trigger gemini codepath
    const handle = makeHandle("msg-gemini", 1000, "gemini --yolo --model gemini-3-flash-preview");

    // Pre-flight isAgentAliveInPane → agent alive (✻ matches agent pattern)
    mockTmuxSuccess("✻ Thinking...");
    // NO C-u for gemini!
    // Direct send-keys -l (not paste-buffer for short message)
    mockTmuxSuccess();
    // Enter
    mockTmuxSuccess();
    // Post-send isAgentAliveInPane → still alive (● Running tool matches)
    mockTmuxSuccess("● Running tool");

    await runtime.sendMessage(handle, "continue with the task");

    const calls = mockExecFileCustom.mock.calls;
    const callArgs = calls.map((c) => c[1]);

    // Verify NO C-u was sent (no call with "C-u" argument)
    const cuCalls = callArgs.filter((args) => args.includes("C-u"));
    expect(cuCalls).toHaveLength(0);

    // Verify send-keys -l was called with the message
    const sendKeysCalls = callArgs.filter(
      (args) => args[0] === "send-keys" && args.includes("-l"),
    );
    expect(sendKeysCalls.length).toBe(1);
    expect(sendKeysCalls[0][4]).toBe("continue with the task");
  });

  it("uses send-keys -l (not paste-buffer) for long gemini messages", async () => {
    const runtime = create();
    // Create handle with gemini launch command
    const handle = makeHandle("msg-gemini-long", 1000, "gemini --yolo");
    const longText = "y".repeat(250);

    // Pre-flight isAgentAliveInPane → ✻ Thinking... matches agent pattern
    mockTmuxSuccess("✻ Thinking...");
    // NO C-u for gemini
    // send-keys -l directly (not paste-buffer)
    mockTmuxSuccess();
    // Enter
    mockTmuxSuccess();
    // Enter retry loop: capture-pane after Enter → ● Running tool matches → agent started
    mockTmuxSuccess("● Running tool");
    // Post-send isAgentAliveInPane → still alive
    mockTmuxSuccess("✻ working");

    await runtime.sendMessage(handle, longText);

    const calls = mockExecFileCustom.mock.calls;
    const callArgs = calls.map((c) => c[1]);

    // Verify NO C-u was sent
    const cuCalls = callArgs.filter((args) => args.includes("C-u"));
    expect(cuCalls).toHaveLength(0);

    // Verify NO load-buffer was called (gemini uses direct send-keys)
    const loadBufferCalls = callArgs.filter((args) => args.includes("load-buffer"));
    expect(loadBufferCalls).toHaveLength(0);

    // Verify send-keys -l was called with the long text
    const sendKeysCalls = callArgs.filter(
      (args) => args[0] === "send-keys" && args.includes("-l"),
    );
    expect(sendKeysCalls.length).toBe(1);
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

describe("runtime.getRestartCommand() — bd-tln", () => {
  it("returns the stored launchCommand", async () => {
    const runtime = create();
    const handle = makeHandle("restart-test", 1000, "claude --session my-session");

    const cmd = await runtime.getRestartCommand!(handle);

    expect(cmd).toBe("claude --session my-session");
  });

  it("throws when launchCommand is not stored", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "no-cmd",
      runtimeName: "tmux",
      data: { createdAt: 1000 },
    };

    await expect(runtime.getRestartCommand!(handle)).rejects.toThrow(
      /launchCommand not stored/,
    );
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

    // sendMessage proceeds: C-u, send-keys -l, Enter
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    // Post-send check → alive
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

    // Pre-send alive check → alive
    mockTmuxSuccess("✻ Thinking");
    // C-u, send-keys -l, Enter
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    // Post-send check → dead (pasted into bash)
    mockTmuxSuccess("/workspace $");

    // restartAgentCli: C-c, C-c, send-keys -l launch, send-keys Enter, poll → alive
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess(); // Enter for restart
    mockTmuxSuccess("✻ Thinking");

    // Retry via doSend: C-u, send-keys -l, Enter
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();

    await runtime.sendMessage(handle, "important task");

    // Message sent twice (original + retry)
    const sendKeysCalls = mockExecFileCustom.mock.calls.filter(
      (c: unknown[]) =>
        (c[1] as string[])[0] === "send-keys" &&
        (c[1] as string[]).includes("-l") &&
        (c[1] as string[]).includes("important task"),
    );
    expect(sendKeysCalls.length).toBe(2);
  });
});
