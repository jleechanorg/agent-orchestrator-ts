import { describe, it, expect, vi } from "vitest";
import { buildReactionContext } from "../reaction-context.js";
import type {
  Session,
  SCM,
  PluginRegistry,
  OrchestratorConfig,
  PRInfo,
} from "../types.js";

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    url: "https://github.com/acme/app/pull/42",
    title: "feat: add widget",
    owner: "acme",
    repo: "app",
    branch: "feat/widget",
    baseBranch: "main",
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: makePR(),
    workspacePath: "/tmp/ws",
    runtimeHandle: { id: "rt-1", runtimeName: "mock", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeConfig(): OrchestratorConfig {
  return {
    dataDir: "/tmp/ao",
    port: 3020,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects: {
      "my-app": {
        name: "My App",
        repo: "acme/app",
        path: "/tmp/app",
        defaultBranch: "main",
        sessionPrefix: "app",
        scm: { plugin: "github" },
      },
    },
    reactions: {},
    notifiers: {},
  } as unknown as OrchestratorConfig;
}

function makeSCM(overrides: Partial<SCM> = {}): SCM {
  return {
    getCIChecks: vi.fn().mockResolvedValue([]),
    getPendingComments: vi.fn().mockResolvedValue([]),
    getMergeability: vi.fn().mockResolvedValue({ noConflicts: true, blockers: [] }),
    ...overrides,
  } as unknown as SCM;
}

function makeRegistry(scm: SCM): PluginRegistry {
  return {
    get: vi.fn().mockReturnValue(scm),
  } as unknown as PluginRegistry;
}

describe("buildReactionContext", () => {
  describe("ci-failed", () => {
    it("returns failing check names and URLs", async () => {
      const scm = makeSCM({
        getCIChecks: vi.fn().mockResolvedValue([
          { name: "Test", status: "failed", url: "https://ci/1" },
          { name: "Lint", status: "passed" },
        ]),
      });
      const result = await buildReactionContext(
        "ci-failed",
        makeSession(),
        "my-app",
        makeConfig(),
        makeRegistry(scm),
      );
      expect(result).toContain("Test");
      expect(result).toContain("https://ci/1");
      expect(result).not.toContain("Lint");
    });
  });

  describe("changes-requested", () => {
    it("returns unresolved review comments", async () => {
      const scm = makeSCM({
        getPendingComments: vi.fn().mockResolvedValue([
          { path: "src/foo.ts", line: 10, body: "Fix the null check here" },
        ]),
      });
      const result = await buildReactionContext(
        "changes-requested",
        makeSession(),
        "my-app",
        makeConfig(),
        makeRegistry(scm),
      );
      expect(result).toContain("src/foo.ts");
      expect(result).toContain("Fix the null check here");
    });
  });

  describe("agent-needs-input", () => {
    it("returns PR status summary with CI and review info", async () => {
      const scm = makeSCM({
        getCIChecks: vi.fn().mockResolvedValue([
          { name: "Test", status: "failed", url: "https://ci/1" },
          { name: "Lint", status: "passed" },
        ]),
        getPendingComments: vi.fn().mockResolvedValue([
          { path: "src/bar.ts", line: 5, body: "Add error handling" },
        ]),
      });
      const result = await buildReactionContext(
        "agent-needs-input",
        makeSession(),
        "my-app",
        makeConfig(),
        makeRegistry(scm),
      );
      expect(result).toContain("PR #42");
      expect(result).toContain("Test");
      expect(result).toContain("1 failing");
      expect(result).toContain("1 unresolved comment");
      expect(result).toContain("gh api repos/acme/app/pulls/42/comments");
    });

    it("returns all-clear summary when nothing is wrong", async () => {
      const scm = makeSCM({
        getCIChecks: vi.fn().mockResolvedValue([
          { name: "Test", status: "passed" },
        ]),
        getPendingComments: vi.fn().mockResolvedValue([]),
      });
      const result = await buildReactionContext(
        "agent-needs-input",
        makeSession(),
        "my-app",
        makeConfig(),
        makeRegistry(scm),
      );
      expect(result).toContain("PR #42");
      expect(result).toContain("all passing");
    });

    it("returns empty string when no PR", async () => {
      const scm = makeSCM();
      const result = await buildReactionContext(
        "agent-needs-input",
        makeSession({ pr: null }),
        "my-app",
        makeConfig(),
        makeRegistry(scm),
      );
      expect(result).toBe("");
    });
  });

  describe("agent-stuck", () => {
    it("returns PR status summary same as agent-needs-input", async () => {
      const scm = makeSCM({
        getCIChecks: vi.fn().mockResolvedValue([
          { name: "Build", status: "failed", url: "https://ci/2" },
        ]),
        getPendingComments: vi.fn().mockResolvedValue([]),
      });
      const result = await buildReactionContext(
        "agent-stuck",
        makeSession(),
        "my-app",
        makeConfig(),
        makeRegistry(scm),
      );
      expect(result).toContain("PR #42");
      expect(result).toContain("Build");
      expect(result).toContain("1 failing");
    });
  });

  describe("unknown reaction key", () => {
    it("returns empty string", async () => {
      const scm = makeSCM();
      const result = await buildReactionContext(
        "unknown-reaction",
        makeSession(),
        "my-app",
        makeConfig(),
        makeRegistry(scm),
      );
      expect(result).toBe("");
    });
  });
});
