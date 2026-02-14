import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { mockTmux, mockExec, mockGh, mockConfigRef } = vi.hoisted(() => ({
  mockTmux: vi.fn(),
  mockExec: vi.fn(),
  mockGh: vi.fn(),
  mockConfigRef: { current: null as Record<string, unknown> | null },
}));

vi.mock("../../src/lib/shell.js", () => ({
  tmux: mockTmux,
  exec: mockExec,
  execSilent: vi.fn(),
  git: vi.fn(),
  gh: mockGh,
  getTmuxSessions: async () => {
    const output = await mockTmux("list-sessions", "-F", "#{session_name}");
    if (!output) return [];
    return output.split("\n").filter(Boolean);
  },
  getTmuxActivity: vi.fn().mockResolvedValue(null),
}));

vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: "",
  }),
}));

vi.mock("@composio/ao-core", () => ({
  loadConfig: () => mockConfigRef.current,
}));

let tmpDir: string;

import { Command } from "commander";
import { registerReviewCheck } from "../../src/commands/review-check.js";

let program: Command;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-review-test-"));

  mockConfigRef.current = {
    dataDir: tmpDir,
    worktreeDir: join(tmpDir, "worktrees"),
    port: 3000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: join(tmpDir, "main-repo"),
        defaultBranch: "main",
        sessionPrefix: "app",
      },
    },
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  } as Record<string, unknown>;

  program = new Command();
  program.exitOverride();
  registerReviewCheck(program);
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  mockTmux.mockReset();
  mockExec.mockReset();
  mockGh.mockReset();
  mockExec.mockResolvedValue({ stdout: "", stderr: "" });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("review-check command", () => {
  it("reports no pending reviews when none exist", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "app-1"),
      "branch=feat/fix\npr=https://github.com/org/my-app/pull/10\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      return null;
    });

    // All threads resolved, no changes requested
    mockGh.mockResolvedValue(
      JSON.stringify({
        reviewDecision: "APPROVED",
        reviewThreads: { nodes: [{ isResolved: true }] },
      }),
    );

    await program.parseAsync(["node", "test", "review-check"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No pending review comments");
  });

  it("finds sessions with pending review comments", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "app-1"),
      "branch=feat/fix\npr=https://github.com/org/my-app/pull/10\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      return null;
    });

    mockGh.mockResolvedValue(
      JSON.stringify({
        reviewDecision: "CHANGES_REQUESTED",
        reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }] },
      }),
    );

    await program.parseAsync(["node", "test", "review-check", "--dry-run"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("app-1");
    expect(output).toContain("PR #10");
    expect(output).toContain("CHANGES_REQUESTED");
    expect(output).toContain("dry run");
  });

  it("skips sessions without PR metadata", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "app-1"), "branch=feat/fix\nstatus=working\n");

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      return null;
    });

    await program.parseAsync(["node", "test", "review-check"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No pending review comments");
    // gh should never be called since there's no PR
    expect(mockGh).not.toHaveBeenCalled();
  });

  it("skips sessions with non-matching prefix", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "other-1"),
      "branch=feat/fix\npr=https://github.com/org/my-app/pull/10\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "other-1";
      return null;
    });

    await program.parseAsync(["node", "test", "review-check"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No pending review comments");
  });

  it("sends fix prompt when not in dry-run mode", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "app-1"),
      "branch=feat/fix\npr=https://github.com/org/my-app/pull/10\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      return null;
    });

    mockGh.mockResolvedValue(
      JSON.stringify({
        reviewDecision: null,
        reviewThreads: { nodes: [{ isResolved: false }] },
      }),
    );

    await program.parseAsync(["node", "test", "review-check"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Fix prompt sent");

    // Should have sent C-c, C-u, message, Enter
    expect(mockExec).toHaveBeenCalledWith("tmux", ["send-keys", "-t", "app-1", "C-c"]);
    expect(mockExec).toHaveBeenCalledWith("tmux", ["send-keys", "-t", "app-1", "C-u"]);
    expect(mockExec).toHaveBeenCalledWith("tmux", [
      "send-keys",
      "-t",
      "app-1",
      "-l",
      expect.stringContaining("review comments"),
    ]);
    expect(mockExec).toHaveBeenCalledWith("tmux", ["send-keys", "-t", "app-1", "Enter"]);
  });

  it("handles gh returning null (API failure)", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "app-1"),
      "branch=feat/fix\npr=https://github.com/org/my-app/pull/10\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      return null;
    });

    mockGh.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "review-check"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No pending review comments");
  });

  it("handles malformed GraphQL response gracefully", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "app-1"),
      "branch=feat/fix\npr=https://github.com/org/my-app/pull/10\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      return null;
    });

    mockGh.mockResolvedValue("not valid json {{{");

    await program.parseAsync(["node", "test", "review-check"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No pending review comments");
  });

  it("rejects unknown project ID", async () => {
    await expect(
      program.parseAsync(["node", "test", "review-check", "nonexistent"]),
    ).rejects.toThrow("process.exit(1)");
  });
});
