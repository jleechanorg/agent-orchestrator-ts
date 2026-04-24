import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProjectConfig, WorkspaceCreateConfig, WorkspaceInfo } from "@jleechanorg/ao-core";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import that uses the mocked modules
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  // Set custom promisify so `promisify(execFile)` returns { stdout, stderr }
  (mockExecFile as any)[Symbol.for("nodejs.util.promisify.custom")] = vi.fn();
  return { execFile: mockExecFile };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
  symlinkSync: vi.fn(),
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: () => "/mock-home",
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import * as childProcess from "node:child_process";
import { existsSync, lstatSync, symlinkSync, rmSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { create, manifest } from "../index.js";

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockExecFileAsync = (childProcess.execFile as any)[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockLstatSync = lstatSync as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;
const mockSymlinkSync = symlinkSync as ReturnType<typeof vi.fn>;
const mockRmSync = rmSync as ReturnType<typeof vi.fn>;
const mockMkdirSync = mkdirSync as ReturnType<typeof vi.fn>;
const mockReaddirSync = readdirSync as ReturnType<typeof vi.fn>;
const mockReadFile = fsPromises.readFile as ReturnType<typeof vi.fn>;
const mockWriteFile = fsPromises.writeFile as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockGitSuccess(stdout: string) {
  mockExecFileAsync.mockResolvedValueOnce({ stdout: stdout + "\n", stderr: "" });
}

function mockGitError(message: string) {
  mockExecFileAsync.mockRejectedValueOnce(new Error(message));
}

/**
 * Per-test git mock using mockImplementation. Decides outcome by call arguments (not queue position),
 * so unmocked calls succeed with empty stdout.
 *
 * Keys are "cmd,arg1,arg2,(cwd=/path)" — the (cwd=...) token is appended when
 * git() is called with a cwd option (it always is for repo-path git calls).
 */
type GitCallResult = { stdout?: string; stderr?: string } | Error;
function mockGitImpl(calls: Record<string, GitCallResult>): void {
  mockExecFileAsync.mockImplementation((cmd: string, args: string[], opts?: { cwd?: string }) => {
    const key = [cmd, ...args, opts?.cwd ? `(cwd=${opts.cwd})` : ""].join(",");
    const result = calls[key];
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve({ stdout: (result?.stdout ?? "") + "\n", stderr: result?.stderr ?? "" });
  });
}

function makeProject(overrides?: Partial<ProjectConfig>): ProjectConfig {
  return {
    name: "test-project",
    repo: "test/repo",
    path: "/repo/path",
    defaultBranch: "main",
    sessionPrefix: "test",
    ...overrides,
  };
}

function makeCreateConfig(overrides?: Partial<WorkspaceCreateConfig>): WorkspaceCreateConfig {
  return {
    projectId: "myproject",
    project: makeProject(),
    sessionId: "session-1",
    branch: "feat/TEST-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Use resetAllMocks (not clearAllMocks) to also drain the mock implementation
  // queue — clearAllMocks only resets call history, leaving mockReturnValueOnce /
  // mockResolvedValueOnce values in the queue and causing cross-test contamination.
  vi.resetAllMocks();

  // Default: no existing exclude file, writes succeed.
  // Re-apply after resetAllMocks since it clears mockReturnValue / mockResolvedValue.
  mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  mockWriteFile.mockResolvedValue(undefined);
  // Re-apply lstatSync mock so setupAoManagedExclude fallback path (lstatSync +
  // readFileSync on .git file) works in tests that exercise it.
  mockLstatSync.mockImplementation((p) => ({
    isFile: () => String(p).endsWith(".git") || String(p).endsWith(".git/info"),
    isDirectory: () => false,
  }));
  // Default: paths exist (return true). Tests that need the missing-path unlock path
  // (bd-206 "stale locked worktree" scenario) should override this via
  // mockExistsSync.mockReturnValueOnce(false) or mockImplementation.
  mockExistsSync.mockReturnValue(true);
});

// ===========================================================================
// Tests
// ===========================================================================

describe("manifest", () => {
  it("has name 'worktree' and slot 'workspace'", () => {
    expect(manifest.name).toBe("worktree");
    expect(manifest.slot).toBe("workspace");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe("Workspace plugin: git worktrees");
  });
});

describe("create() factory", () => {
  it("uses ~/.worktrees as default base dir", async () => {
    const ws = create();

    // Mock: fetch, for-each-ref (unambiguous), worktree add
    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // git branch --list origin/main — no local conflict
    mockGitSuccess(""); // worktree add

    const info = await ws.create(makeCreateConfig());

    expect(info.path).toBe("/mock-home/.worktrees/myproject/session-1");
  });

  it("uses custom worktreeDir from config", async () => {
    const ws = create({ worktreeDir: "/custom/worktrees" });

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // git branch --list origin/main — no local conflict
    mockGitSuccess(""); // worktree add

    const info = await ws.create(makeCreateConfig());

    expect(info.path).toBe("/custom/worktrees/myproject/session-1");
  });

  it("expands tilde in custom worktreeDir", async () => {
    const ws = create({ worktreeDir: "~/custom-path" });

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // git branch --list origin/main — no local conflict
    mockGitSuccess(""); // worktree add

    const info = await ws.create(makeCreateConfig());

    expect(info.path).toBe("/mock-home/custom-path/myproject/session-1");
  });
});

describe("workspace.create()", () => {
  it("calls git fetch and git worktree add with correct args", async () => {
    const ws = create();

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // git branch --list origin/main — no local conflict
    mockGitSuccess(""); // worktree add

    await ws.create(makeCreateConfig());

    // First call: git fetch origin --quiet
    expect(mockExecFileAsync).toHaveBeenCalledWith("git", ["fetch", "origin", "--quiet"], {
      cwd: "/repo/path",
    });

    // Second call: git worktree add -b <branch> <path> <baseRef>
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      [
        "worktree",
        "add",
        "-b",
        "feat/TEST-1",
        "/mock-home/.worktrees/myproject/session-1",
        "origin/main",
      ],
      { cwd: "/repo/path" },
    );
  });

  it("creates the project worktree directory", async () => {
    const ws = create();

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // git branch --list origin/main — no local conflict
    mockGitSuccess(""); // worktree add

    await ws.create(makeCreateConfig());

    expect(mockMkdirSync).toHaveBeenCalledWith("/mock-home/.worktrees/myproject", {
      recursive: true,
    });
  });

  it("continues when fetch fails (offline)", async () => {
    const ws = create();

    mockGitError("Could not resolve host"); // fetch fails
    mockGitSuccess(""); // git branch --list origin/main — no local conflict
    mockGitSuccess(""); // worktree add succeeds

    const info = await ws.create(makeCreateConfig());

    expect(info.path).toBe("/mock-home/.worktrees/myproject/session-1");
  });

  it("handles branch already exists by adding worktree then checking out", async () => {
    const ws = create();
    const worktreePath = "/mock-home/.worktrees/myproject/session-1";

    // Node.js execFile error format: command string + git stderr.
    // worktreePath appears in the command portion but NOT in the path-collision format.
    const branchCollisionError = `Command failed: git worktree add -b feat/TEST-1 ${worktreePath} origin/main\nfatal: A branch named 'feat/TEST-1' already exists.`;

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // git branch --list origin/main — no local conflict
    mockGitError(branchCollisionError); // worktree add -b fails with branch collision
    mockGitSuccess(""); // git worktree list --porcelain (ghost check — worktreePath not registered)
    mockGitSuccess(""); // worktree add (without -b) succeeds
    mockGitSuccess(""); // checkout succeeds

    const info = await ws.create(makeCreateConfig());

    // Third call: worktree add without -b
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "/mock-home/.worktrees/myproject/session-1", "origin/main"],
      { cwd: "/repo/path" },
    );

    // Fourth call: checkout
    expect(mockExecFileAsync).toHaveBeenCalledWith("git", ["checkout", "feat/TEST-1"], {
      cwd: "/mock-home/.worktrees/myproject/session-1",
    });

    expect(info.branch).toBe("feat/TEST-1");
  });

  it("does NOT misclassify branch collision as ghost when worktreePath appears in command string", async () => {
    // Regression: Node.js execFile includes the full command string in the error message.
    // When branch collision occurs, worktreePath appears in the command but NOT in the
    // path-collision format ('<path>' already exists). The code must NOT treat this as ghost.
    const ws = create();
    const worktreePath = "/mock-home/.worktrees/myproject/session-1";

    // Realistic Node.js execFile error format for branch collision:
    // - worktreePath appears in the command string (would trigger the old msg.includes(worktreePath) check)
    // - git stderr says "branch named X already exists" (NOT path collision)
    const branchCollisionError =
      `Command failed: git worktree add -b feat/TEST-1 ${worktreePath} origin/main\n` +
      `fatal: A branch named 'feat/TEST-1' already exists.`;

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // git branch --list origin/main — no local conflict
    mockGitError(branchCollisionError); // worktree add -b fails
    // worktree list: path not registered (ghost check returns false for isRegistered)
    // The NEW check: msg.includes(`'${worktreePath}' already exists`) → FALSE (no path-collision format)
    // → isGhostWorktree stays false → branch-exists recovery path taken
    mockGitSuccess(""); // git worktree list --porcelain (worktree not registered)
    mockGitSuccess(""); // worktree add (without -b) succeeds
    mockGitSuccess(""); // checkout succeeds

    const info = await ws.create(makeCreateConfig());

    // Verify: we went through branch-exists recovery, NOT ghost recovery
    // (ghost would use rmSync, branch-exists uses git worktree add without -b)
    expect(mockRmSync).not.toHaveBeenCalled();
    expect(info.branch).toBe("feat/TEST-1");
    expect(info.path).toBe(worktreePath);
  });

  it("cleans up worktree on checkout failure", async () => {
    const ws = create();

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // git branch --list origin/main — no local conflict
    mockGitError("already exists"); // worktree add -b fails
    mockGitSuccess(""); // worktree list --porcelain (ghost check)
    mockGitSuccess(""); // worktree add (without -b)
    mockGitError("checkout failed: conflict"); // checkout fails
    mockGitSuccess(""); // worktree remove (cleanup)

    await expect(ws.create(makeCreateConfig())).rejects.toThrow(
      'Failed to checkout branch "feat/TEST-1" in worktree: checkout failed: conflict',
    );

    // Verify cleanup was attempted
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "/mock-home/.worktrees/myproject/session-1"],
      { cwd: "/repo/path" },
    );
  });

  it("recovers checkout by removing stale checked-out worktree with no active tmux session", async () => {
    const ws = create();
    const worktreePath = "/mock-home/.worktrees/myproject/wa-999";
    const staleWorktreePath = "/mock-home/.worktrees/myproject/ao-999";
    const callResults: Record<string, GitCallResult> = {
      [`git,fetch,origin,--quiet,(cwd=/repo/path)`]: { stdout: "" },
      [`git,branch,--list,origin/main,(cwd=/repo/path)`]: { stdout: "" },
      [`git,worktree,add,-b,feat/TEST-1,${worktreePath},origin/main,(cwd=/repo/path)`]:
        new Error("already exists"),
      [`git,worktree,add,${worktreePath},origin/main,(cwd=/repo/path)`]: { stdout: "" },
      "tmux,list-sessions,-F,#{session_name},": { stdout: "" },
      [`git,worktree,remove,--force,--force,${staleWorktreePath},(cwd=/repo/path)`]: { stdout: "" },
      [`git,worktree,list,--porcelain,(cwd=/repo/path)`]: { stdout: "" },
      [`git,rev-parse,--path-format=absolute,--git-common-dir,(cwd=${worktreePath})`]: { stdout: "/repo/path/.git" },
      [`git,worktree,lock,--reason,AO session active,${worktreePath},(cwd=/repo/path)`]: { stdout: "" },
    };

    mockExistsSync.mockImplementation((p: string) => {
      if (String(p).endsWith(".git/info")) return true;
      if (String(p) === staleWorktreePath) return false;
      return true;
    });

    let checkoutAttempts = 0;
    mockExecFileAsync.mockImplementation((cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }) => {
      if (cmd === "git" && args[0] === "checkout" && args[1] === "feat/TEST-1" && opts?.cwd === worktreePath) {
        checkoutAttempts += 1;
        if (checkoutAttempts === 1) {
          return Promise.reject(new Error(`already exists, already checked out at '${staleWorktreePath}'`));
        }
        return Promise.resolve({ stdout: "\n", stderr: "" });
      }

      // key is used to look up call results in the mock map below
      const key = [cmd, ...args, opts?.cwd ? `(cwd=${opts.cwd})` : ""].join(",");
      const result = callResults[key];

      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve({ stdout: (result?.stdout ?? "") + "\n", stderr: result?.stderr ?? "" });
    });

    const info = await ws.create(makeCreateConfig({ sessionId: "wa-999" }));

    expect(info.branch).toBe("feat/TEST-1");
    expect(checkoutAttempts).toBe(2);
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "--force", staleWorktreePath],
      { cwd: "/repo/path" },
    );
  });

  it("reports retry checkout error when stale worktree removed but subsequent checkout fails", async () => {
    const ws = create();
    const worktreePath = "/mock-home/.worktrees/myproject/session-retry";
    const staleWorktreePath = "/mock-home/.worktrees/myproject/other-session";

    let checkoutAttempts = 0;
    mockExecFileAsync.mockImplementation((cmd: string, args: string[], opts?: { cwd?: string }) => {
      if (cmd === "git" && args[0] === "checkout" && args[1] === "feat/TEST-1" && opts?.cwd === worktreePath) {
        checkoutAttempts++;
        if (checkoutAttempts === 1) {
          // First checkout: stale worktree reference
          return Promise.reject(new Error(`already exists, already checked out at '${staleWorktreePath}'`));
        }
        // Second checkout: retry fails with different error
        return Promise.reject(new Error("Permission denied"));
      }
      // Stale worktree removal succeeds
      if (cmd === "git" && args[0] === "worktree" && args[1] === "remove") {
        return Promise.resolve({ stdout: "\n", stderr: "" });
      }
      // reuseExistingBranch path: worktree add succeeds (branch already exists)
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add" && args.includes("-b")) {
        return Promise.reject(new Error("A branch named 'feat/TEST-1' already exists."));
      }
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add" && !args.includes("-b")) {
        return Promise.resolve({ stdout: "\n", stderr: "" });
      }
      // tmux list-sessions: no active session
      if (cmd === "tmux") {
        return Promise.resolve({ stdout: "\n", stderr: "" });
      }
      return Promise.resolve({ stdout: "\n", stderr: "" });
    });

    await expect(ws.create(makeCreateConfig({ sessionId: "session-retry" }))).rejects.toThrow(
      /Failed to checkout branch "feat\/TEST-1" in worktree: Permission denied/,
    );
  });

  it("still throws on checkout failure even if cleanup fails", async () => {
    const ws = create();

    // Ensure existsSync returns true so unlock path is skipped
    mockExistsSync.mockReturnValue(true);

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // git branch --list origin/main — no local conflict
    mockGitError("already exists"); // worktree add -b fails
    mockGitSuccess(""); // worktree list --porcelain (ghost check)
    mockGitSuccess(""); // worktree add (without -b)
    mockGitError("checkout failed"); // checkout fails
    mockGitError("worktree remove failed"); // cleanup also fails

    await expect(ws.create(makeCreateConfig())).rejects.toThrow(
      'Failed to checkout branch "feat/TEST-1" in worktree',
    );
  });

  it("throws for non-already-exists worktree add errors", async () => {
    const ws = create();

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // git branch --list origin/main — no local conflict
    mockGitError("fatal: invalid reference"); // worktree add fails with other error

    await expect(ws.create(makeCreateConfig())).rejects.toThrow(
      'Failed to create worktree for branch "feat/TEST-1": fatal: invalid reference',
    );
  });

  // bd-1483: ambiguous origin/main (local branch shadows remote-tracking ref)
  it("auto-renames local conflicting branch when origin/main is ambiguous", async () => {
    const ws = create();

    mockGitSuccess(""); // fetch
    // git branch --list origin/main returns the local branch → ambiguous
    mockGitSuccess("  origin/main");
    // git branch -m origin/main backup/origin/main succeeds (rename)
    mockGitSuccess("");
    // git worktree add -b now succeeds
    mockGitSuccess("");

    await ws.create(makeCreateConfig());

    // Verify branch rename was called with correct args
    const branchMCall = mockExecFileAsync.mock.calls.find(
      (call) =>
        Array.isArray(call[1]) &&
        call[0] === "git" &&
        call[1][0] === "branch" &&
        call[1][1] === "-m",
    );
    expect(branchMCall).toBeDefined();
    expect(branchMCall![1]).toEqual(["branch", "-m", "origin/main", "backup/origin/main"]);

    // worktree add should follow the rename
    const worktreeCall = mockExecFileAsync.mock.calls.find(
      (call) =>
        Array.isArray(call[1]) &&
        call[0] === "git" &&
        call[1][0] === "worktree",
    );
    expect(worktreeCall).toBeDefined();
    expect(worktreeCall![1].slice(0, 4)).toEqual(["worktree", "add", "-b", "feat/TEST-1"]);
  });

  it("throws actionable error when rename fails during ambiguous-ref remediation", async () => {
    const ws = create();

    mockGitSuccess(""); // fetch
    // git branch --list origin/main returns the local branch → ambiguous
    mockGitSuccess("  origin/main");
    // git branch -m fails (backup/origin/main already exists)
    mockGitError("fatal: ref renamed because ref 'backup/origin/main' already exists");

    await expect(ws.create(makeCreateConfig())).rejects.toThrow(/Ambiguous ref.*manually rename|manually rename.*Ambiguous ref/is);
  });

  it("proceeds without rename when no local branch conflicts with baseRef", async () => {
    const ws = create();

    mockGitSuccess(""); // fetch
    // git branch --list origin/main returns empty → no local conflict
    mockGitSuccess("");
    // git worktree add -b succeeds
    mockGitSuccess("");

    await ws.create(makeCreateConfig());

    // No branch -m call should have been made
    const branchMCall = mockExecFileAsync.mock.calls.find(
      (call) =>
        Array.isArray(call[1]) &&
        call[0] === "git" &&
        call[1][0] === "branch" &&
        call[1][1] === "-m",
    );
    expect(branchMCall).toBeUndefined();

    // worktree add should have been called directly
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      [
        "worktree",
        "add",
        "-b",
        "feat/TEST-1",
        "/mock-home/.worktrees/myproject/session-1",
        "origin/main",
      ],
      { cwd: "/repo/path" },
    );
  });

  it("rejects invalid projectId", async () => {
    const ws = create();

    await expect(ws.create(makeCreateConfig({ projectId: "bad/project" }))).rejects.toThrow(
      'Invalid projectId "bad/project"',
    );
  });

  it("rejects projectId with dots", async () => {
    const ws = create();

    await expect(ws.create(makeCreateConfig({ projectId: "my.project" }))).rejects.toThrow(
      'Invalid projectId "my.project"',
    );
  });

  it("rejects invalid sessionId", async () => {
    const ws = create();

    await expect(ws.create(makeCreateConfig({ sessionId: "../escape" }))).rejects.toThrow(
      'Invalid sessionId "../escape"',
    );
  });

  it("rejects sessionId with spaces", async () => {
    const ws = create();

    await expect(ws.create(makeCreateConfig({ sessionId: "bad session" }))).rejects.toThrow(
      'Invalid sessionId "bad session"',
    );
  });

  it("returns correct WorkspaceInfo", async () => {
    const ws = create();

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // git branch --list origin/main — no local conflict
    mockGitSuccess(""); // worktree add

    const info = await ws.create(makeCreateConfig());

    expect(info).toEqual({
      path: "/mock-home/.worktrees/myproject/session-1",
      branch: "feat/TEST-1",
      sessionId: "session-1",
      projectId: "myproject",
      repoPath: "/repo/path",
    });
  });

  it("does NOT misclassify branch collision as ghost when worktree list confirms unregistered path", async () => {
    const ws = create();
    const worktreePath = "/mock-home/.worktrees/myproject/session-1";

    // Initial worktree add -b fails with branch collision — worktreePath appears in
    // the command string portion of the Node.js execFile error, NOT in git's path-error
    // format. This should NOT trigger ghost detection.
    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // git branch --list origin/main
    mockGitError(
      `Command failed: git worktree add -b feat/TEST-1 ${worktreePath} HEAD\nfatal: A branch named 'feat/TEST-1' already exists.`,
    ); // worktree add -b fails with branch collision (NOT path collision)
    mockGitSuccess(""); // git worktree list --porcelain (ghost check — worktreePath not registered)
    // Branch-exists recovery: worktree add (without -b) succeeds
    mockGitSuccess(""); // worktree add
    // checkout succeeds
    mockGitSuccess(""); // checkout

    const info = await ws.create(makeCreateConfig());

    expect(info.branch).toBe("feat/TEST-1");
    expect(info.path).toBe(worktreePath);

    // Verify: ghost worktree removal (rmSync) was NOT called — only the list call was made
    // (the list call fires for both path and branch collisions; only rmSync is path-specific)
    const listCall = mockExecFileAsync.mock.calls.find(
      (call) =>
        Array.isArray(call[1]) &&
        call[0] === "git" &&
        call[1][0] === "worktree" &&
        call[1][1] === "list",
    );
    expect(listCall).toBeDefined();

    // Verify: branch-exists recovery path was used (worktree add without -b)
    const addCall = mockExecFileAsync.mock.calls.find(
      (call) =>
        Array.isArray(call[1]) &&
        call[0] === "git" &&
        call[1][0] === "worktree" &&
        call[1][1] === "add" &&
        !call[1].includes("-b"),
    );
    expect(addCall).toBeDefined();

    // Verify: no filesystem removal was attempted
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it("removes ghost worktree when path exists but git doesn't know about it and retries", async () => {
    const ws = create();
    const worktreePath = "/mock-home/.worktrees/myproject/session-1";

    // git worktree add -b fails because the path already exists on disk
    // (git prints: fatal: '/path/to/worktree' already exists)
    // This is different from "branch already exists" error.
    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // git branch --list origin/main — no local conflict
    mockGitError(`fatal: '${worktreePath}' already exists`); // worktree add -b fails with path
    // git worktree list returns empty — git doesn't know about this worktree (it's a ghost)
    mockGitSuccess(""); // git worktree list (returns nothing — ghost worktree not registered)
    // no active tmux session for this worktree path
    mockGitSuccess(""); // tmux list-sessions (returns empty — no active session)
    // Note: ghost removal uses rmSync (filesystem), not git worktree remove
    // retry worktree add -b succeeds (creates and checks out branch in one step — no separate checkout call)
    mockGitSuccess(""); // retry worktree add -b
    // rev-parse for git-common-dir
    mockGitSuccess("/repo/path/.git"); // rev-parse --path-format=absolute --git-common-dir
    // lock succeeds
    mockGitSuccess(""); // worktree lock

    const info = await ws.create(makeCreateConfig());

    expect(info.branch).toBe("feat/TEST-1");
    expect(info.path).toBe(worktreePath);

    // Verify: after initial worktree add failure, we called git worktree list to check if it's a ghost
    const listCall = mockExecFileAsync.mock.calls.find(
      (call) =>
        Array.isArray(call[1]) &&
        call[0] === "git" &&
        call[1][0] === "worktree" &&
        call[1][1] === "list",
    );
    expect(listCall).toBeDefined();

    // Verify: ghost worktree was removed via filesystem (not git, since git doesn't know about it)
    expect(mockRmSync).toHaveBeenCalledWith(worktreePath, { recursive: true, force: true });

    // Verify: we retried worktree add -b after cleanup (retry is the 6th call: fetch, branch, add-fail, list, tmux, add-retry)
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      6,
      "git",
      ["worktree", "add", "-b", "feat/TEST-1", worktreePath, "origin/main"],
      { cwd: "/repo/path" },
    );
  });

  it("falls through to branch-exists recovery when worktree list fails", async () => {
    const ws = create();
    const worktreePath = "/mock-home/.worktrees/myproject/session-1";

    // git worktree add -b fails with path already exists
    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // git branch --list origin/main — no local conflict
    mockGitError(`fatal: '${worktreePath}' already exists`); // worktree add -b fails with path
    // git worktree list --porcelain fails (e.g., repo corruption) — fall through to branch-exists recovery
    mockGitError("fatal: detected dubious ownership");
    // Branch exists recovery: worktree add (without -b) succeeds
    mockGitSuccess(""); // worktree add (branch already exists — reuse it)
    // checkout succeeds
    mockGitSuccess(""); // checkout

    const info = await ws.create(makeCreateConfig());

    expect(info.branch).toBe("feat/TEST-1");
    expect(info.path).toBe(worktreePath);

    // Verify: worktree add (without -b) was called as fallback
    const addCall = mockExecFileAsync.mock.calls.find(
      (call) =>
        Array.isArray(call[1]) &&
        call[0] === "git" &&
        call[1][0] === "worktree" &&
        call[1][1] === "add" &&
        !call[1].includes("-b"),
    );
    expect(addCall).toBeDefined();
    expect(addCall![1].slice(0, 3)).toEqual(["worktree", "add", worktreePath]);

    // Verify: no filesystem removal was attempted (worktree list failure triggers
    // branch-exists recovery, not ghost removal)
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it("preserves worktree and rejects when tmux session is active", async () => {
    const ws = create();
    const worktreePath = "/mock-home/.worktrees/myproject/session-1";

    // git worktree add -b fails with path already exists
    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // git branch --list origin/main
    mockGitError(`fatal: '${worktreePath}' already exists`); // worktree add -b fails
    mockGitSuccess(""); // git worktree list (returns empty — ghost? but...)
    // BUT tmux finds an active session → preserve worktree
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-sessions") {
        // Active tmux session exists for this worktree
        return Promise.resolve({ stdout: "953501c04ccc-session-1\n", stderr: "" });
      }
      // fall through to mockGitSuccess for all other git calls
      return Promise.resolve({ stdout: "\n", stderr: "" });
    });

    await expect(ws.create(makeCreateConfig())).rejects.toThrow(
      `Failed to create worktree for branch "feat/TEST-1": fatal: '${worktreePath}' already exists`,
    );

    // Verify: tmux list-sessions was called to check for active session
    const tmuxCall = mockExecFileAsync.mock.calls.find(
      (call) =>
        Array.isArray(call[1]) &&
        call[0] === "tmux" &&
        call[1][0] === "list-sessions",
    );
    expect(tmuxCall).toBeDefined();

    // Verify: worktree remove was NOT called (tmux session is active)
    const removeCalls = mockExecFileAsync.mock.calls.filter(
      (call) =>
        Array.isArray(call[1]) &&
        call[0] === "git" &&
        call[1][0] === "worktree" &&
        call[1][1] === "remove",
    );
    expect(removeCalls).toHaveLength(0);
    // Verify: filesystem removal was NOT attempted (worktree is preserved)
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it("expands tilde in project path", async () => {
    const ws = create();

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // git branch --list origin/main — no local conflict
    mockGitSuccess(""); // worktree add

    await ws.create(
      makeCreateConfig({
        project: makeProject({ path: "~/my-repo" }),
      }),
    );

    // fetch should use expanded path
    expect(mockExecFileAsync).toHaveBeenCalledWith("git", ["fetch", "origin", "--quiet"], {
      cwd: "/mock-home/my-repo",
    });
  });
});

describe("workspace.destroy()", () => {
  it("removes worktree via git commands", async () => {
    const ws = create();

    // branch --show-current returns the checked-out branch
    mockGitSuccess("feat/TEST-1");
    // rev-parse returns the .git dir
    mockGitSuccess("/repo/path/.git");
    // worktree remove succeeds
    mockGitSuccess("");
    // branch -D succeeds
    mockGitSuccess("");

    await ws.destroy("/mock-home/.worktrees/myproject/session-1");

    // First call: branch --show-current (captures branch before removal)
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      1,
      "git",
      ["branch", "--show-current"],
      { cwd: "/mock-home/.worktrees/myproject/session-1" },
    );

    // Second call: rev-parse
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      2,
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: "/mock-home/.worktrees/myproject/session-1" },
    );

    // Third call: worktree remove (--force --force to bypass lock)
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      3,
      "git",
      ["worktree", "remove", "--force", "--force", "/mock-home/.worktrees/myproject/session-1"],
      { cwd: "/repo/path" },
    );

    // Fourth call: branch -D (cleanup to prevent cascading fetch failures)
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      4,
      "git",
      ["branch", "-D", "feat/TEST-1"],
      { cwd: "/repo/path" },
    );
  });

  it("falls back to rmSync when git commands fail", async () => {
    const ws = create();

    // branch --show-current fails (worktree path doesn't exist)
    mockGitError("not a git repository");
    // rev-parse fails at worktree dir and during walk-up (no .git found)
    mockGitError("not a git repository");
    mockGitError("not a git repository");
    mockGitError("not a git repository");
    // findRepoPathForWorktree → git worktree list --porcelain succeeds (returns empty)
    mockGitSuccess("");
    // rmSync is always called as a last resort.

    await ws.destroy("/mock-home/.worktrees/myproject/session-1");

    expect(mockRmSync).toHaveBeenCalledWith("/mock-home/.worktrees/myproject/session-1", {
      recursive: true,
      force: true,
    });
  });

  it("recovers branch from findRepoPathForWorktree when directory is gone but git entry exists", async () => {
    const ws = create();

    // destroy() calls branch --show-current first (fails because dir is gone)
    mockGitError("not a git repository");
    // then rev-parse --git-common-dir at worktree dir fails (no .git there either)
    mockGitError("not a git repository");
    // findRepoPathForWorktree walks up from worktree dir:
    // existsSync(".git") returns truthy → git rev-parse --git-common-dir called (fails)
    mockExistsSync.mockReturnValueOnce(true); // /mock-home/.worktrees/myproject/.git
    mockGitError("not a git repository");
    mockExistsSync.mockReturnValueOnce(true); // /mock-home/.worktrees/myproject/.git
    mockGitError("not a git repository");
    mockExistsSync.mockReturnValueOnce(true); // /mock-home/.worktrees/myproject/.git
    mockGitError("not a git repository");
    // findRepoPathForWorktree: git worktree list --porcelain from homedir succeeds
    mockGitSuccess(
      "worktree /mock-home/.worktrees/myproject/session-1\n" +
        "branch refs/heads/feat/TEST-1\n" +
        "gitdir /repo/path/.git/worktrees/session-1",
    );
    // fallback: worktree unlock + worktree remove --force --force
    mockGitSuccess("");
    mockGitSuccess("");
    // worktree prune
    mockGitSuccess("");
    // branch -D (branch recovered from git worktree list)
    mockGitSuccess("");

    await ws.destroy("/mock-home/.worktrees/myproject/session-1");

    // The fallback path makes 10 prior git calls before branch -D:
    // 1. branch --show-current (fails)
    // 2. rev-parse --git-common-dir at worktree dir (fails)
    // 3-5. findRepoPathForWorktree walk-up: 3x existsSync→true + rev-parse (all fail)
    // 6. findRepoPathForWorktree: git worktree list --porcelain from homedir (succeeds)
    // 7. worktree unlock (succeeds)
    // 8. worktree remove --force --force in fallback (succeeds)
    // 9. worktree prune (succeeds)
    // 10. branch -D (branch recovered from git worktree list)
    // repoPath = resolve("/repo/path/.git/worktrees/session-1", "..", "..", "..") = "/repo/path"
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      10,
      "git",
      ["branch", "-D", "feat/TEST-1"],
      { cwd: "/repo/path" },
    );
  });

  it("does nothing if git fails and directory does not exist", async () => {
    const ws = create();

    mockGitError("not a git repository");
    mockGitSuccess(""); // git worktree list --porcelain (findRepoPathForWorktree returns null)
    // rmSync is always called as a last resort; force:true makes it a safe no-op
    // on already-gone directories so no existsSync guard is needed.

    await ws.destroy("/nonexistent/path");

    expect(mockRmSync).toHaveBeenCalledWith("/nonexistent/path", {
      recursive: true,
      force: true,
    });
  });
});

describe("workspace.list()", () => {
  it("returns empty array when project directory does not exist", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(false);

    const result = await ws.list("myproject");

    expect(result).toEqual([]);
  });

  it("returns empty array when project directory has no subdirectories", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([]);

    const result = await ws.list("myproject");

    expect(result).toEqual([]);
  });

  it("parses worktree list porcelain output", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([
      { name: "session-1", isDirectory: () => true },
      { name: "session-2", isDirectory: () => true },
    ]);

    const porcelainOutput = [
      "worktree /mock-home/.worktrees/myproject/session-1",
      "HEAD abc1234",
      "branch refs/heads/feat/TEST-1",
      "",
      "worktree /mock-home/.worktrees/myproject/session-2",
      "HEAD def5678",
      "branch refs/heads/feat/TEST-2",
      "",
      "worktree /repo/path",
      "HEAD 0000000",
      "branch refs/heads/main",
    ].join("\n");

    mockGitSuccess(porcelainOutput);

    const result = await ws.list("myproject");

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      path: "/mock-home/.worktrees/myproject/session-1",
      branch: "feat/TEST-1",
      sessionId: "session-1",
      projectId: "myproject",
    });
    expect(result[1]).toEqual({
      path: "/mock-home/.worktrees/myproject/session-2",
      branch: "feat/TEST-2",
      sessionId: "session-2",
      projectId: "myproject",
    });
  });

  it("handles detached HEAD worktrees", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([{ name: "session-1", isDirectory: () => true }]);

    const porcelainOutput = [
      "worktree /mock-home/.worktrees/myproject/session-1",
      "HEAD abc1234",
      "detached",
    ].join("\n");

    mockGitSuccess(porcelainOutput);

    const result = await ws.list("myproject");

    expect(result).toHaveLength(1);
    expect(result[0].branch).toBe("detached");
  });

  it("excludes worktrees outside the project directory", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([{ name: "session-1", isDirectory: () => true }]);

    const porcelainOutput = [
      "worktree /other/path/session-1",
      "HEAD abc1234",
      "branch refs/heads/feat/other",
      "",
      "worktree /mock-home/.worktrees/myproject/session-1",
      "HEAD def5678",
      "branch refs/heads/feat/TEST-1",
    ].join("\n");

    mockGitSuccess(porcelainOutput);

    const result = await ws.list("myproject");

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("session-1");
  });

  it("returns empty when all git worktree list calls fail", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([{ name: "session-1", isDirectory: () => true }]);

    mockGitError("fatal: not a git repository");

    const result = await ws.list("myproject");

    expect(result).toEqual([]);
  });

  it("tries next directory when first worktree list fails", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([
      { name: "session-1", isDirectory: () => true },
      { name: "session-2", isDirectory: () => true },
    ]);

    // First dir fails
    mockGitError("fatal: not a git repository");
    // Second dir succeeds
    const porcelainOutput = [
      "worktree /mock-home/.worktrees/myproject/session-2",
      "HEAD abc1234",
      "branch refs/heads/feat/TEST-2",
    ].join("\n");
    mockGitSuccess(porcelainOutput);

    const result = await ws.list("myproject");

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("session-2");
  });

  it("rejects invalid projectId", async () => {
    const ws = create();

    await expect(ws.list("bad/id")).rejects.toThrow('Invalid projectId "bad/id"');
  });

  it("filters out non-directory entries", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([
      { name: "session-1", isDirectory: () => true },
      { name: ".DS_Store", isDirectory: () => false },
      { name: "readme.txt", isDirectory: () => false },
    ]);

    const porcelainOutput = [
      "worktree /mock-home/.worktrees/myproject/session-1",
      "HEAD abc1234",
      "branch refs/heads/feat/TEST-1",
    ].join("\n");

    mockGitSuccess(porcelainOutput);

    const result = await ws.list("myproject");

    expect(result).toHaveLength(1);
  });
});

describe("workspace.postCreate()", () => {
  const workspaceInfo: WorkspaceInfo = {
    path: "/mock-home/.worktrees/myproject/session-1",
    branch: "feat/TEST-1",
    sessionId: "session-1",
    projectId: "myproject",
  };

  it("creates symlinks for configured paths", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["node_modules", ".env"] });

    // First symlink: node_modules exists, target lstat throws (doesn't exist)
    mockExistsSync.mockReturnValueOnce(true); // sourcePath exists
    mockLstatSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    // Second symlink: .env exists, target lstat throws (doesn't exist)
    mockExistsSync.mockReturnValueOnce(true); // sourcePath exists
    mockLstatSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    await ws.postCreate!(workspaceInfo, project);

    expect(mockSymlinkSync).toHaveBeenCalledTimes(2);
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      "/repo/path/node_modules",
      "/mock-home/.worktrees/myproject/session-1/node_modules",
    );
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      "/repo/path/.env",
      "/mock-home/.worktrees/myproject/session-1/.env",
    );
  });

  it("removes existing target before symlinking", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["node_modules"] });

    mockExistsSync.mockReturnValueOnce(true); // sourcePath exists
    mockLstatSync.mockReturnValueOnce({
      isSymbolicLink: () => true,
      isFile: () => false,
      isDirectory: () => false,
    });

    await ws.postCreate!(workspaceInfo, project);

    expect(mockRmSync).toHaveBeenCalledWith(
      "/mock-home/.worktrees/myproject/session-1/node_modules",
      { recursive: true, force: true },
    );
    expect(mockSymlinkSync).toHaveBeenCalledTimes(1);
  });

  it("skips symlinks when source does not exist", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["nonexistent"] });

    mockExistsSync.mockReturnValueOnce(false); // sourcePath does not exist

    await ws.postCreate!(workspaceInfo, project);

    expect(mockSymlinkSync).not.toHaveBeenCalled();
  });

  it("rejects absolute symlink paths", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["/absolute/path"] });

    await expect(ws.postCreate!(workspaceInfo, project)).rejects.toThrow(
      'Invalid symlink path "/absolute/path": must be a relative path without ".." segments',
    );
  });

  it("rejects .. directory traversal in symlink paths", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["../escape"] });

    await expect(ws.postCreate!(workspaceInfo, project)).rejects.toThrow(
      'Invalid symlink path "../escape": must be a relative path without ".." segments',
    );
  });

  it("rejects .. embedded in symlink paths", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["foo/../../../etc/passwd"] });

    await expect(ws.postCreate!(workspaceInfo, project)).rejects.toThrow(
      'must be a relative path without ".." segments',
    );
  });

  it("creates parent directories for nested symlink targets", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["config/settings"] });

    mockExistsSync.mockReturnValueOnce(true); // sourcePath exists
    mockLstatSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    await ws.postCreate!(workspaceInfo, project);

    expect(mockMkdirSync).toHaveBeenCalledWith("/mock-home/.worktrees/myproject/session-1/config", {
      recursive: true,
    });
  });

  it("runs postCreate commands", async () => {
    const ws = create();
    const project = makeProject({
      postCreate: ["pnpm install", "pnpm build"],
    });

    // Two sh -c calls
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" });
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" });

    await ws.postCreate!(workspaceInfo, project);

    expect(mockExecFileAsync).toHaveBeenCalledWith("sh", ["-c", "pnpm install"], {
      cwd: "/mock-home/.worktrees/myproject/session-1",
    });
    expect(mockExecFileAsync).toHaveBeenCalledWith("sh", ["-c", "pnpm build"], {
      cwd: "/mock-home/.worktrees/myproject/session-1",
    });
  });

  it("does nothing when no symlinks or postCreate configured", async () => {
    const ws = create();
    const project = makeProject();

    await ws.postCreate!(workspaceInfo, project);

    expect(mockSymlinkSync).not.toHaveBeenCalled();
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("handles both symlinks and postCreate commands together", async () => {
    const ws = create();
    const project = makeProject({
      symlinks: ["node_modules"],
      postCreate: ["pnpm install"],
    });

    // Symlink: source exists, target doesn't
    mockExistsSync.mockReturnValueOnce(true);
    mockLstatSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    // postCreate command
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" });

    await ws.postCreate!(workspaceInfo, project);

    expect(mockSymlinkSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileAsync).toHaveBeenCalledWith("sh", ["-c", "pnpm install"], {
      cwd: "/mock-home/.worktrees/myproject/session-1",
    });
  });

  it("expands tilde in project path for symlink sources", async () => {
    const ws = create();
    const project = makeProject({ path: "~/my-repo", symlinks: ["data"] });

    mockExistsSync.mockReturnValueOnce(true);
    mockLstatSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    await ws.postCreate!(workspaceInfo, project);

    expect(mockSymlinkSync).toHaveBeenCalledWith(
      "/mock-home/my-repo/data",
      "/mock-home/.worktrees/myproject/session-1/data",
    );
  });
});

// ===========================================================================
// TDD: setupAoManagedExclude — bd-uxs.7
//
// setupAoManagedExclude is called by both create() and restore(). It writes
// AO-managed patterns into .git/info/exclude so runtime files written by
// agent-base don't cause the worktree to show as dirty.
// ===========================================================================

describe("setupAoManagedExclude (via workspace.create())", () => {
  it("writes AO-managed patterns to .git/info/exclude on first create", async () => {
    const ws = create();
    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // git branch --list origin/main — no local conflict
    mockGitSuccess(""); // worktree add
    // git rev-parse --git-common-dir falls back to "<worktreePath>/.git" via catch

    await ws.create(makeCreateConfig());

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const [writtenPath, writtenContent] = mockWriteFile.mock.calls[0] as [string, string, string];
    expect(writtenPath).toContain(".git/info/exclude");
    expect(writtenContent).toContain("# AO-managed files");
  });

  it("does NOT re-write exclude file when AO section already present (idempotency)", async () => {
    const ws = create();
    // Simulate exclude file already containing AO patterns
    mockReadFile.mockResolvedValueOnce("# AO-managed files - do not track in worktree\n.metadata-updater.sh\n");

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // git branch --list origin/main — no local conflict
    mockGitSuccess(""); // worktree add

    await ws.create(makeCreateConfig());

    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("preserves existing exclude content when bootstrapping", async () => {
    const ws = create();
    const existingExclude = "# Custom rules\n*.log\n";
    mockReadFile.mockResolvedValueOnce(existingExclude);

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // git branch --list origin/main — no local conflict
    mockGitSuccess(""); // worktree add

    await ws.create(makeCreateConfig());

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const [, writtenContent] = mockWriteFile.mock.calls[0] as [string, string, string];
    expect(writtenContent).toContain("*.log");
    expect(writtenContent).toContain("# AO-managed files");
  });

  it("fallback: reads .git FILE to resolve common-dir when git rev-parse fails (linked worktree)", async () => {
    // Regression test for bd-uxs.1:
    // In a linked worktree, .git is a FILE (not a dir) containing
    // "gitdir: /main/.git/worktrees/session". When git rev-parse --git-common-dir
    // fails (e.g. older git), the fallback must parse this file instead of
    // blindly using join(worktreePath, ".git") which produces an ENOTDIR error.
    const ws = create();
    const _worktreePath = "/mock-home/.worktrees/myproject/ao-1";
    const mainGitDir = "/main-repo/.git";

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // git branch --list origin/main — no local conflict
    mockGitSuccess(""); // worktree add
    // No fourth mock → git rev-parse --git-common-dir throws → fallback fires

    // Simulate .git being a FILE (linked worktree)
    mockLstatSync.mockReturnValue({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false });
    mockReadFileSync.mockReturnValue(`gitdir: ${mainGitDir}/worktrees/ao-1\n`);

    await ws.create(makeCreateConfig({ sessionId: "ao-1" }));

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const [writtenPath] = mockWriteFile.mock.calls[0] as [string, string, string];
    // Must write to the MAIN repo's .git/info/exclude, not the worktree's .git/info/exclude
    expect(writtenPath).toBe(`${mainGitDir}/info/exclude`);
  });
});

describe("setupAoManagedExclude (via workspace.restore())", () => {
  it("writes AO-managed patterns to .git/info/exclude on restore", async () => {
    const ws = create();
    const worktreePath = "/mock-home/.worktrees/myproject/session-1";

    // restore() git call sequence:
    // 1. git worktree unlock <worktreePath> (best-effort — must mock to avoid undefined)
    // 2. git worktree prune (caught if fails — ok to leave unmocked)
    // 3. git fetch origin --quiet (caught if fails — ok to leave unmocked)
    // 4. git worktree add <worktreePath> <branch> (first attempt — succeeds, no disambiguateBaseRef)
    // setupAoManagedExclude: git rev-parse --git-common-dir (caught, falls back to readFileSync)
    mockGitSuccess(""); // unlock
    mockGitSuccess(""); // prune
    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // worktree add

    const cfg = makeCreateConfig();
    await ws.restore!(cfg, worktreePath);

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const [writtenPath, writtenContent] = mockWriteFile.mock.calls[0] as [string, string, string];
    expect(writtenPath).toContain(".git/info/exclude");
    expect(writtenContent).toContain("# AO-managed files");
  });
});

// bd-1483: restore() disambiguates origin/<branch> refs before git worktree add (same as create())
describe("restore() ambiguous-ref disambiguation", () => {
  function makeRestoreConfig(overrides?: Partial<WorkspaceCreateConfig>): WorkspaceCreateConfig {
    return {
      projectId: "myproject",
      project: makeProject(),
      sessionId: "session-1",
      branch: "feat/TEST-1",
      ...overrides,
    };
  }

  it("auto-renames local conflicting branch when first worktree add fails with ambiguous remoteBranch", async () => {
    const ws = create();
    const worktreePath = "/mock-home/.worktrees/myproject/session-1";

    // Keys include (cwd=...) — git() passes cwd as 3rd parameter.
    mockGitImpl({
      [`git,worktree,add,${worktreePath},feat/TEST-1,(cwd=/repo/path)`]:
        new Error("fatal: 'feat/TEST-1' is not a commit ref"),
      [`git,branch,--list,origin/feat/TEST-1,(cwd=/repo/path)`]: { stdout: "  origin/feat/TEST-1" },
      [`git,branch,-m,origin/feat/TEST-1,backup/origin/feat/TEST-1,(cwd=/repo/path)`]: { stdout: "" },
      [`git,worktree,add,-b,feat/TEST-1,${worktreePath},origin/feat/TEST-1,(cwd=/repo/path)`]: { stdout: "" },
    });

    const cfg = makeRestoreConfig();
    await ws.restore!(cfg, worktreePath);

    const branchMCall = mockExecFileAsync.mock.calls.find(
      (call) =>
        Array.isArray(call[1]) &&
        call[0] === "git" &&
        call[1][0] === "branch" &&
        call[1][1] === "-m",
    );
    expect(branchMCall).toBeDefined();
    expect(branchMCall![1]).toEqual(["branch", "-m", "origin/feat/TEST-1", "backup/origin/feat/TEST-1"]);

    const worktreeCalls = mockExecFileAsync.mock.calls.filter(
      (call) =>
        Array.isArray(call[1]) &&
        call[0] === "git" &&
        call[1][0] === "worktree" &&
        call[1][1] === "add",
    );
    expect(worktreeCalls.length).toBeGreaterThanOrEqual(2);
    expect(worktreeCalls[1][1].slice(0, 5)).toEqual(["worktree", "add", "-b", "feat/TEST-1", worktreePath]);
  });

  it("throws actionable error when rename fails during restore disambiguation", async () => {
    const ws = create();
    const worktreePath = "/mock-home/.worktrees/myproject/session-1";

    mockGitImpl({
      [`git,worktree,add,${worktreePath},feat/TEST-1,(cwd=/repo/path)`]:
        new Error("fatal: 'feat/TEST-1' is not a commit ref"),
      [`git,branch,--list,origin/feat/TEST-1,(cwd=/repo/path)`]: { stdout: "  origin/feat/TEST-1" },
      [`git,branch,-m,origin/feat/TEST-1,backup/origin/feat/TEST-1,(cwd=/repo/path)`]:
        new Error("fatal: ref renamed because ref 'backup/origin/feat/TEST-1' already exists"),
    });

    const cfg = makeRestoreConfig();
    await expect(ws.restore!(cfg, worktreePath)).rejects.toThrow(
      /Ambiguous ref.*manually rename|manually rename.*Ambiguous ref/is,
    );
  });

  it("proceeds without rename when no local branch conflicts with remoteBranch", async () => {
    const ws = create();
    const worktreePath = "/mock-home/.worktrees/myproject/session-1";

    mockGitImpl({
      [`git,worktree,add,${worktreePath},feat/TEST-1,(cwd=/repo/path)`]:
        new Error("fatal: 'feat/TEST-1' is not a commit ref"),
      [`git,branch,--list,origin/feat/TEST-1,(cwd=/repo/path)`]: { stdout: "" },
      [`git,worktree,add,-b,feat/TEST-1,${worktreePath},origin/feat/TEST-1,(cwd=/repo/path)`]: { stdout: "" },
    });

    const cfg = makeRestoreConfig();
    await ws.restore!(cfg, worktreePath);

    const branchMCall = mockExecFileAsync.mock.calls.find(
      (call) =>
        Array.isArray(call[1]) &&
        call[0] === "git" &&
        call[1][0] === "branch" &&
        call[1][1] === "-m",
    );
    expect(branchMCall).toBeUndefined();
  });
});

describe("create() with stale locked worktree", () => {
  it("unlocks stale worktree entry before creating new worktree", async () => {
    const ws = create();
    const worktreePath = "/mock-home/.worktrees/myproject/wa-999";

    // Path is missing (simulating stale lock scenario per bd-206)
    mockExistsSync.mockImplementation((p: string) => String(p).endsWith(".git/info"));

    // create() should try to unlock any stale entry before adding
    mockGitImpl({
      // fetch succeeds
      [`git,fetch,origin,--quiet,(cwd=/repo/path)`]: { stdout: "" },
      // disambiguateBaseRef: branch --list returns empty (no local conflict)
      [`git,branch,--list,origin/main,(cwd=/repo/path)`]: { stdout: "" },
      // worktree unlock is called FIRST to clean up stale lock (bd-206 fix)
      [`git,worktree,unlock,${worktreePath},(cwd=/repo/path)`]: { stdout: "" },
      // then worktree add succeeds
      [`git,worktree,add,-b,session/wa-999,${worktreePath},origin/main,(cwd=/repo/path)`]: { stdout: "" },
      // setupAoManagedExclude: rev-parse --git-common-dir
      [`git,rev-parse,--path-format=absolute,--git-common-dir,(cwd=${worktreePath})`]: { stdout: "/repo/path/.git" },
      // setupAoManagedExclude: readFile .git/info/exclude (doesn't exist)
      [`git,rev-parse,--path-format=absolute,--git-dir,(cwd=${worktreePath})`]: { stdout: "/repo/path/.git" },
      // git worktree lock
      [`git,worktree,lock,--reason,AO session active,${worktreePath},(cwd=/repo/path)`]: { stdout: "" },
    });

    const cfg = makeCreateConfig({ sessionId: "wa-999", branch: "session/wa-999" });
    const info = await ws.create(cfg);

    // Verify unlock was attempted BEFORE worktree add
    const allCalls = mockExecFileAsync.mock.calls;
    const unlockIndex = allCalls.findIndex(
      (call) => Array.isArray(call[1]) && call[1][0] === "worktree" && call[1][1] === "unlock",
    );
    const addIndex = allCalls.findIndex(
      (call) => Array.isArray(call[1]) && call[1][0] === "worktree" && call[1][1] === "add",
    );
    expect(unlockIndex).toBeGreaterThan(-1);
    expect(unlockIndex).toBeLessThan(addIndex);
    expect(info.path).toBe(worktreePath);
  });
});
