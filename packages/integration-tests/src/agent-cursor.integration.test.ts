/**
 * Integration tests for the Cursor agent plugin.
 *
 * Requires:
 *   - `cursor-agent` binary on PATH
 *   - tmux installed and running
 *   - ANTHROPIC_API_KEY or CURSOR credentials set
 *
 * Skipped automatically when prerequisites are missing.
 *
 * Task: write a fibonacci program to /tmp/ao-inttest-cursor-<ts>/fibonacci.py
 * and verify the file exists and is executable.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import cursorPlugin from "@composio/ao-plugin-agent-cursor";
import {
  isTmuxAvailable,
  killSessionsByPrefix,
  createSession,
  killSession,
} from "./helpers/tmux.js";
import { pollUntilEqual, sleep } from "./helpers/polling.js";
import { makeTmuxHandle, makeSession } from "./helpers/session-factory.js";

const execFileAsync = promisify(execFile);

const SESSION_PREFIX = "ao-inttest-cursor-";

async function findCursorBinary(): Promise<string | null> {
  for (const bin of ["cursor-agent"]) {
    try {
      await execFileAsync("which", [bin], { timeout: 5_000 });
      return bin;
    } catch {
      // not found
    }
  }
  return null;
}

const tmuxOk = await isTmuxAvailable();
const cursorBin = await findCursorBinary();
const canRun = tmuxOk && cursorBin !== null;

describe.skipIf(!canRun)("agent-cursor (integration)", () => {
  const agent = cursorPlugin.create();
  const sessionName = `${SESSION_PREFIX}${Date.now()}`;
  let tmpDir: string;
  let outputFile: string;

  let aliveRunning = false;
  let exitedRunning: boolean;
  let fileCreated = false;

  beforeAll(async () => {
    await killSessionsByPrefix(SESSION_PREFIX);
    tmpDir = await mkdtemp(join(tmpdir(), "ao-inttest-cursor-"));
    outputFile = join(tmpDir, "fibonacci.py");

    // cursor-agent requires a git workspace to write files.
    // Initialize a git repo so cursor-agent can write to this tmpDir.
    await execFileAsync("git", ["init", tmpDir], { timeout: 5_000 });
    await execFileAsync("git", ["-C", tmpDir, "config", "user.email", "test@example.com"], { timeout: 5_000 });
    await execFileAsync("git", ["-C", tmpDir, "config", "user.name", "Test"], { timeout: 5_000 });

    const task = `Write a Python fibonacci program to the file fibonacci.py. The program should print the first 10 fibonacci numbers when run. Write only the file, no explanation.`;
    const cmd = `${cursorBin} --print '${task}'`;
    await createSession(sessionName, cmd, tmpDir);

    const handle = makeTmuxHandle(sessionName);
    const session = makeSession("inttest-cursor", handle, tmpDir);

    // Poll until running
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const running = await agent.isProcessRunning(handle);
      if (running) { aliveRunning = true; break; }
      await sleep(500);
    }

    // Wait for agent to exit (up to 2 min)
    exitedRunning = await pollUntilEqual(() => agent.isProcessRunning(handle), false, {
      timeoutMs: 120_000,
      intervalMs: 2_000,
    });

    // Check file was created
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

  it("isProcessRunning → false after agent exits", () => {
    expect(exitedRunning).toBe(false);
  });

  it("fibonacci.py created in output dir", () => {
    expect(fileCreated).toBe(true);
  });

  it("fibonacci.py runs and outputs numbers", async () => {
    if (!fileCreated) return;
    const { stdout } = await execFileAsync("python3", [outputFile], { timeout: 10_000 });
    const numbers = stdout.trim().split(/\s+/).map(Number).filter(n => !isNaN(n));
    expect(numbers.length).toBeGreaterThanOrEqual(10);
    // First 10 fibonacci numbers
    expect(numbers.slice(0, 10)).toEqual([0, 1, 1, 2, 3, 5, 8, 13, 21, 34]);
  });
});
