import { execFile } from "node:child_process";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import worktreePlugin, { assertOriginMatchesProjectRepo } from "@jleechanorg/ao-plugin-workspace-worktree";
import type { ProjectConfig, WorkspaceInfo } from "@jleechanorg/ao-core";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trimEnd();
}

describe("workspace-worktree (integration)", () => {
  let repoDir: string;
  let worktreeBaseDir: string;
  let workspace: ReturnType<typeof worktreePlugin.create>;
  let project: ProjectConfig;
  let createdInfo: WorkspaceInfo;

  beforeAll(async () => {
    // Create a temp repo with initial commit
    const rawRepo = await mkdtemp(join(tmpdir(), "ao-inttest-wt-repo-"));
    repoDir = await realpath(rawRepo);

    await git(repoDir, "init", "-b", "main");
    await git(repoDir, "config", "user.email", "test@test.com");
    await git(repoDir, "config", "user.name", "Test");
    await execFileAsync("sh", ["-c", "echo hello > README.md"], { cwd: repoDir });
    await git(repoDir, "add", ".");
    await git(repoDir, "commit", "-m", "initial commit");

    // Add "origin" pointing at itself so the plugin's fetch succeeds
    await git(repoDir, "remote", "add", "origin", repoDir);
    await git(repoDir, "fetch", "origin");

    // Create worktree base dir
    const rawBase = await mkdtemp(join(tmpdir(), "ao-inttest-wt-base-"));
    worktreeBaseDir = await realpath(rawBase);

    workspace = worktreePlugin.create({ worktreeDir: worktreeBaseDir });

    project = {
      name: "inttest",
      // The fixture origin is a local repository, not a GitHub remote.
      repo: repoDir,
      path: repoDir,
      defaultBranch: "main",
      sessionPrefix: "test",
    };
  }, 30_000);

  afterAll(async () => {
    // Clean up worktrees first (must be done before removing repo)
    try {
      await git(repoDir, "worktree", "prune");
    } catch {
      /* best-effort cleanup */
    }
    if (repoDir) await rm(repoDir, { recursive: true, force: true }).catch(() => {});
    if (worktreeBaseDir)
      await rm(worktreeBaseDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it("creates a worktree workspace", async () => {
    createdInfo = await workspace.create({
      projectId: "inttest",
      sessionId: "session-1",
      project,
      branch: "feat/test-branch",
    });

    expect(createdInfo.path).toContain("session-1");
    expect(createdInfo.branch).toBe("feat/test-branch");
    expect(createdInfo.sessionId).toBe("session-1");
    expect(createdInfo.projectId).toBe("inttest");
    expect(existsSync(createdInfo.path)).toBe(true);
  });

  it("cleans up stale empty worktree directory and metadata on create", async () => {
    // Determine a target worktree path that does not exist yet
    const targetSessionId = `session-stale-${Date.now()}`;
    const targetPath = join(worktreeBaseDir, "inttest", targetSessionId);

    // Create an empty directory at the targetPath on disk manually (simulating a stale folder)
    mkdirSync(targetPath, { recursive: true });
    expect(existsSync(targetPath)).toBe(true);

    // Call create - it should prune/delete the empty folder and successfully create the worktree
    const info = await workspace.create({
      projectId: "inttest",
      sessionId: targetSessionId,
      project,
      branch: `feat/stale-wt-${Date.now()}`,
    });

    expect(existsSync(info.path)).toBe(true);
    expect(existsSync(join(info.path, "README.md"))).toBe(true);

    // Clean up
    await workspace.destroy(info.path);
  });

  it("worktree is on the correct branch", async () => {
    const branch = await git(createdInfo.path, "branch", "--show-current");
    expect(branch).toBe("feat/test-branch");
  });

  it("worktree has the files from main", async () => {
    expect(existsSync(join(createdInfo.path, "README.md"))).toBe(true);
  });

  it("lists the worktree", async () => {
    const list = await workspace.list("inttest");
    expect(list.length).toBeGreaterThanOrEqual(1);
    const found = list.find((w: { sessionId: string }) => w.sessionId === "session-1");
    expect(found).toBeDefined();
    expect(found!.branch).toBe("feat/test-branch");
  });

  it("rejects a project repo that differs from the fixture origin", async () => {
    await expect(workspace.create({
      projectId: "inttest",
      sessionId: "mismatched-origin",
      project: { ...project, repo: "test/different-repo" },
      branch: "feat/mismatched-origin",
    })).rejects.toThrow("remote mismatch");
    expect(existsSync(join(worktreeBaseDir, "inttest", "mismatched-origin"))).toBe(false);
  });

  it("rejects invalid projectId", async () => {
    await expect(
      workspace.create({
        projectId: "../escape",
        sessionId: "ok",
        project,
        branch: "feat/x",
      }),
    ).rejects.toThrow("Invalid projectId");
  });

  it("rejects invalid sessionId", async () => {
    await expect(
      workspace.create({
        projectId: "inttest",
        sessionId: "bad/id",
        project,
        branch: "feat/x",
      }),
    ).rejects.toThrow("Invalid sessionId");
  });

  it("destroys the worktree", async () => {
    const pathToDestroy = createdInfo.path;
    await workspace.destroy(pathToDestroy);
    expect(existsSync(pathToDestroy)).toBe(false);
  });

  it("list returns empty after destroy", async () => {
    const list = await workspace.list("inttest");
    const found = list.find((w: { sessionId: string }) => w.sessionId === "session-1");
    expect(found).toBeUndefined();
  });
});


describe("effective origin push destinations (offline)", () => {
  let fixture: string;
  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), "ao-push-destination-"));
    await git(fixture, "init");
    await git(fixture, "remote", "add", "origin", "git@github.com:Owner/Repo.git");
  });
  afterEach(async () => {
    if (fixture) await rm(fixture, { recursive: true, force: true });
  });
  it("accepts fallback and multiple matching push destinations", async () => {
    await expect(assertOriginMatchesProjectRepo(fixture, "owner/repo")).resolves.toBe("git@github.com:Owner/Repo.git");
    await git(fixture, "config", "--add", "remote.origin.pushurl", "https://github.com/owner/repo.git");
    await git(fixture, "config", "--add", "remote.origin.pushurl", "ssh://git@github.com:22/OWNER/REPO.git");
    await expect(assertOriginMatchesProjectRepo(fixture, "owner/repo")).resolves.toBe("git@github.com:Owner/Repo.git");
  });
  it("rejects a mismatching pushurl", async () => {
    await git(fixture, "config", "remote.origin.pushurl", "git@gitlab.com:Owner/Repo.git");
    await expect(assertOriginMatchesProjectRepo(fixture, "owner/repo")).rejects.toThrow("push destination mismatch");
  });
  it("validates every configured pushurl", async () => {
    await git(fixture, "config", "--add", "remote.origin.pushurl", "git@github.com:Owner/Repo.git");
    await git(fixture, "config", "--add", "remote.origin.pushurl", "git@github.com:Other/Repo.git");
    await expect(assertOriginMatchesProjectRepo(fixture, "owner/repo")).rejects.toThrow("push destination mismatch");
  });
  it.each(["insteadOf", "pushInsteadOf"])("rejects effective %s rewrites", async (rule) => {
    await git(fixture, "config", `url.git@gitlab.com:.${rule}`, "git@github.com:");
    await expect(assertOriginMatchesProjectRepo(fixture, "owner/repo")).rejects.toThrow("push destination mismatch");
  });
});
