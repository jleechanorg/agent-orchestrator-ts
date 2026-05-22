/**
 * Integration tests for the Z.AI provider path via Claude Code plugin.
 *
 * Z.AI is handled inline by the claude-code plugin (no dedicated agent plugin).
 * This test verifies the z.ai Anthropic-compatible endpoint works end-to-end.
 *
 * Requires:
 *   - `claude` binary on PATH
 *   - tmux installed and running
 *   - GLM_API_KEY set
 *
 * Skipped when prerequisites are missing, or when `SKIP_AGENT_ZAI_E2E=1` (e.g. quota exhausted).
 *
 * Task: write a fibonacci program under the temp workspace and verify output.
 */

import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentLaunchConfig } from "@jleechanorg/ao-core";
import claudeCodePlugin from "@jleechanorg/ao-plugin-agent-claude-code";
import {
  isTmuxAvailable,
  killSessionsByPrefix,
  createSession,
  killSession,
} from "./helpers/tmux.js";
import { findBinary, pollUntilEqual, sleep } from "./helpers/polling.js";
import { FIBONACCI_PROMPT_ONE_SHOT, waitForFibonacciPy } from "./helpers/fibonacci-output.js";
import { makeTmuxHandle, makeSession } from "./helpers/session-factory.js";

const execFileAsync = promisify(execFile);

const SESSION_PREFIX = "ao-inttest-zai-";

function makeLaunchConfig(overrides: Partial<AgentLaunchConfig> = {}): AgentLaunchConfig {
  return {
    sessionId: "inttest-zai",
    projectConfig: {
      name: "inttest-zai",
      repo: "jleechanorg/agent-orchestrator",
      path: "/workspace",
      defaultBranch: "main",
      sessionPrefix: "zai",
    },
    model: "z.ai/GLM-5.1",
    permissions: "permissionless" as const,
    ...overrides,
  };
}

const tmuxOk = await isTmuxAvailable();
const claudeBin = await findBinary(["claude"]);
const python3Bin = await findBinary(["python3"]);
const hasGlmKey = !!process.env.GLM_API_KEY;
const skipZai = process.env.SKIP_AGENT_ZAI_E2E === "1";
const canRun =
  tmuxOk && claudeBin !== null && python3Bin !== null && hasGlmKey && !skipZai;

describe.skipIf(!canRun)("agent-zai (integration)", () => {
  const agent = claudeCodePlugin.create();
  const sessionName = `${SESSION_PREFIX}${Date.now()}`;
  let tmpDir: string;
  let outputFile: string;

  let aliveRunning: boolean | "indeterminate" = false;
  let aliveActivityState: Awaited<ReturnType<typeof agent.getActivityState>>;
  let aliveSessionInfo: Awaited<ReturnType<typeof agent.getSessionInfo>> | null = null;
  let exitedRunning: boolean | "indeterminate";
  let exitedActivityState: Awaited<ReturnType<typeof agent.getActivityState>>;
  let exitedSessionInfo: Awaited<ReturnType<typeof agent.getSessionInfo>> | null = null;
  let fileCreated = false;

  beforeAll(async () => {
    await killSessionsByPrefix(SESSION_PREFIX);
    const rawTmp = await mkdtemp(join(tmpdir(), "ao-inttest-zai-"));
    tmpDir = await realpath(rawTmp);
    outputFile = join(tmpDir, "fibonacci.py");

    const task = FIBONACCI_PROMPT_ONE_SHOT;
    const launchCfg = makeLaunchConfig();
    const cmd = `${agent.getLaunchCommand(launchCfg)} -p "${task}"`;
    const pluginEnv = agent.getEnvironment(launchCfg);
    await createSession(sessionName, cmd, tmpDir, pluginEnv);

    const handle = makeTmuxHandle(sessionName);
    const session = makeSession("inttest-zai", handle, tmpDir);

    aliveRunning = await pollUntilEqual(() => agent.isProcessRunning(handle), true, {
      timeoutMs: 30_000,
      intervalMs: 1_000,
    }).catch(() => false);

    if (aliveRunning) {
      aliveActivityState = await agent.getActivityState(session);
      aliveSessionInfo = (await agent.getSessionInfo(session)) ?? null;
    }

    exitedRunning = await pollUntilEqual(() => agent.isProcessRunning(handle), false, {
      timeoutMs: 180_000,
      intervalMs: 2_000,
    });

    exitedActivityState = await agent.getActivityState(session);
    const settleDeadline = Date.now() + 25_000;
    while (exitedActivityState?.state !== "exited" && Date.now() < settleDeadline) {
      await sleep(500);
      exitedActivityState = await agent.getActivityState(session);
    }
    exitedSessionInfo = (await agent.getSessionInfo(session)) ?? null;

    const found = await waitForFibonacciPy(tmpDir, { timeoutMs: 120_000 });
    fileCreated = found !== null;
    if (found) outputFile = found;
  }, 240_000);

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

  it("getSessionInfo → returns session data while running (or null)", () => {
    if (aliveSessionInfo !== null) {
      expect(aliveSessionInfo).toHaveProperty("summary");
    }
  });

  it("isProcessRunning → false after agent exits", () => {
    expect(exitedRunning).toBe(false);
  });

  it("getActivityState → returns exited after agent terminates", () => {
    expect(exitedActivityState?.state).toBe("exited");
  });

  it("getSessionInfo → returns session data after exit (or null)", () => {
    if (exitedSessionInfo !== null) {
      expect(exitedSessionInfo).toHaveProperty("summary");
    }
  });

  it("fibonacci.py created in workspace", () => {
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
