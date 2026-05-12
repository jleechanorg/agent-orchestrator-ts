/**
 * Integration tests for the MiniMax agent plugin.
 *
 * Requires:
 *   - `claude` binary on PATH
 *   - tmux installed and running
 *   - MINIMAX_API_KEY set
 *
 * Skipped automatically when prerequisites are missing.
 *
 * Task: write a fibonacci program to /tmp/ao-inttest-minimax-<ts>/fibonacci.py
 * and verify the file exists and produces correct output.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import minimaxPlugin from "@jleechanorg/ao-plugin-agent-minimax";
import {
  isTmuxAvailable,
  killSessionsByPrefix,
  createSession,
  killSession,
} from "./helpers/tmux.js";
import { findBinary, pollUntilEqual } from "./helpers/polling.js";
import { makeTmuxHandle, makeSession } from "./helpers/session-factory.js";

const execFileAsync = promisify(execFile);

const SESSION_PREFIX = "ao-inttest-minimax-";

const tmuxOk = await isTmuxAvailable();
const claudeBin = await findBinary(["claude"]);
const python3Bin = await findBinary(["python3"]);
const hasMinimaxKey = !!process.env.MINIMAX_API_KEY;
const canRun = tmuxOk && claudeBin !== null && python3Bin !== null && hasMinimaxKey;

describe.skipIf(!canRun)("agent-minimax (integration)", () => {
  const agent = minimaxPlugin.create();
  const sessionName = `${SESSION_PREFIX}${Date.now()}`;
  let tmpDir: string;
  let outputFile: string;

  let aliveRunning = false;
  let aliveActivityState: Awaited<ReturnType<typeof agent.getActivityState>>;
  let exitedRunning: boolean;
  let exitedActivityState: Awaited<ReturnType<typeof agent.getActivityState>>;
  let fileCreated = false;

  beforeAll(async () => {
    await killSessionsByPrefix(SESSION_PREFIX);
    tmpDir = await mkdtemp(join(tmpdir(), "ao-inttest-minimax-"));
    outputFile = join(tmpDir, "fibonacci.py");

    const task = `Write a Python fibonacci program to the file ${outputFile}. The program should print the first 10 fibonacci numbers when run. Write only the file, no explanation.`;
    const minimaxKey = process.env.MINIMAX_API_KEY!;
    const baseUrl = process.env.MINIMAX_ANTHROPIC_BASE_URL?.trim() || "https://api.minimax.io/anthropic";
    const cmd = `claude --dangerously-skip-permissions -p "${task}"`;
    await createSession(sessionName, cmd, tmpDir, {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: minimaxKey,
    });

    const handle = makeTmuxHandle(sessionName);
    const session = makeSession("inttest-minimax", handle, tmpDir);

    aliveRunning = await pollUntilEqual(() => agent.isProcessRunning(handle), true, {
      timeoutMs: 30_000,
      intervalMs: 1_000,
    }).catch(() => false);

    if (aliveRunning) {
      aliveActivityState = await agent.getActivityState(session);
    }

    exitedRunning = await pollUntilEqual(() => agent.isProcessRunning(handle), false, {
      timeoutMs: 120_000,
      intervalMs: 2_000,
    });

    exitedActivityState = await agent.getActivityState(session);

    try {
      await access(outputFile);
      fileCreated = true;
    } catch {
      fileCreated = false;
    }
  }, 150_000);

  afterAll(async () => {
    await killSession(sessionName);
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it("isProcessRunning → true while agent is alive", () => {
    expect(aliveRunning).toBe(true);
  });

  it("getActivityState → returns valid state while running", () => {
    expect(aliveActivityState).toBeDefined();
    if (aliveActivityState) {
      expect(aliveActivityState.state).not.toBe("exited");
    }
  });

  it("isProcessRunning → false after agent exits", () => {
    expect(exitedRunning).toBe(false);
  });

  it("getActivityState → returns exited after agent terminates", () => {
    expect(exitedActivityState?.state).toBe("exited");
  });

  it("fibonacci.py created in output dir", () => {
    expect(fileCreated).toBe(true);
  });

  it("fibonacci.py runs and outputs correct fibonacci numbers", async () => {
    expect(fileCreated).toBe(true);
    const { stdout } = await execFileAsync(python3Bin!, ["-I", outputFile], {
      timeout: 10_000,
      env: { PATH: process.env.PATH ?? "" },
    });
    const numbers = stdout.trim().split(/\s+/).map(Number).filter(n => !isNaN(n));
    expect(numbers.length).toBeGreaterThanOrEqual(10);
    expect(numbers.slice(0, 10)).toEqual([0, 1, 1, 2, 3, 5, 8, 13, 21, 34]);
  });
});
