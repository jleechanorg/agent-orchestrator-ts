import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type * as ChildProcessModule from "node:child_process";
import type { SessionManager } from "@jleechanorg/ao-core";

// execFile has a util.promisify.custom symbol that makes promisify(execFile)
// resolve with {stdout, stderr}. Our mock must replicate this or promisify will
// only return the first callback argument (a bare string).
// vi.hoisted() runs before all imports, so constants must live inside it.

type ExecFileCb = (err: Error | null, stdout: string, stderr: string) => void;
type ExecFileImpl = (cmd: string, args: string[], opts: object, cb: ExecFileCb) => void;

const { mockExec } = vi.hoisted(() => {
  // Must define the symbol inside hoisted factory — it runs before module-level code.
  const PROMISIFY_CUSTOM = Symbol.for("nodejs.util.promisify.custom");
  const fn = vi.fn<Parameters<ExecFileImpl>, undefined>();
  // Attach custom promisify so promisify(fn) returns {stdout, stderr}
  (fn as Record<symbol, unknown>)[PROMISIFY_CUSTOM] = (
    cmd: string,
    args: string[],
    opts: object,
  ) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      fn(cmd, args, opts, (err, stdout, stderr) => {
        if (err !== null) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  return { mockExec: fn };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return {
    ...actual,
    execFile: mockExec,
    execFileSync: vi.fn(),
    spawn: vi.fn(),
  };
});

const { sweepOrphanWorktrees } = await import(
  "../../src/commands/lifecycle-worker.js"
);

function createMockObserver() {
  return { recordOperation: vi.fn() };
}

function makeSessionManager(activeRuntimeIds: Set<string>): SessionManager {
  const sessions = [...activeRuntimeIds].map((id) => ({ runtimeHandle: { id } }));
  return {
    list: vi.fn().mockResolvedValue(sessions),
    kill: vi.fn(),
    cleanup: vi.fn(),
    restore: vi.fn(),
    get: vi.fn(),
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    send: vi.fn(),
    claimPR: vi.fn(),
  } as unknown as SessionManager;
}

function tmuxListOutput(sessions: Array<{ name: string; activitySec?: number }>): string {
  return sessions.map((s) => `${s.name}\t${s.activitySec ?? 0}`).join("\n") + "\n";
}

describe("sweepOrphanWorktrees", () => {
  let tmpDir: string;
  let worktreeBaseDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sweep-test-"));
    worktreeBaseDir = join(tmpDir, "worktrees");
    // Default: tmux throws (unreachable) — sweepOrphanWorktrees returns early.
    // Tests that verify orphan removal call withLiveTmuxSessions() first.
    mockExec.mockImplementation((cmd, args, _opts, cb) => {
      if (cmd === "tmux" && args[0] === "list-sessions") {
        cb(new Error("tmux socket unavailable"), "", "");
        return;
      }
      cb(new Error(`unexpected exec: ${cmd} ${args.join(" ")}`), "", "");
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    mockExec.mockReset();
  });

  function mkWorktree(projectId: string, sessionId: string): string {
    const dir = join(worktreeBaseDir, projectId, sessionId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  // Provides a valid non-empty tmux response so sweepOrphanWorktrees does NOT
  // return early (avoids allTmuxSessions.length === 0 guard). Sessions with a
  // short ID that does not match the worktree being tested will not block removal.
  function withLiveTmuxSessions(sessions: Array<{ name: string }>): void {
    mockExec.mockImplementation((cmd, args, _opts, cb) => {
      if (cmd === "tmux" && args[0] === "list-sessions") {
        cb(null, tmuxListOutput(sessions), "");
        return;
      }
      if (cmd === "git" && args[0] === "worktree" && args[1] === "remove") {
        cb(null, "", "");
        return;
      }
      cb(new Error(`unexpected exec: ${cmd} ${args.join(" ")}`), "", "");
    });
  }

  it("skips non-AO-session entries (pattern guard)", async () => {
    // Valid tmux response so sweep reaches the pattern guard (not tmux-fail early return).
    withLiveTmuxSessions([{ name: "xyz-999" }]);
    const observer = createMockObserver();
    const projectId = "proj";
    mkWorktree(projectId, "not-a-session");
    mkWorktree(projectId, "worktree_backup");

    await sweepOrphanWorktrees({
      sessionManager: makeSessionManager(new Set()),
      projectId,
      allProjectIds: [projectId],
      configHash: "abc123abc123",
      worktreeBaseDir,
      observer: observer as never,
    });

    expect(mockExec).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "remove"]),
      expect.anything(),
      expect.anything(),
    );
    expect(observer.recordOperation).not.toHaveBeenCalled();
  });

  it("skips entire sweep when tmux is unreachable (fail-safe)", async () => {
    const observer = createMockObserver();
    const projectId = "proj";
    mkWorktree(projectId, "ao-1");
    mkWorktree(projectId, "jc-2");

    await sweepOrphanWorktrees({
      sessionManager: makeSessionManager(new Set()),
      projectId,
      allProjectIds: [projectId],
      configHash: "abc123abc123",
      worktreeBaseDir,
      observer: observer as never,
    });

    // tmux throws → early return → no worktree inspection, no git remove calls
    expect(mockExec).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "remove"]),
      expect.anything(),
      expect.anything(),
    );
    expect(observer.recordOperation).not.toHaveBeenCalled();
  });

  it("skips worktrees present in AO session DB (active session guard)", async () => {
    // Valid tmux response so sweep reaches the DB check (not early-return).
    withLiveTmuxSessions([{ name: "xyz-999" }]);
    const observer = createMockObserver();
    const projectId = "proj";
    mkWorktree(projectId, "ao-42");

    await sweepOrphanWorktrees({
      sessionManager: makeSessionManager(new Set(["abc123abc123-ao-42"])),
      projectId,
      allProjectIds: [projectId],
      configHash: "abc123abc123",
      worktreeBaseDir,
      observer: observer as never,
    });

    expect(mockExec).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "remove"]),
      expect.anything(),
      expect.anything(),
    );
    expect(observer.recordOperation).not.toHaveBeenCalled();
  });

  it("skips worktrees whose tmux session is alive (same config hash)", async () => {
    withLiveTmuxSessions([{ name: "abc123abc123-ao-99" }]);
    const observer = createMockObserver();
    const projectId = "proj";
    mkWorktree(projectId, "ao-99");

    await sweepOrphanWorktrees({
      sessionManager: makeSessionManager(new Set()),
      projectId,
      allProjectIds: [projectId],
      configHash: "abc123abc123",
      worktreeBaseDir,
      observer: observer as never,
    });

    expect(mockExec).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "remove"]),
      expect.anything(),
      expect.anything(),
    );
    expect(observer.recordOperation).not.toHaveBeenCalled();
  });

  it("skips worktrees with live tmux session under a DIFFERENT config hash (cross-config safety)", async () => {
    withLiveTmuxSessions([{ name: "deadbeefcafe-ao-49" }]);
    const observer = createMockObserver();
    const projectId = "proj";
    mkWorktree(projectId, "ao-49");

    await sweepOrphanWorktrees({
      sessionManager: makeSessionManager(new Set()),
      projectId,
      allProjectIds: [projectId],
      configHash: "abc123abc123",
      worktreeBaseDir,
      observer: observer as never,
    });

    expect(mockExec).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "remove"]),
      expect.anything(),
      expect.anything(),
    );
    expect(observer.recordOperation).not.toHaveBeenCalled();
  });

  it("removes worktrees absent from DB with dead tmux session (true orphan)", async () => {
    // Provide a valid tmux response with non-matching sessions so sweep proceeds.
    // The specific orphan (ao-777) has no live tmux session → removed.
    withLiveTmuxSessions([{ name: "xyz-999" }]);
    const observer = createMockObserver();
    const projectId = "proj";
    const worktreePath = mkWorktree(projectId, "ao-777");

    await sweepOrphanWorktrees({
      sessionManager: makeSessionManager(new Set()),
      projectId,
      allProjectIds: [projectId],
      configHash: "abc123abc123",
      worktreeBaseDir,
      observer: observer as never,
    });

    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "--force", worktreePath],
      expect.objectContaining({ cwd: worktreePath }),
      expect.any(Function),
    );
    expect(observer.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "lifecycle.worktree_orphan_sweep",
        data: expect.objectContaining({ orphanCount: 1, cleanedCount: 1 }),
        level: "warn",
      }),
    );
  });

  it("removes multiple orphans in a single sweep", async () => {
    // Valid tmux response with non-matching sessions so sweep proceeds.
    withLiveTmuxSessions([{ name: "xyz-999" }]);
    const observer = createMockObserver();
    const projectId = "proj";
    const w1 = mkWorktree(projectId, "ao-100");
    const w2 = mkWorktree(projectId, "jc-200");
    const w3 = mkWorktree(projectId, "ao-300");

    await sweepOrphanWorktrees({
      sessionManager: makeSessionManager(new Set()),
      projectId,
      allProjectIds: [projectId],
      configHash: "abc123abc123",
      worktreeBaseDir,
      observer: observer as never,
    });

    const removedPaths = mockExec.mock.calls
      .filter(([cmd, args]) => cmd === "git" && args[1] === "remove")
      .map(([, args]) => args[4]);
    expect(removedPaths).toHaveLength(3);
    expect(removedPaths).toContain(w1);
    expect(removedPaths).toContain(w2);
    expect(removedPaths).toContain(w3);
    expect(observer.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orphanCount: 3, cleanedCount: 3 }),
      }),
    );
  });

  it("continues after a failed git worktree remove (best-effort)", async () => {
    // Note: custom mock below handles tmux (returns xyz-999) and git remove (fails for w1).
    const observer = createMockObserver();
    const projectId = "proj";
    const w1 = mkWorktree(projectId, "ao-1");
    mkWorktree(projectId, "ao-2");
    mkWorktree(projectId, "ao-3");

    mockExec.mockImplementation((cmd, args, _opts, cb) => {
      if (cmd === "tmux" && args[0] === "list-sessions") {
        // Return xyz-999 so sweep does NOT return early (liveSessionIds = {xyz-999}).
        cb(null, "xyz-999\t0\n", "");
        return;
      }
      if (cmd === "git" && args[0] === "worktree" && args[1] === "remove") {
        const path = args[4];
        if (path === w1) {
          cb(new Error("git permission denied"), "", "");
        } else {
          cb(null, "", "");
        }
        return;
      }
      cb(new Error(`unexpected exec: ${cmd} ${args.join(" ")}`), "", "");
    });

    await sweepOrphanWorktrees({
      sessionManager: makeSessionManager(new Set()),
      projectId,
      allProjectIds: [projectId],
      configHash: "abc123abc123",
      worktreeBaseDir,
      observer: observer as never,
    });

    const removeCalls = mockExec.mock.calls.filter(
      ([cmd, args]) => cmd === "git" && args[1] === "remove",
    );
    expect(removeCalls).toHaveLength(3);
    expect(observer.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orphanCount: 3, cleanedCount: 2 }),
        outcome: "success",
      }),
    );
  });

  it("does nothing when worktree dir does not exist", async () => {
    // Valid tmux response so sweep reaches readdirSync for nonexistent-project dir.
    withLiveTmuxSessions([{ name: "xyz-999" }]);
    const observer = createMockObserver();

    await sweepOrphanWorktrees({
      sessionManager: makeSessionManager(new Set()),
      projectId: "nonexistent-project",
      allProjectIds: ["nonexistent-project"],
      configHash: "abc123abc123",
      worktreeBaseDir,
      observer: observer as never,
    });

    expect(mockExec).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "remove"]),
      expect.anything(),
      expect.anything(),
    );
    expect(observer.recordOperation).not.toHaveBeenCalled();
  });

  it("only removes orphans — skips DB-tracked and non-matching entries", async () => {
    // Valid tmux response with sessions that match DB entries (ao-2, jc-3).
    withLiveTmuxSessions([{ name: "abc123abc123-ao-2" }, { name: "abc123abc123-jc-3" }]);
    const observer = createMockObserver();
    const projectId = "proj";
    const orphanPath = mkWorktree(projectId, "ao-1");
    mkWorktree(projectId, "ao-2");
    mkWorktree(projectId, "jc-3");
    mkWorktree(projectId, "backup_old");
    mkWorktree(projectId, "review_pr");

    await sweepOrphanWorktrees({
      sessionManager: makeSessionManager(new Set(["abc123abc123-ao-2", "abc123abc123-jc-3"])),
      projectId,
      allProjectIds: [projectId],
      configHash: "abc123abc123",
      worktreeBaseDir,
      observer: observer as never,
    });

    const removeCalls = mockExec.mock.calls.filter(
      ([cmd, args]) => cmd === "git" && args[1] === "remove",
    );
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0][1][4]).toBe(orphanPath);
  });
});
