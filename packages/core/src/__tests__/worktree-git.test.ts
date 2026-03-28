/**
 * worktree-git.test.ts — unit tests for findRepoPathForWorktree
 *
 * Mocks node:child_process/execFile with [Symbol.for("nodejs.util.promisify.custom")]
 * so that promisify(execFile) in worktree-git.ts resolves to our test mocks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const gitMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: Object.assign(gitMock, {
    [Symbol.for("nodejs.util.promisify.custom")]: gitMock,
  }),
}));

// Import after mock is set up — worktree-git.js will use the mocked execFile
import { findRepoPathForWorktree } from "../utils/worktree-git.js";

const makeResponse = (stdout: string, stderr = "") => ({
  stdout,
  stderr,
});

describe("findRepoPathForWorktree", () => {
  beforeEach(() => {
    gitMock.mockReset();
  });

  it("returns null when no .git is found and worktree list has no matching entry", async () => {
    gitMock.mockImplementation(async () => {
      throw new Error("not a git repo");
    });

    const result = await findRepoPathForWorktree("/nonexistent/workspace");
    expect(result).toBeNull();
  });

  it("returns repoPath and branch when phase-1 .git walk succeeds with HEAD", async () => {
    gitMock
      .mockImplementationOnce(async () => makeResponse("/tmp/repo/.git\n"))
      // Branch extraction via symbolic-ref
      .mockImplementationOnce(async () => makeResponse("feat/my-branch\n"));

    const result = await findRepoPathForWorktree("/tmp/worktrees/proj/session-1");
    expect(result).not.toBeNull();
    expect(result!.repoPath).toMatch(/tmp\/repo/);
    expect(result!.branch).toBe("feat/my-branch");
  });

  it("returns empty branch when HEAD cannot be parsed (detached HEAD)", async () => {
    gitMock
      .mockImplementationOnce(async () => makeResponse("/tmp/repo/.git\n"))
      // Detached HEAD — symbolic-ref fails
      .mockImplementationOnce(async () => {
        throw new Error("ref: not a symbolic ref");
      });

    const result = await findRepoPathForWorktree("/tmp/worktrees/proj/session-3");
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("");
  });

  it("falls back to worktree list scan when .git walk fails", async () => {
    // Phase 1 walk fails at every directory
    gitMock.mockImplementation(async () => {
      throw new Error("not a git repo");
    });

    const result = await findRepoPathForWorktree("/tmp/worktrees/proj/session-2");
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("feat/fallback");
    expect(result!.repoPath).toMatch(/proj/);
  });

  it("returns null when worktree list scan finds no matching entry", async () => {
    gitMock.mockImplementation(async () => {
      throw new Error("not a git repo");
    });

    const result = await findRepoPathForWorktree("/tmp/worktrees/proj/no-match");
    expect(result).toBeNull();
  });

  it("resolves gitdir path correctly from worktree list", async () => {
    // Phase 1 walk fails
    gitMock.mockImplementation(async () => {
      throw new Error("not a git repo");
    });

    const result = await findRepoPathForWorktree("/the/worktree");
    expect(result).not.toBeNull();
    // gitdir = /the/repo/.git/worktrees/session
    // resolve(gitdir, "..", "..", "..") → /the/repo
    expect(result!.repoPath).toBe("/the/repo");
    expect(result!.branch).toBe("feat/session");
  });
});
