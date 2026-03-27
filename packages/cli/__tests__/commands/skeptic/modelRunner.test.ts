import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

import { runSkepticEvaluation } from "../../../src/commands/skeptic/modelRunner.js";

function makeMockChild(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  emitError?: Error;
}): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  // Minimal writable stdin that handles the 1-arg and 2-arg write signature
  emitter.stdin = {
    write(chunk: unknown, _encoding?: BufferEncoding | ((err?: Error | null) => void), _cb?: (err?: Error | null) => void) {
      if (typeof _encoding === "function") _encoding();
      return true;
    },
    end() {},
    on() { return this; },
    removeListener() { return this; },
  } as unknown as NodeJS.WritableStream & { write(chunk: unknown, cb?: (err?: Error | null) => void): boolean; end(): void; on(): void; removeListener(): void };
  emitter.stdout = new EventEmitter();
  emitter.stderr = new EventEmitter();
  emitter.killed = false;
  emitter.kill = vi.fn();
  emitter.on = emitter.addListener.bind(emitter);

  const { stdout = "", stderr = "", exitCode = 0, emitError } = opts;

  queueMicrotask(() => {
    if (emitError) {
      emitter.emit("error", emitError);
      return;
    }
    if (stdout) emitter.stdout.emit("data", Buffer.from(stdout));
    if (stderr) emitter.stderr.emit("data", Buffer.from(stderr));
    if (exitCode !== null) emitter.emit("close", exitCode);
  });

  return emitter;
}

beforeEach(() => {
  mockSpawn.mockReset();
});

describe("runSkepticEvaluation", () => {
  it("returns trimmed VERDICT output on successful execution (exit code 0)", async () => {
    mockSpawn.mockReturnValue(makeMockChild({ stdout: "  VERDICT: PASS  \n", exitCode: 0 }));

    const result = await runSkepticEvaluation("test prompt");
    expect(result).toBe("VERDICT: PASS");
    expect(mockSpawn).toHaveBeenCalledWith("claude", ["--print"], expect.any(Object));
  });

  it("writes prompt to stdin and closes it", async () => {
    const child = makeMockChild({ stdout: "VERDICT: PASS", exitCode: 0 });
    const writeSpy = vi.spyOn(child.stdin!, "write");
    const endSpy = vi.spyOn(child.stdin!, "end");
    mockSpawn.mockReturnValue(child);

    const prompt = "my multiline\nprompt content";
    await runSkepticEvaluation(prompt);

    expect(writeSpy).toHaveBeenCalledWith(prompt);
    expect(endSpy).toHaveBeenCalled();
  });

  it("returns FAIL verdict with exit code and stderr snippet on non-zero exit", async () => {
    mockSpawn.mockReturnValue(
      makeMockChild({ stderr: "error: unknown option '--no-input'", exitCode: 1 }),
    );

    const result = await runSkepticEvaluation("test prompt");
    expect(result).toMatch(/^VERDICT: FAIL — Claude CLI exited with code 1\nstderr: error: unknown option/);
  });

  it("returns FAIL verdict with exit code only when stderr is empty on non-zero exit", async () => {
    mockSpawn.mockReturnValue(makeMockChild({ exitCode: 2 }));

    const result = await runSkepticEvaluation("test prompt");
    expect(result).toBe("VERDICT: FAIL — Claude CLI exited with code 2");
  });

  it("returns FAIL verdict with error message when child process emits an error event", async () => {
    mockSpawn.mockReturnValue(
      makeMockChild({ emitError: new Error("ENOENT: claude not found in PATH") }),
    );

    const result = await runSkepticEvaluation("test prompt");
    expect(result).toMatch(/^VERDICT: FAIL — Claude CLI not available: /);
    expect(result).toContain("ENOENT");
  });

  it("returns FAIL verdict with timeout message after 120s", async () => {
    vi.useFakeTimers();
    mockSpawn.mockReturnValue(makeMockChild({ exitCode: null }));
    // Never resolve — simulating a hung CLI process.

    const evalPromise = runSkepticEvaluation("test prompt");
    // Advance past the 120_000ms timeout
    vi.advanceTimersByTime(120_001);

    const result = await evalPromise;
    vi.useRealTimers();

    expect(result).toBe("VERDICT: FAIL — Claude CLI timed out after 120s");
  });
});
