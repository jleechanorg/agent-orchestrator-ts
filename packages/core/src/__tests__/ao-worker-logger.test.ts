import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import {
  logSpawnStart,
  logAgentLaunch,
  logPromptDelivery,
  logSessionEvent,
  AOWorkerLogger,
} from "../ao-worker-logger.js";

const logRoot = () => join(os.tmpdir(), "agent-orchestrator");

function rmProjectLogs(projectId: string): void {
  const p = join(logRoot(), projectId);
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true });
  }
}

describe("ao-worker-logger", () => {
  const prevLevel = process.env.AO_LOG_LEVEL;

  beforeEach(() => {
    rmProjectLogs("log-test-proj");
  });

  afterEach(() => {
    if (prevLevel === undefined) {
      delete process.env.AO_LOG_LEVEL;
    } else {
      process.env.AO_LOG_LEVEL = prevLevel;
    }
    rmProjectLogs("log-test-proj");
    vi.restoreAllMocks();
  });

  it("skips all writes when AO_LOG_LEVEL is unset", () => {
    delete process.env.AO_LOG_LEVEL;
    logSpawnStart("s1", "log-test-proj", "claude", "tmux", { branch: "main" });
    expect(existsSync(join(logRoot(), "log-test-proj"))).toBe(false);
  });

  it("skips writes when AO_LOG_LEVEL is not info/debug", () => {
    process.env.AO_LOG_LEVEL = "warn";
    logSpawnStart("s1", "log-test-proj", "claude", "tmux", {});
    expect(existsSync(join(logRoot(), "log-test-proj"))).toBe(false);
  });

  it("accepts AO_LOG_LEVEL=debug (case-insensitive)", () => {
    process.env.AO_LOG_LEVEL = " DEBUG ";
    logSpawnStart("s1", "log-test-proj", "claude", "tmux", {});
    expect(existsSync(join(logRoot(), "log-test-proj", "s1.jsonl"))).toBe(true);
  });

  it("logSpawnStart writes JSONL and daily summary under sanitized branch dir", () => {
    process.env.AO_LOG_LEVEL = "info";
    logSpawnStart("sess-a", "log-test-proj", "claude", "tmux", {
      branch: "feat/foo-bar",
      prompt: "do thing",
      workspacePath: "/tmp/w",
      issueId: "bd-1",
      metadata: { k: 1 },
    });
    const branchDir = join(logRoot(), "log-test-proj", "feat_foo-bar");
    const sessionFile = join(branchDir, "sess-a.jsonl");
    expect(existsSync(sessionFile)).toBe(true);
    const entry = JSON.parse(readFileSync(sessionFile, "utf-8").trim());
    expect(entry.event).toBe("spawn_start");
    expect(entry.sessionId).toBe("sess-a");
    expect(entry.projectId).toBe("log-test-proj");
    // Prompt should be redacted to avoid persisting sensitive data
    expect(entry.data.prompt).toMatch(/^\[redacted:\d+ chars\]$/);
    expect(entry.data.branch).toBe("feat/foo-bar");

    const today = new Date().toISOString().split("T")[0];
    const summary = join(branchDir, `${today}-summary.jsonl`);
    expect(existsSync(summary)).toBe(true);
    expect(readFileSync(summary, "utf-8").trim()).toBe(JSON.stringify(entry));
  });

  it("logSpawnStart without branch uses project-only path", () => {
    process.env.AO_LOG_LEVEL = "info";
    logSpawnStart("sess-b", "log-test-proj", "codex", "tmux", {});
    const sessionFile = join(logRoot(), "log-test-proj", "sess-b.jsonl");
    expect(existsSync(sessionFile)).toBe(true);
  });

  it("logAgentLaunch records launchCommand and optional systemPrompt", () => {
    process.env.AO_LOG_LEVEL = "info";
    logAgentLaunch("s2", "log-test-proj", "claude", "tmux", {
      launchCommand: "claude --print",
      systemPrompt: "sys",
      branch: "main",
    });
    const f = join(logRoot(), "log-test-proj", "main", "s2.jsonl");
    const entry = JSON.parse(readFileSync(f, "utf-8").trim());
    expect(entry.event).toBe("agent_launch");
    expect(entry.data.launchCommand).toBe("claude --print");
    // systemPrompt should be redacted to avoid persisting sensitive data
    expect(entry.data.systemPrompt).toMatch(/^\[redacted:\d+ chars\]$/);
  });

  it("logPromptDelivery stores delivery metadata", () => {
    process.env.AO_LOG_LEVEL = "info";
    logPromptDelivery("s3", "log-test-proj", "claude", "tmux", {
      prompt: "hello",
      deliveryMethod: "post-launch",
      success: false,
      branch: "x",
      error: "boom",
    });
    const f = join(logRoot(), "log-test-proj", "x", "s3.jsonl");
    const entry = JSON.parse(readFileSync(f, "utf-8").trim());
    expect(entry.event).toBe("prompt_delivery");
    expect(entry.data.metadata?.deliveryMethod).toBe("post-launch");
    expect(entry.data.metadata?.success).toBe(false);
    expect(entry.data.metadata?.error).toBe("boom");
  });

  it("logSessionEvent writes arbitrary event name and data", () => {
    process.env.AO_LOG_LEVEL = "info";
    logSessionEvent("s4", "log-test-proj", "claude", "tmux", "custom", { a: 1 }, "b1");
    const f = join(logRoot(), "log-test-proj", "b1", "s4.jsonl");
    const entry = JSON.parse(readFileSync(f, "utf-8").trim());
    expect(entry.event).toBe("custom");
    expect(entry.data).toEqual({ a: 1 });
  });

  it("AOWorkerLogger alias delegates to named exports", () => {
    process.env.AO_LOG_LEVEL = "info";
    AOWorkerLogger.logSpawnStart("alias", "log-test-proj", "c", "t", {});
    expect(existsSync(join(logRoot(), "log-test-proj", "alias.jsonl"))).toBe(true);
  });

  it("logs mkdir failures when project path is a file (non-fatal)", () => {
    process.env.AO_LOG_LEVEL = "info";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = join(logRoot(), "log-test-proj");
    mkdirSync(logRoot(), { recursive: true });
    writeFileSync(bad, "not-a-directory");
    logSpawnStart("s5", "log-test-proj", "c", "t", { branch: "z" });
    expect(errSpy).toHaveBeenCalled();
    rmSync(bad, { force: true });
  });

  it("logs write failures when session log path is a directory", () => {
    process.env.AO_LOG_LEVEL = "info";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const proj = join(logRoot(), "log-test-proj");
    mkdirSync(proj, { recursive: true });
    const sessionPath = join(proj, "sess-file.jsonl");
    mkdirSync(sessionPath, { recursive: true });
    logSpawnStart("sess-file", "log-test-proj", "c", "t", {});
    expect(errSpy).toHaveBeenCalled();
  });
});
