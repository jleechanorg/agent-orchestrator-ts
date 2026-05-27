import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toClaudeProjectPath, create, resetWarnedReaddirPaths, resetPsCache } from "../index.js";
import {
  classifyTerminalOutput,
  findLatestSessionFile,
  getClaudeActivityState,
  isClaudeProcessAlive,
} from "../activity-detection.js";
import type { Session, RuntimeHandle, ProcessProbeResult } from "@jleechanorg/ao-core";

// Mock homedir() so getActivityState looks in our temp dir
vi.mock("node:os", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    homedir: () => _fakeHome,
  };
});

let _fakeHome: string;
let workspacePath: string;
let projectDir: string;

function makeSession(overrides: Partial<Session> = {}): Session {
  const handle: RuntimeHandle = { id: "test-1", runtimeName: "tmux", data: {} };
  return {
    id: "test-1",
    projectId: "test",
    status: "working",
    activity: "idle",
    branch: "main",
    issueId: null,
    pr: null,
    workspacePath,
    runtimeHandle: handle,
    agentInfo: null,
    createdAt: new Date(0),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function writeJsonl(
  entries: Array<{ type: string; subtype?: string; level?: string; [key: string]: unknown }>,
  ageMs = 0,
  filename = "session-abc.jsonl",
): void {
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const filePath = join(projectDir, filename);
  writeFileSync(filePath, content);
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs);
    utimesSync(filePath, past, past);
  }
}

function writeActivityLog(state: string): void {
  const aoDir = join(workspacePath, ".ao");
  mkdirSync(aoDir, { recursive: true });
  const logPath = join(aoDir, "activity.jsonl");
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    state,
    source: "terminal",
  });
  const existing = existsSync(logPath)
    ? readFileSync(logPath, "utf-8")
    : "";
  writeFileSync(logPath, existing + entry + "\n");
}

function writeActivityLogWithSource(state: string, source: string, trigger?: string): void {
  const aoDir = join(workspacePath, ".ao");
  mkdirSync(aoDir, { recursive: true });
  const logPath = join(aoDir, "activity.jsonl");
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    state,
    source,
    ...(trigger ? { trigger } : {}),
  });
  const existing = existsSync(logPath)
    ? readFileSync(logPath, "utf-8")
    : "";
  writeFileSync(logPath, existing + entry + "\n");
}

// =============================================================================
// toClaudeProjectPath
// =============================================================================

describe("Claude Code Activity Detection", () => {
  describe("toClaudeProjectPath", () => {
    it("encodes paths with leading dash", () => {
      expect(toClaudeProjectPath("/Users/dev/.worktrees/ao")).toBe("-Users-dev--worktrees-ao");
    });

    it("preserves leading slash as leading dash", () => {
      expect(toClaudeProjectPath("/tmp/test")).toBe("-tmp-test");
    });

    it("replaces dots with dashes", () => {
      expect(toClaudeProjectPath("/path/to/.hidden")).toBe("-path-to--hidden");
    });

    it("handles Windows paths — colon maps to dash", () => {
      expect(toClaudeProjectPath("C:\\Users\\dev\\project")).toBe("C--Users-dev-project");
    });

    it("handles consecutive dots and slashes", () => {
      // /a/../b/./c → -a-  -- -b- - -c → -a----b---c
      expect(toClaudeProjectPath("/a/../b/./c")).toBe("-a----b---c");
    });

    it("handles paths with multiple dot-directories", () => {
      expect(toClaudeProjectPath("/Users/dev/.config/.local/share")).toBe(
        "-Users-dev--config--local-share",
      );
    });
  });

  // =============================================================================
  // getActivityState — integration tests with real JSONL files on disk
  // =============================================================================

  describe("getActivityState", () => {
    const agent = create();

    beforeEach(() => {
      // realpathSync because /var/folders/... is a symlink to /private/var/folders/...
      // on macOS. resolveWorkspaceForClaude resolves symlinks before slugifying (so the
      // slug matches what Claude wrote), so the test setup must do the same — otherwise
      // the test JSONL lives under one slug and the code looks under another.
      _fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "ao-activity-test-")));
      workspacePath = join(_fakeHome, "workspace");
      mkdirSync(workspacePath, { recursive: true });

      // Create the Claude project directory matching the workspace path
      const encoded = toClaudeProjectPath(workspacePath);
      projectDir = join(_fakeHome, ".claude", "projects", encoded);
      mkdirSync(projectDir, { recursive: true });

      // Mock isProcessRunning to always return true (we test exited separately)
      vi.spyOn(agent, "isProcessRunning").mockResolvedValue(true);

      // Reset module-level warn dedupe so each test starts fresh.
      resetWarnedReaddirPaths();
    });

    afterEach(() => {
      rmSync(_fakeHome, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    // -----------------------------------------------------------------------
    // Process / handle edge cases
    // -----------------------------------------------------------------------

    it("returns 'exited' when process is not running", async () => {
      vi.spyOn(agent, "isProcessRunning").mockResolvedValue(false);
      writeJsonl([{ type: "assistant" }]);
      expect((await agent.getActivityState(makeSession()))?.state).toBe("exited");
    });

    it("returns 'exited' when no runtimeHandle", async () => {
      expect((await agent.getActivityState(makeSession({ runtimeHandle: undefined })))?.state).toBe(
        "exited",
      );
    });

    it("returns 'exited' when runtimeHandle is null", async () => {
      expect((await agent.getActivityState(makeSession({ runtimeHandle: null })))?.state).toBe("exited");
    });

    // -----------------------------------------------------------------------
    // Fallback cases (no JSONL data available)
    // -----------------------------------------------------------------------

    it("returns null when no session file exists yet", async () => {
      // projectDir exists but is empty — no .jsonl files
      expect(await agent.getActivityState(makeSession())).toBeNull();
    });

    it("returns null when no workspacePath", async () => {
      expect(await agent.getActivityState(makeSession({ workspacePath: null }))).toBeNull();
    });

    it("logs a warning when ~/.claude/projects/<dir> is unreadable (EACCES)", async () => {
      const { chmodSync } = await import("node:fs");
      chmodSync(projectDir, 0o000);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = await agent.getActivityState(makeSession());
        expect(result).toBeNull();
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0]?.[0]).toMatch(/failed to read.*(?:EACCES|EPERM)/);
      } finally {
        chmodSync(projectDir, 0o755);
        warn.mockRestore();
      }
    });

    it("only warns ONCE per path across multiple polls (no log flood)", async () => {
      const { chmodSync } = await import("node:fs");
      chmodSync(projectDir, 0o000);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await agent.getActivityState(makeSession());
        await agent.getActivityState(makeSession());
        await agent.getActivityState(makeSession());
        expect(warn).toHaveBeenCalledOnce();
      } finally {
        chmodSync(projectDir, 0o755);
        warn.mockRestore();
      }
    });

    it("does NOT log when project dir simply doesn't exist (ENOENT is normal)", async () => {
      const badPath = join(_fakeHome, "this-workspace-never-existed");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await agent.getActivityState(makeSession({ workspacePath: badPath }));
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it("prefers UUID-named JSONL when session.metadata.claudeSessionUuid is set", async () => {
      const myUuid = "aaa-111";
      writeJsonl([{ type: "progress", status: "doing other work" }], 0, "bbb-222.jsonl");
      writeJsonl(
        [{ type: "assistant", message: { content: "my session" } }],
        10_000,
        `${myUuid}.jsonl`,
      );

      const session = makeSession({ metadata: { claudeSessionUuid: myUuid } });
      const result = await agent.getActivityState(session);
      expect(result?.state).toBe("ready");
    });

    it("prefers UUID-named JSONL when session.agentInfo.metadata.claudeSessionUuid is set", async () => {
      const myUuid = "ccc-333";
      writeJsonl([{ type: "progress", status: "doing other work" }], 0, "ddd-444.jsonl");
      writeJsonl(
        [{ type: "assistant", message: { content: "my session" } }],
        10_000,
        `${myUuid}.jsonl`,
      );

      const session = makeSession({ metadata: {}, agentInfo: { name: "claude-code", plugin: "agent-claude-code", metadata: { claudeSessionUuid: myUuid } } });
      const result = await agent.getActivityState(session);
      expect(result?.state).toBe("ready");
    });

    it("falls back to newest-mtime when UUID-named file doesn't exist yet", async () => {
      writeJsonl([{ type: "user", message: { content: "hi" } }], 0, "actual-session.jsonl");

      const session = makeSession({ metadata: { claudeSessionUuid: "uuid-that-doesnt-exist" } });
      const result = await agent.getActivityState(session);
      expect(result?.state).toBe("active");
    });

    it("resolves symlinked workspace paths so slugs match what Claude wrote", async () => {
      const { symlinkSync } = await import("node:fs");
      const target = workspacePath;
      const link = join(_fakeHome, "symlinked-workspace");
      symlinkSync(target, link);

      writeJsonl([{ type: "assistant", message: { content: "Done!" } }]);

      const result = await agent.getActivityState(makeSession({ workspacePath: link }));
      expect(result?.state).toBe("ready");
    });

    it("returns null when project directory does not exist and AO activity is unavailable", async () => {
      const badPath = join(_fakeHome, "nonexistent-workspace");
      expect(await agent.getActivityState(makeSession({ workspacePath: badPath }))).toBeNull();
    });

    // -----------------------------------------------------------------------
    // Real Claude Code entry types (observed in production)
    // -----------------------------------------------------------------------

    describe("real Claude Code entry types", () => {
      it("returns 'active' for recent 'progress' entry (streaming)", async () => {
        writeJsonl([{ type: "progress", status: "running tool" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("active");
      });

      it("returns 'active' for recent 'user' entry", async () => {
        writeJsonl([{ type: "user", message: { content: "fix the bug" } }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("active");
      });

      it("returns 'ready' for recent 'assistant' entry", async () => {
        writeJsonl([{ type: "assistant", message: { content: "Done!" } }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("returns 'ready' for recent 'system' entry", async () => {
        writeJsonl([{ type: "system", summary: "session started" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("returns 'blocked' for 'system' api_error (level: error)", async () => {
        writeJsonl([
          {
            type: "system",
            subtype: "api_error",
            level: "error",
            cause: { code: "ConnectionRefused" },
          },
        ]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("blocked");
      });

      it("returns 'ready' for non-error 'system' subtypes (compact_boundary)", async () => {
        writeJsonl([{ type: "system", subtype: "compact_boundary", level: "info" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("requires BOTH api_error subtype AND error level for 'blocked'", async () => {
        writeJsonl([{ type: "system", subtype: "future_diagnostic", level: "error" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("returns 'ready' for recent 'file-history-snapshot' (bookkeeping)", async () => {
        writeJsonl([{ type: "file-history-snapshot" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("returns 'ready' for recent 'queue-operation' (bookkeeping)", async () => {
        writeJsonl([{ type: "queue-operation" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("returns 'idle' (not 'ready') for recent 'pr-link' — re-snapshot noise", async () => {
        writeJsonl([
          {
            type: "pr-link",
            prNumber: 1911,
            prUrl: "https://github.com/owner/repo/pull/1911",
          },
        ]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });

      it("falls back to AO JSONL waiting_input when native session lookup is unavailable", async () => {
        // Simulate hook-sourced waiting_input entry (#1941)
        writeActivityLogWithSource("waiting_input", "hook", "PermissionRequest (Bash)");

        expect((await agent.getActivityState(makeSession()))?.state).toBe("waiting_input");
      });

      it("falls back to AO JSONL waiting_input when native session entry predates this session", async () => {
        writeJsonl([{ type: "assistant", message: { content: "Previous session done" } }], 120_000);
        const session = makeSession({ createdAt: new Date() });

        // Simulate hook-sourced waiting_input entry (#1941)
        writeActivityLogWithSource("waiting_input", "hook", "PermissionRequest");

        expect((await agent.getActivityState(session))?.state).toBe("waiting_input");
      });

      it("returns idle for stale native session entry when AO JSONL is unavailable", async () => {
        writeJsonl([{ type: "assistant", message: { content: "Previous session done" } }], 120_000);
        const session = makeSession({ createdAt: new Date() });

        const result = await agent.getActivityState(session);

        expect(result?.state).toBe("idle");
        expect(result?.timestamp).toBe(session.createdAt);
      });

      it("returns 'ready' for recent 'attachment' (bookkeeping)", async () => {
        writeJsonl([{ type: "attachment", attachment: { type: "skill_listing" } }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("returns 'idle' (not 'ready') for recent permission-mode noise — dormant session", async () => {
        writeJsonl([{ type: "permission-mode", permissionMode: "bypassPermissions" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });

      it("returns 'idle' (not 'ready') for recent ai-title noise — dormant session", async () => {
        writeJsonl([{ type: "ai-title", title: "Fix login bug" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });

      it("returns 'idle' for agent-color / agent-name / custom-title noise", async () => {
        writeJsonl([{ type: "agent-color", color: "#fff" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
        writeJsonl([{ type: "agent-name", name: "ao-161" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
        writeJsonl([{ type: "custom-title", title: "x" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });

      it("noise last entry yields to AO JSONL when AO has actionable state", async () => {
        writeJsonl([{ type: "permission-mode" }]);
        writeActivityLog("waiting_input");
        expect((await agent.getActivityState(makeSession()))?.state).toBe("waiting_input");
      });
    });

    // -----------------------------------------------------------------------
    // Agent interface spec types (may appear in future versions)
    // -----------------------------------------------------------------------

    describe("agent interface spec types", () => {
      it("returns 'ready' for recent 'summary' entry", async () => {
        writeJsonl([{ type: "summary", summary: "Implemented login feature" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("unknown types fall through to default branch — fresh → active", async () => {
        writeJsonl([{ type: "some-future-claude-type" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("active");
      });
    });

    // -----------------------------------------------------------------------
    // Staleness / threshold behavior
    // -----------------------------------------------------------------------

    describe("staleness threshold", () => {
      it("returns 'idle' for stale 'assistant' entry (> threshold)", async () => {
        writeJsonl([{ type: "assistant" }], 400_000); // 6+ min old
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });

      it("returns 'idle' for stale 'user' entry (> threshold)", async () => {
        writeJsonl([{ type: "user" }], 400_000);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });

      it("returns 'idle' for stale 'progress' entry (> threshold)", async () => {
        writeJsonl([{ type: "progress" }], 400_000);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });

      it("returns 'idle' for stale bookkeeping entry (> threshold)", async () => {
        writeJsonl([{ type: "file-history-snapshot" }], 400_000);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });

      it("permission_request falls to default branch — fresh → active (#1927 dead case removal)", async () => {
        writeJsonl([{ type: "permission_request" }], 400_000);
        // Claude never emits permission_request as a JSONL type (#1927).
        // Falls through to default: stale → idle.
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });

      it("'error' falls to default branch — stale → idle (#1927 dead case removal)", async () => {
        writeJsonl([{ type: "error" }], 400_000);
        // Claude never emits top-level 'error' as a JSONL type (#1927).
        // Falls through to default: stale → idle.
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });

      it("respects custom readyThresholdMs", async () => {
        // 2 minutes old — stale with 60s threshold, ready with default 5min
        writeJsonl([{ type: "assistant" }], 120_000);

        expect((await agent.getActivityState(makeSession(), 60_000))?.state).toBe("idle");
        expect((await agent.getActivityState(makeSession(), 300_000))?.state).toBe("ready");
      });

      it("custom threshold applies to active types too", async () => {
        // 90 seconds old — past 30s native active window, within 300s threshold → ready
        writeJsonl([{ type: "user" }], 90_000);

        expect((await agent.getActivityState(makeSession(), 60_000))?.state).toBe("idle");
        expect((await agent.getActivityState(makeSession(), 300_000))?.state).toBe("ready");
      });

      it("native active window: progress goes active→ready→idle", async () => {
        // Recent entry (< 30s) → active
        writeJsonl([{ type: "progress" }], 10_000);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("active");

        // Past active window (30s) but under threshold → ready
        writeJsonl([{ type: "progress" }], 60_000);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");

        // Past threshold → idle
        writeJsonl([{ type: "progress" }], 400_000);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });
    });

    // -----------------------------------------------------------------------
    // JSONL file selection
    // -----------------------------------------------------------------------

    describe("JSONL file selection", () => {
      it("picks the most recently modified JSONL file", async () => {
        // Write an older file with "assistant" and a newer file with "user"
        writeJsonl([{ type: "assistant" }], 10_000, "old-session.jsonl");
        writeJsonl([{ type: "user" }], 0, "new-session.jsonl");

        expect((await agent.getActivityState(makeSession()))?.state).toBe("active");
      });

      it("ignores agent- prefixed JSONL files", async () => {
        writeJsonl([{ type: "user" }], 0, "agent-toolkit.jsonl");
        // No real session file → returns null (cannot determine activity)
        expect(await agent.getActivityState(makeSession())).toBeNull();
      });

      it("reads last entry from multi-entry JSONL (not first)", async () => {
        // First entry is user (active), last entry is assistant (ready)
        writeJsonl([
          { type: "user", message: { content: "fix bug" } },
          { type: "progress", status: "thinking" },
          { type: "assistant", message: { content: "Done!" } },
        ]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("returns null for empty JSONL file", async () => {
        writeFileSync(join(projectDir, "empty-session.jsonl"), "");
        expect(await agent.getActivityState(makeSession())).toBeNull();
      });

      it("returns null for JSONL with only whitespace", async () => {
        writeFileSync(join(projectDir, "whitespace-session.jsonl"), "\n\n  \n");
        // All lines are whitespace — readLastJsonlEntry returns null
        expect(await agent.getActivityState(makeSession())).toBeNull();
      });

      it("ignores non-JSONL files in project directory", async () => {
        // Write a non-JSONL file
        writeFileSync(join(projectDir, "config.json"), '{"type": "user"}');
        writeFileSync(join(projectDir, "notes.txt"), "some notes");
        // Write actual JSONL
        writeJsonl([{ type: "assistant" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });
    });

    // -----------------------------------------------------------------------
    // Realistic session sequences
    // -----------------------------------------------------------------------

    describe("realistic session sequences", () => {
      it("detects agent mid-work (progress is last entry)", async () => {
        writeJsonl([
          { type: "user", message: { content: "implement auth" } },
          { type: "assistant", message: { content: "I'll implement..." } },
          { type: "progress", status: "Reading file" },
          { type: "progress", status: "Writing file" },
          { type: "progress", status: "Running tool" },
        ]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("active");
      });

      it("detects agent done and waiting (assistant is last entry)", async () => {
        writeJsonl([
          { type: "user", message: { content: "implement auth" } },
          { type: "progress", status: "thinking" },
          { type: "progress", status: "writing" },
          { type: "assistant", message: { content: "I've implemented the auth feature." } },
        ]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("detects agent done with system summary", async () => {
        writeJsonl([
          { type: "user", message: { content: "fix tests" } },
          { type: "progress", status: "thinking" },
          { type: "assistant", message: { content: "Fixed!" } },
          { type: "system", summary: "Fixed failing tests" },
        ]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("detects stale finished session", async () => {
        writeJsonl(
          [
            { type: "user", message: { content: "implement auth" } },
            { type: "assistant", message: { content: "Done" } },
          ],
          600_000, // 10 min old
        );
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });
    });
  });
});
