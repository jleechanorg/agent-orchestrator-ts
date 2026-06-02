import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join, sep } from "path";
import { homedir, tmpdir } from "os";
import { existsSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  normalizePath,
  isPathInside,
  shouldDestroyWorkspacePath,
} from "../recovery/workspacePolicy.js";
import type { ProjectConfig } from "../types.js";
import { getWorktreesDir } from "../paths.js";

describe("workspacePolicy", () => {
  describe("normalizePath", () => {
    it("strips trailing separators from standard paths", () => {
      const p1 = join("a", "b", "c") + sep;
      expect(normalizePath(p1)).toBe(join(process.cwd(), "a", "b", "c"));

      const p2 = join("a", "b", "c");
      expect(normalizePath(p2)).toBe(join(process.cwd(), "a", "b", "c"));
    });

    it("does not strip trailing separator if it represents the system root directory", () => {
      const rootPath = sep;
      expect(normalizePath(rootPath)).toBe(rootPath);
    });
  });

  describe("isPathInside", () => {
    it("returns true if child is strictly inside parent", () => {
      const parent = join("foo", "bar");
      const child = join("foo", "bar", "baz");
      expect(isPathInside(child, parent)).toBe(true);
    });

    it("returns false if child is equal to parent", () => {
      const parent = join("foo", "bar");
      const child = join("foo", "bar");
      expect(isPathInside(child, parent)).toBe(false);
    });

    it("returns false if child is outside parent", () => {
      const parent = join("foo", "bar");
      const child = join("foo", "other");
      expect(isPathInside(child, parent)).toBe(false);
    });
  });

  describe("shouldDestroyWorkspacePath", () => {
    let rootDir: string;
    let configPath: string;
    let project: ProjectConfig;

    beforeEach(() => {
      rootDir = join(tmpdir(), `ao-policy-test-${randomUUID()}`);
      mkdirSync(rootDir, { recursive: true });
      mkdirSync(join(rootDir, "project"), { recursive: true });
      configPath = join(rootDir, "agent-orchestrator.yaml");
      writeFileSync(configPath, "projects: {}\n", "utf-8");

      project = {
        name: "my-project",
        repo: "org/repo",
        path: join(rootDir, "project"),
        defaultBranch: "main",
      };
    });

    afterEach(() => {
      if (rootDir && existsSync(rootDir)) {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    it("returns false if project is undefined", () => {
      expect(shouldDestroyWorkspacePath(undefined, "my-project", "some-path", configPath)).toBe(false);
    });

    it("returns false if workspacePath is exactly equal to project path", () => {
      expect(shouldDestroyWorkspacePath(project, "my-project", project.path, configPath)).toBe(false);
    });

    it("returns true if workspacePath is inside the worktrees directory", () => {
      const worktreeRoot = getWorktreesDir(configPath, project.path);
      const targetWorkspace = join(worktreeRoot, "session-123");
      expect(shouldDestroyWorkspacePath(project, "my-project", targetWorkspace, configPath)).toBe(true);
    });

    it("returns true if workspacePath is inside legacy .worktrees directory using legacy projectId", () => {
      const legacyPath = join(homedir(), ".worktrees", "legacy-id-123", "session-abc");
      expect(shouldDestroyWorkspacePath(project, "legacy-id-123", legacyPath, configPath)).toBe(true);
    });

    it("returns true if workspacePath is inside legacy .worktrees directory using project basename", () => {
      const legacyPath = join(homedir(), ".worktrees", "project", "session-abc");
      expect(shouldDestroyWorkspacePath(project, undefined, legacyPath, configPath)).toBe(true);
    });

    it("returns false if workspacePath is outside any safe root", () => {
      const unsafePath = join(rootDir, "other-project", "worktree");
      expect(shouldDestroyWorkspacePath(project, "my-project", unsafePath, configPath)).toBe(false);
    });

    it("returns true if workspacePath is inside a custom global worktreeDir", () => {
      const customGlobalDir = join(rootDir, "custom-global-worktrees");
      writeFileSync(configPath, `worktreeDir: "${customGlobalDir}"\nprojects: {}\n`, "utf-8");

      const targetPath = join(customGlobalDir, "my-project", "session-abc");
      expect(shouldDestroyWorkspacePath(project, "my-project", targetPath, configPath)).toBe(true);
    });

    it("returns true if workspacePath is inside a custom per-project worktreeDir", () => {
      const customProjectDir = join(rootDir, "custom-project-worktrees");
      project.worktreeDir = customProjectDir;

      const targetPath = join(customProjectDir, "my-project", "session-xyz");
      expect(shouldDestroyWorkspacePath(project, "my-project", targetPath, configPath)).toBe(true);
    });

    it("returns true if workspacePath is inside the default clone directory", () => {
      const defaultClonePath = join(homedir(), ".ao-clones", "my-project", "session-abc");
      expect(shouldDestroyWorkspacePath(project, "my-project", defaultClonePath, configPath)).toBe(true);
    });

    it("returns true if workspacePath is inside a custom global cloneDir", () => {
      const customGlobalCloneDir = join(rootDir, "custom-global-clones");
      writeFileSync(configPath, `cloneDir: "${customGlobalCloneDir}"\nprojects: {}\n`, "utf-8");

      const targetPath = join(customGlobalCloneDir, "my-project", "session-abc");
      expect(shouldDestroyWorkspacePath(project, "my-project", targetPath, configPath)).toBe(true);
    });

    it("returns true if workspacePath is inside a custom per-project cloneDir", () => {
      const customProjectCloneDir = join(rootDir, "custom-project-clones");
      project.cloneDir = customProjectCloneDir;

      const targetPath = join(customProjectCloneDir, "my-project", "session-xyz");
      expect(shouldDestroyWorkspacePath(project, "my-project", targetPath, configPath)).toBe(true);
    });

    it("returns false if workspacePath resolves to project path via symlinks", () => {
      const symlinkedProjectPath = join(rootDir, "project-symlink");
      symlinkSync(project.path, symlinkedProjectPath);

      expect(shouldDestroyWorkspacePath(project, "my-project", symlinkedProjectPath, configPath)).toBe(false);
    });
  });
});
