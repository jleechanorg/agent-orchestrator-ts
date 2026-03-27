import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "node:child_process";

// Mock node:child_process
vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  return { execFile: mockExecFile };
});

// Mock queue — bypass serial queue for unit tests
vi.mock("../queue.js", () => ({
  enqueue: <T>(fn: () => Promise<T>) => fn(),
  pendingCount: () => 0,
}));

const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

function mockSuccess(stdout: string) {
  mockExecFile.mockImplementationOnce(
    (
      _cmd: string,
      _args: string[],
      _opts: Record<string, unknown>,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      cb(null, { stdout, stderr: "" });
    },
  );
}

function mockError(message: string) {
  mockExecFile.mockImplementationOnce(
    (
      _cmd: string,
      _args: string[],
      _opts: Record<string, unknown>,
      cb: (err: Error | null) => void,
    ) => {
      cb(new Error(message));
    },
  );
}

import { runPreflight } from "../preflight.js";

beforeEach(() => {
  vi.clearAllMocks();
});

const MANAGER_WINDOW = {
  window_id: 1,
  title: "Manager",
  isOnScreen: true,
  isMinimized: false,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
};

const CONVERSATION_WINDOW = {
  window_id: 2,
  title: "conversation-42",
  isOnScreen: true,
  isMinimized: false,
  bounds: { x: 100, y: 100, width: 600, height: 400 },
};

/** Wrap windows in the Peekaboo list envelope format. */
function listEnvelope(windows: typeof MANAGER_WINDOW[]) {
  return JSON.stringify({
    data: { targetApplication: "Antigravity", windows },
  });
}

describe("runPreflight()", () => {
  it("returns ok=true when all three steps pass", async () => {
    // Step 1: peekaboo-reachable
    mockSuccess(listEnvelope([MANAGER_WINDOW, CONVERSATION_WINDOW]));
    // Step 2: app-running
    mockSuccess(listEnvelope([MANAGER_WINDOW, CONVERSATION_WINDOW]));
    // Step 3: manager-window
    mockSuccess(listEnvelope([MANAGER_WINDOW, CONVERSATION_WINDOW]));

    const result = await runPreflight();

    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0]).toMatchObject({ name: "peekaboo-reachable", passed: true });
    expect(result.steps[1]).toMatchObject({ name: "app-running", passed: true });
    expect(result.steps[2]).toMatchObject({ name: "manager-window", passed: true });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("fails at peekaboo-reachable when CLI throws", async () => {
    mockError("peekaboo not found");

    const result = await runPreflight();

    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      name: "peekaboo-reachable",
      passed: false,
      error: "peekaboo not found",
    });
  });

  it("fails at app-running when no windows are returned", async () => {
    // Step 1: peekaboo-reachable
    mockSuccess(listEnvelope([]));
    // Step 2: app-running (empty list)
    mockSuccess(listEnvelope([]));

    const result = await runPreflight();

    expect(result.ok).toBe(false);
    expect(result.steps[1]).toMatchObject({
      name: "app-running",
      passed: false,
      error: "No Antigravity windows found — is the app running?",
    });
  });

  it("fails at manager-window when Manager window is absent", async () => {
    // Step 1: peekaboo-reachable
    mockSuccess(listEnvelope([CONVERSATION_WINDOW]));
    // Step 2: app-running
    mockSuccess(listEnvelope([CONVERSATION_WINDOW]));
    // Step 3: manager-window — no Manager window
    mockSuccess(listEnvelope([CONVERSATION_WINDOW]));

    const result = await runPreflight();

    expect(result.ok).toBe(false);
    expect(result.steps[2]).toMatchObject({
      name: "manager-window",
      passed: false,
      error: "Antigravity Manager window not found — open Antigravity first",
    });
  });

  it("respects custom timeoutMs via config", async () => {
    // All 3 steps must pass: peekaboo-reachable, app-running, manager-window
    mockSuccess(listEnvelope([MANAGER_WINDOW]));
    mockSuccess(listEnvelope([MANAGER_WINDOW]));
    mockSuccess(listEnvelope([MANAGER_WINDOW]));

    const result = await runPreflight({ timeoutMs: 5_000 });

    expect(result.ok).toBe(true);
    expect(result.steps[0].name).toBe("peekaboo-reachable");
  });

  it("records elapsedMs even on failure", async () => {
    mockError("peekaboo not found");

    const result = await runPreflight();

    expect(result.ok).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
