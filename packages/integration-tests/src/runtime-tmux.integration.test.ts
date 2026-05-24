import { afterAll, beforeAll, describe, expect, it } from "vitest";
import tmuxPlugin from "@jleechanorg/ao-plugin-runtime-tmux";
import type { RuntimeHandle } from "@jleechanorg/ao-core";
import { isTmuxAvailable, killSessionsByPrefix } from "./helpers/tmux.js";
import { sleep } from "./helpers/polling.js";

const tmuxOk = await isTmuxAvailable();
const SESSION_PREFIX = "ao-inttest-tmux-";

describe.skipIf(!tmuxOk)("runtime-tmux (integration)", () => {
  const runtime = tmuxPlugin.create();
  const sessionId = `${SESSION_PREFIX}${Date.now()}`;
  let handle: RuntimeHandle;

  beforeAll(async () => {
    await killSessionsByPrefix(SESSION_PREFIX);
  }, 30_000);

  afterAll(async () => {
    try {
      await runtime.destroy(handle);
    } catch {
      /* best-effort cleanup */
    }
    await killSessionsByPrefix(SESSION_PREFIX);
  }, 30_000);

  it("creates a tmux session", async () => {
    handle = await runtime.create({
      sessionId,
      workspacePath: "/tmp",
      launchCommand: "cat", // cat will wait for stdin
      environment: { AO_TEST: "1" },
    });

    expect(handle.id).toBe(sessionId);
    expect(handle.runtimeName).toBe("tmux");
  });

  it("kills stale pre-existing session on collision during create", async () => {
    // Red-phase evidence (before fix): the old code called tmux kill-session BEFORE
    // tmux new-session.  If new-session failed for any reason after the kill, the
    // original live session was already gone and the test would have seen:
    //   Error: spawn tmux ENOENT  -or-  "duplicate session: <name>" (on success path)
    // More critically, any non-duplicate failure (e.g. bad workspacePath) would
    // silently destroy the existing session and then propagate the error, leaving
    // the caller with a dead session it didn't expect to lose.  The new code
    // tries new-session first and only kills on a confirmed duplicate-session error.
    const collisionSessionId = `${SESSION_PREFIX}collision-${Date.now()}`;

    // Create first session manually/via plugin
    const handle1 = await runtime.create({
      sessionId: collisionSessionId,
      workspacePath: "/tmp",
      launchCommand: "cat",
      environment: { AO_TEST: "1" },
    });

    expect(await runtime.isAlive(handle1)).toBe(true);

    // Create second session with exact same name - should kill the first and succeed
    const handle2 = await runtime.create({
      sessionId: collisionSessionId,
      workspacePath: "/tmp",
      launchCommand: "cat",
      environment: { AO_TEST: "2" },
    });

    expect(handle2.id).toBe(collisionSessionId);
    expect(await runtime.isAlive(handle2)).toBe(true);

    // Clean up
    await runtime.destroy(handle2);
  });

  it("isAlive returns true for running session", async () => {
    expect(await runtime.isAlive(handle)).toBe(true);
  });

  it("sendMessage sends text and getOutput captures it", async () => {
    await runtime.sendMessage(handle, "hello world");
    await sleep(500); // give tmux time to process
    const output = await runtime.getOutput(handle);
    expect(output).toContain("hello world");
  });

  it("sendMessage handles long text via buffer", async () => {
    const longText = "x".repeat(250);
    await runtime.sendMessage(handle, longText);
    await sleep(500);
    const output = await runtime.getOutput(handle);
    // tmux wraps long text at column width, so strip ANSI escapes and newlines
    // eslint-disable-next-line no-control-regex
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, "").replace(/\n/g, "");
    expect(stripped).toContain(longText);
  });

  it("getMetrics returns uptime", async () => {
    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThan(0);
  });

  it("getAttachInfo returns tmux command", async () => {
    const info = await runtime.getAttachInfo!(handle);
    expect(info.type).toBe("tmux");
    expect(info.target).toBe(sessionId);
    expect(info.command).toContain("tmux attach");
  });

  it("destroy kills the session", async () => {
    await runtime.destroy(handle);
    expect(await runtime.isAlive(handle)).toBe(false);
  });

  it("destroy is idempotent", async () => {
    // Should not throw even though session is already dead
    await runtime.destroy(handle);
  });
});
