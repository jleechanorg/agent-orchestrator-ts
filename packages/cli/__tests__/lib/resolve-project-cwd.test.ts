/**
 * Tests for resolveProjectByCwd — cwd-based project auto-selection.
 *
 * Covers the three scenarios CR requested:
 * 1. cwd matches exact project path  → auto-selects that project
 * 2. cwd is a subdirectory of a project → auto-selects that project
 * 3. cwd matches no configured project → returns null
 */

import { describe, it, expect } from "vitest";
import { resolveProjectByCwd } from "../../src/lib/resolve-project-cwd.js";
import type { OrchestratorConfig, ProjectConfig } from "@jleechanorg/ao-core";

function makeConfig(projects: Record<string, ProjectConfig>): OrchestratorConfig {
  return {
    configPath: "/fake/config.yaml",
    port: 3000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: ["desktop"] },
    projects,
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  } as OrchestratorConfig;
}

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "Test Project",
    repo: "org/test",
    path: "/fake/repo",
    defaultBranch: "main",
    sessionPrefix: "tst",
    ...overrides,
  } as ProjectConfig;
}

describe("resolveProjectByCwd", () => {
  it("returns the project when cwd exactly matches a project path", () => {
    const config = makeConfig({
      frontend: makeProject({ name: "Frontend", path: "/projects/frontend" }),
      backend: makeProject({ name: "Backend", path: "/projects/backend" }),
    });

    const result = resolveProjectByCwd({ config, currentDir: "/projects/frontend" });

    expect(result).not.toBeNull();
    expect(result!.projectId).toBe("frontend");
    expect(result!.project.name).toBe("Frontend");
  });

  it("returns the project when cwd is a subdirectory of a project", () => {
    const config = makeConfig({
      frontend: makeProject({ name: "Frontend", path: "/projects/frontend" }),
      backend: makeProject({ name: "Backend", path: "/projects/backend" }),
    });

    const result = resolveProjectByCwd({ config, currentDir: "/projects/frontend/src/components" });

    expect(result).not.toBeNull();
    expect(result!.projectId).toBe("frontend");
    expect(result!.project.name).toBe("Frontend");
  });

  it("returns null when cwd does not match any configured project", () => {
    const config = makeConfig({
      frontend: makeProject({ name: "Frontend", path: "/projects/frontend" }),
      backend: makeProject({ name: "Backend", path: "/projects/backend" }),
    });

    const result = resolveProjectByCwd({ config, currentDir: "/other/path" });

    expect(result).toBeNull();
  });

  it("prefers the most specific (deepest) match when cwd is inside multiple projects", () => {
    // /projects contains both "parent" and "child" — deeper match should win
    const config = makeConfig({
      parent: makeProject({ name: "Parent", path: "/projects" }),
      child: makeProject({ name: "Child", path: "/projects/child" }),
    });

    const result = resolveProjectByCwd({ config, currentDir: "/projects/child/src" });

    // Both /projects and /projects/child match — deepest/longest path should win
    expect(result).not.toBeNull();
    expect(result!.projectId).toBe("child");
    expect(result!.project.name).toBe("Child");
  });
});
