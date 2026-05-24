/**
 * worktree-git.test.ts — unit tests for findRepoPathForWorktree
 *
 * Mocks node:fs (existsSync) so the phase-1 directory walk reaches the git
 * call, and mocks node:child_process/execFile so git commands return fixture
 * data.  The [Symbol.for("nodejs.util.promisify.custom")] trick wires our mock
 * into promisify(execFile) inside worktree-git.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ------------------------------------------------------------------
// fs mock — controls which directories contain .git during phase-1 walk
// We intercept existsSync and return true only for the .git path we're testing.
// ------------------------------------------------------------------
const dotGitPrefixes = vi.hoisted(() => new Set<string>());

vi.mock("node:fs", () => ({
  existsSync: (path: string) => {
    if (typeof path === "string" && path.endsWith("/.git")) {
      return [...dotGitPrefixes].some((p) => path === p);
    }
    return false;
  },
}));

// ------------------------------------------------------------------
// child_process mock — wires into promisify(execFile)
// ------------------------------------------------------------------
const gitMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: Object.assign(gitMock, {
    [Symbol.for("nodejs.util.promisify.custom")]: gitMock,
  }),
}));

// ------------------------------------------------------------------
// SUT
// ------------------------------------------------------------------
import { findRepoPathForWorktree, getWorkspaceChangedFiles } from "../utils/worktree-git.js";

const makeResponse = (stdout: string, stderr = "") => ({ stdout, stderr });

describe("getWorkspaceChangedFiles", () => {
  beforeEach(() => {
    gitMock.mockReset();
  });

  it("returns list of changed files using baseBranch...HEAD", async () => {
    gitMock.mockResolvedValueOnce(makeResponse("file1.ts\nfile2.ts\n"));

    const result = await getWorkspaceChangedFiles("/tmp/ws", "main");

    expect(result).toEqual(["file1.ts", "file2.ts"]);
    expect(gitMock).toHaveBeenCalledWith(
      "git",
      ["diff", "--name-only", "main...HEAD"],
      expect.objectContaining({ cwd: "/tmp/ws" }),
    );
  });

  it("falls back to origin/baseBranch if baseBranch...HEAD fails", async () => {
    gitMock
      .mockRejectedValueOnce(new Error("fatal: unknown revision"))
      .mockResolvedValueOnce(makeResponse("file3.ts\n"));

    const result = await getWorkspaceChangedFiles("/tmp/ws", "develop");

    expect(result).toEqual(["file3.ts"]);
    expect(gitMock).toHaveBeenCalledTimes(2);
    expect(gitMock).toHaveBeenNthCalledWith(
      2,
      "git",
      ["diff", "--name-only", "origin/develop...HEAD"],
      expect.objectContaining({ cwd: "/tmp/ws" }),
    );
  });

  it("returns empty array if both local and origin branches fail", async () => {
    gitMock
      .mockRejectedValueOnce(new Error("fail1"))
      .mockRejectedValueOnce(new Error("fail2"));

    const result = await getWorkspaceChangedFiles("/tmp/ws", "main");

    expect(result).toEqual([]);
  });

  it("trims whitespace and filters empty lines", async () => {
    gitMock.mockResolvedValueOnce(makeResponse("  file1.ts  \n\n  file2.ts  \n"));

    const result = await getWorkspaceChangedFiles("/tmp/ws", "main");

    expect(result).toEqual(["file1.ts", "file2.ts"]);
  });
});

describe("findRepoPathForWorktree", () => {
  beforeEach(() => {
    gitMock.mockReset();
    dotGitPrefixes.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Phase 1 — .git walk succeeds
  // ---------------------------------------------------------------------------
  describe("phase-1 .git walk succeeds", () => {
    it("returns repoPath and branch when walk finds .git and HEAD resolves", async () => {
      // The walk starts at dirname(workspacePath) and walks up to homedir().
      // Simulate .git at the first directory checked (/tmp/worktrees/proj).
      // This makes the code call git rev-parse and git symbolic-ref.
      dotGitPrefixes.add("/tmp/worktrees/proj/.git");

      gitMock
        .mockImplementationOnce(async () =>
          makeResponse("/tmp/worktrees/proj/.git\n"),
        )
        .mockImplementationOnce(async () =>
          makeResponse("feat/my-branch\n"),
        );

      const result = await findRepoPathForWorktree(
        "/tmp/worktrees/proj/session-1",
      );

      expect(result).not.toBeNull();
      expect(result!.repoPath).toMatch(/tmp\/worktrees\/proj/);
      expect(result!.branch).toBe("feat/my-branch");

      // Verify -C flag is used so git receives the working directory correctly
      expect(gitMock).toHaveBeenNthCalledWith(
        1,
        "git",
        ["-C", "/tmp/worktrees/proj", "rev-parse",
          "--path-format=absolute", "--git-common-dir"],
        expect.any(Object),
      );
      expect(gitMock).toHaveBeenNthCalledWith(
        2,
        "git",
        ["-C", "/tmp/worktrees/proj/session-1", "symbolic-ref", "--short", "HEAD"],
        expect.any(Object),
      );
    });

    it("returns empty branch on detached HEAD", async () => {
      dotGitPrefixes.add("/tmp/worktrees/proj/.git");

      gitMock
        .mockImplementationOnce(async () =>
          makeResponse("/tmp/worktrees/proj/.git\n"),
        )
        .mockImplementationOnce(async () => {
          throw new Error("ref: not a symbolic ref");
        });

      const result = await findRepoPathForWorktree(
        "/tmp/worktrees/proj/session-3",
      );

      expect(result).not.toBeNull();
      expect(result!.branch).toBe("");
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 2 — worktree list fallback (phase-1 misses all directories)
  // ---------------------------------------------------------------------------
  describe("phase-2 worktree list fallback", () => {
    // phase-1 walks all the way to homedir without finding .git
    // → code calls git -C <workspacePath ancestor> worktree list --porcelain
    // mockImplementation returns phase-2 data for that call; throws for phase-1
    const phase1MissesPhase2Hits = (
      worktreePath: string,
      branch: string,
      gitdir: string,
    ) => {
      gitMock.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes("worktree")) {
          return makeResponse(
            [
              `worktree ${worktreePath}`,
              `branch refs/heads/${branch}`,
              `gitdir ${gitdir}`,
              "",
            ].join("\n"),
          );
        }
        throw new Error("not a git repo");
      });
    };

    it("fallback returns matching entry from worktree list", async () => {
      phase1MissesPhase2Hits(
        "/tmp/worktrees/proj/session-2",
        "feat/fallback",
        "/tmp/proj/.git/worktrees/session-2",
      );

      const result = await findRepoPathForWorktree(
        "/tmp/worktrees/proj/session-2",
      );

      expect(result).not.toBeNull();
      expect(result!.branch).toBe("feat/fallback");
      expect(result!.repoPath).toMatch(/proj/);
    });

    it("fallback resolves gitdir path to repo root", async () => {
      phase1MissesPhase2Hits(
        "/the/worktree",
        "feat/session",
        "/the/repo/.git/worktrees/session",
      );

      const result = await findRepoPathForWorktree("/the/worktree");

      expect(result).not.toBeNull();
      expect(result!.repoPath).toBe("/the/repo");
      expect(result!.branch).toBe("feat/session");
      // Verify -C <some dir> for the worktree list scan
      expect(gitMock).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["-C"]),
        expect.any(Object),
      );
    });

    it("phase-2 runs when cwd is / (daemon / launchd) — scans from workspace path, not cwd", async () => {
      vi.spyOn(process, "cwd").mockReturnValue("/");

      phase1MissesPhase2Hits(
        "/tmp/worktrees/proj/session-daemon",
        "feat/daemon",
        "/tmp/proj/.git/worktrees/session-daemon",
      );

      const workspace = "/tmp/worktrees/proj/session-daemon";
      const result = await findRepoPathForWorktree(workspace);

      expect(result).not.toBeNull();
      expect(result!.branch).toBe("feat/daemon");
      expect(gitMock).toHaveBeenCalledWith(
        "git",
        ["-C", workspace, "worktree", "list", "--porcelain"],
        expect.any(Object),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // No match — returns null
  // ---------------------------------------------------------------------------
  describe("no match — returns null", () => {
    // phase-1 misses; phase-2 returns a non-matching entry
    const phase1MissesPhase2ReturnsNoMatch = () => {
      gitMock.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes("worktree")) {
          return makeResponse(
            [
              "worktree /some/other/worktree",
              "branch refs/heads/main",
              "gitdir /some/repo/.git/worktrees/other",
              "",
            ].join("\n"),
          );
        }
        throw new Error("not a git repo");
      });
    };

    it.each([
      "/nonexistent/workspace",
      "/tmp/worktrees/proj/no-match",
    ])(
      "phase-1 misses and worktree list has no matching entry (%s)",
      async (path) => {
        phase1MissesPhase2ReturnsNoMatch();

        const result = await findRepoPathForWorktree(path);

        expect(result).toBeNull();
      },
    );
  });
});
