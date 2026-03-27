import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runSkepticEvaluation } from "../../../src/commands/skeptic/modelRunner.js";

// Hoist ALL mocks before they're referenced in vi.mock / vi.hoisted calls
const mockChildOn = vi.hoisted(() => vi.fn());
const mockChildStdoutOn = vi.hoisted(() => vi.fn());
const mockChildStderrOn = vi.hoisted(() => vi.fn());
const mockChildStdinWrite = vi.hoisted(() => vi.fn());
const mockChildStdinEnd = vi.hoisted(() => vi.fn());
const mockChildKill = vi.hoisted(() => vi.fn());

// mockSpawnInstance must also be hoisted since it references hoisted mocks
const mockSpawnInstance = vi.hoisted(() => ({
  on: mockChildOn,
  stdout: { on: mockChildStdoutOn },
  stderr: { on: mockChildStderrOn },
  stdin: { write: mockChildStdinWrite, end: mockChildStdinEnd },
  kill: mockChildKill,
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => mockSpawnInstance),
}));

import { spawn } from "node:child_process";

// Helpers to simulate events on the mock child process
function simulateClose(code: number | null) {
  const closeHandler = mockChildOn.mock.calls.find(([event]) => event === "close")?.[1] as (
    code: number | null
  ) => void;
  closeHandler?.(code);
}

function simulateError(err: Error) {
  const errorHandler = mockChildOn.mock.calls.find(([event]) => event === "error")?.[1] as (
    err: Error
  ) => void;
  errorHandler?.(err);
}

function simulateStdout(data: string) {
  const handler = mockChildStdoutOn.mock.calls.find(([event]) => event === "data")?.[1] as (
    chunk: Buffer
  ) => void;
  handler?.(Buffer.from(data));
}

function simulateStderr(data: string) {
  const handler = mockChildStderrOn.mock.calls.find(([event]) => event === "data")?.[1] as (
    chunk: Buffer
  ) => void;
  handler?.(Buffer.from(data));
}

// Use Vitest's built-in fake timers — more reliable than manual spies
beforeEach(() => {
  vi.useFakeTimers();
  mockChildOn.mockReset();
  mockChildStdoutOn.mockReset();
  mockChildStderrOn.mockReset();
  mockChildStdinWrite.mockReset();
  mockChildStdinEnd.mockReset();
  mockChildKill.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runSkepticEvaluation", () => {
  it("spawns claude with --print flag", async () => {
    const p = runSkepticEvaluation("test prompt");
    expect(spawn).toHaveBeenCalledWith("claude", ["--print"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Resolve with success
    simulateStdout("VERDICT: PASS\n");
    simulateClose(0);
    await expect(p).resolves.toBe("VERDICT: PASS");
  });

  it("writes the prompt to stdin", async () => {
    const p = runSkepticEvaluation("test prompt");
    expect(mockChildStdinWrite).toHaveBeenCalledWith("test prompt");
    expect(mockChildStdinEnd).toHaveBeenCalled();
    simulateStdout("ok");
    simulateClose(0);
    await p;
  });

  it("returns trimmed stdout on successful exit (code 0)", async () => {
    const p = runSkepticEvaluation("prompt");
    simulateStdout("  VERDICT: PASS  \n");
    simulateClose(0);
    await expect(p).resolves.toBe("VERDICT: PASS");
  });

  it("returns FAIL with exit code and stderr snippet on non-zero exit", async () => {
    const p = runSkepticEvaluation("prompt");
    simulateStderr("some error message");
    simulateClose(42);
    await expect(p).resolves.toBe(
      "VERDICT: FAIL — Claude CLI exited with code 42\nstderr: some error message",
    );
  });

  it("returns FAIL with exit code and truncated stderr (300 chars)", async () => {
    const p = runSkepticEvaluation("prompt");
    const longStderr = "x".repeat(500);
    simulateStderr(longStderr);
    simulateClose(1);
    const result = await p;
    expect(result).toMatch(/^VERDICT: FAIL — Claude CLI exited with code 1\nstderr: /);
    const stderrPart = result.split("stderr: ")[1];
    expect(stderrPart.length).toBe(300);
  });

  it("returns FAIL and truncates error message to 200 chars on spawn error", async () => {
    const longMessage = "E".repeat(400);
    const p = runSkepticEvaluation("prompt");
    simulateError(new Error(longMessage));
    const result = await p;
    expect(result).toMatch(/^VERDICT: FAIL — Claude CLI not available: /);
    const msgPart = result.split("Claude CLI not available: ")[1];
    expect(msgPart.length).toBe(200);
  });

  it("sets a 120s timeout and kills child on timeout", async () => {
    const p = runSkepticEvaluation("prompt");
    // The timeout is set for 120_000ms; advance past it
    vi.advanceTimersByTime(120_001);
    expect(mockChildKill).toHaveBeenCalled();
    await expect(p).resolves.toBe("VERDICT: FAIL — Claude CLI timed out after 120s");
  });

  it("clears timeout on successful close", async () => {
    const p = runSkepticEvaluation("prompt");
    simulateStdout("ok");
    simulateClose(0);
    // Pending timers should be cleared
    vi.runAllTimers();
    await p;
    // Should have no pending timers after close resolved
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears timeout on non-zero exit", async () => {
    const p = runSkepticEvaluation("prompt");
    simulateStderr("");
    simulateClose(1);
    vi.runAllTimers();
    await p;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears timeout on spawn error", async () => {
    const p = runSkepticEvaluation("prompt");
    simulateError(new Error("not available"));
    vi.runAllTimers();
    await p;
    expect(vi.getTimerCount()).toBe(0);
  });
});
