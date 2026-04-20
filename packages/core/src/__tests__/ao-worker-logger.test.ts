import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AOWorkerLogger, getWorkerLogDir } from "../ao-worker-logger.js";

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

describe("AOWorkerLogger", () => {
  const originalLogLevel = process.env["AO_LOG_LEVEL"];
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    delete process.env["AO_LOG_LEVEL"];
  });

  afterEach(() => {
    if (originalLogLevel === undefined) {
      delete process.env["AO_LOG_LEVEL"];
    } else {
      process.env["AO_LOG_LEVEL"] = originalLogLevel;
    }
    consoleErrorSpy.mockRestore();
  });

  it("does not write logs unless AO_LOG_LEVEL enables worker logging", () => {
    AOWorkerLogger.logSpawnStart("ao-1", "agent-orchestrator", "codex", "tmux", {
      prompt: "fix tests",
    });

    expect(mkdirSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("sanitizes branch names in worker log paths", () => {
    expect(getWorkerLogDir("agent-orchestrator", "feat/a.b/c")).toBe(
      "/tmp/agent-orchestrator/agent-orchestrator/feat_a_b_c",
    );
  });

  it("writes session and daily summary entries for launch events", () => {
    process.env["AO_LOG_LEVEL"] = "info";

    AOWorkerLogger.logAgentLaunch("ao-2", "agent-orchestrator", "codex", "tmux", {
      branch: "feat/worker-log",
      launchCommand: "codex --yolo",
      systemPrompt: "initial prompt",
      workspacePath: "/tmp/worktree",
    });

    expect(mkdirSync).toHaveBeenCalledWith(
      "/tmp/agent-orchestrator/agent-orchestrator/feat_worker-log",
      { recursive: true },
    );
    expect(writeFileSync).toHaveBeenCalledTimes(2);

    const [sessionPath, sessionLine, sessionOptions] = vi.mocked(writeFileSync).mock.calls[0] ?? [];
    expect(sessionPath).toBe("/tmp/agent-orchestrator/agent-orchestrator/feat_worker-log/ao-2.jsonl");
    expect(sessionOptions).toEqual({ flag: "a", encoding: "utf-8" });

    const parsed = JSON.parse(String(sessionLine));
    expect(parsed).toMatchObject({
      sessionId: "ao-2",
      projectId: "agent-orchestrator",
      agentType: "codex",
      runtime: "tmux",
      event: "agent_launch",
      data: {
        branch: "feat/worker-log",
        launchCommand: "codex --yolo",
        systemPrompt: "initial prompt",
        workspacePath: "/tmp/worktree",
      },
    });

    const [summaryPath, summaryLine] = vi.mocked(writeFileSync).mock.calls[1] ?? [];
    expect(String(summaryPath)).toMatch(
      /^\/tmp\/agent-orchestrator\/agent-orchestrator\/feat_worker-log\/\d{4}-\d{2}-\d{2}-summary\.jsonl$/,
    );
    expect(summaryLine).toBe(sessionLine);
  });

  it("records prompt delivery metadata", () => {
    process.env["AO_LOG_LEVEL"] = "debug";

    AOWorkerLogger.logPromptDelivery("ao-3", "agent-orchestrator", "codex", "tmux", {
      branch: "fix/prompt",
      deliveryMethod: "post-launch",
      error: "tmux unavailable",
      prompt: "continue work",
      success: false,
    });

    const [, line] = vi.mocked(writeFileSync).mock.calls[0] ?? [];
    const parsed = JSON.parse(String(line));
    expect(parsed).toMatchObject({
      event: "prompt_delivery",
      data: {
        branch: "fix/prompt",
        metadata: {
          deliveryMethod: "post-launch",
          error: "tmux unavailable",
          success: false,
        },
        prompt: "continue work",
      },
    });
  });

  it("keeps worker spawn alive when filesystem logging fails", () => {
    process.env["AO_LOG_LEVEL"] = "info";
    vi.mocked(mkdirSync).mockImplementation(() => {
      throw new Error("readonly");
    });
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw new Error("write failed");
    });

    expect(() =>
      AOWorkerLogger.logSessionEvent(
        "ao-4",
        "agent-orchestrator",
        "codex",
        "tmux",
        "custom",
        { ok: true },
      ),
    ).not.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
