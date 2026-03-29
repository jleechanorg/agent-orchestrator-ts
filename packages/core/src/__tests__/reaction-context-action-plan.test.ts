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
    number: 123,
    url: "https://github.com/org/repo/pull/123",
    title: "feat: gate closure action plans",
    owner: "org",
    repo: "repo",
    branch: "feat/gate-closure",
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

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    dataDir: "/tmp/ao",
    port: 3020,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/repo",
        path: "/tmp/app",
        defaultBranch: "main",
        sessionPrefix: "app",
        scm: { plugin: "github" },
        mergeGate: { enabled: true },
      },
    },
    reactions: {},
    notifiers: {},
    ...overrides,
  } as unknown as OrchestratorConfig;
}

function makeSCM(overrides: Partial<SCM> = {}): SCM {
  return {
    getCISummary: vi.fn().mockResolvedValue("failing"),
    getCIChecks: vi.fn().mockResolvedValue([{ name: "test:unit", status: "failed", url: "" }]),
    getPendingComments: vi.fn().mockResolvedValue([]),
    getMergeability: vi.fn().mockResolvedValue({ noConflicts: true, blockers: [] }),
    getReviews: vi.fn().mockResolvedValue([]),
    getAutomatedComments: vi.fn().mockResolvedValue([]),
    getPRInfo: vi.fn().mockResolvedValue(makePR()),
    ...overrides,
  } as unknown as SCM;
}

function makeRegistry(scm: SCM): PluginRegistry {
  return {
    get: vi.fn().mockReturnValue(scm),
  } as unknown as PluginRegistry;
}

describe("buildReactionContext with action plan", () => {
  it("appends action plan to changes-requested context with failing CI", async () => {
    const scm = makeSCM({
      getPendingComments: vi.fn().mockResolvedValue([]),
      getCISummary: vi.fn().mockResolvedValue("failing"),
    });
    const result = await buildReactionContext(
      "changes-requested",
      makeSession(),
      "my-app",
      makeConfig(),
      makeRegistry(scm),
    );
    expect(result).toContain("ACTION PLAN");
    expect(result).toContain("CI green");
  });

  it("appends action plan to agent-stuck context", async () => {
    const scm = makeSCM({
      getCIChecks: vi.fn().mockResolvedValue([{ name: "Test", status: "failed", url: "" }]),
      getPendingComments: vi.fn().mockResolvedValue([]),
      getCISummary: vi.fn().mockResolvedValue("failing"),
    });
    const result = await buildReactionContext(
      "agent-stuck",
      makeSession(),
      "my-app",
      makeConfig(),
      makeRegistry(scm),
    );
    expect(result).toContain("PR #123");
    expect(result).toContain("ACTION PLAN");
  });

  it("appends action plan to agent-needs-input context", async () => {
    const scm = makeSCM({
      getCIChecks: vi.fn().mockResolvedValue([{ name: "Lint", status: "failed", url: "" }]),
      getPendingComments: vi.fn().mockResolvedValue([]),
      getCISummary: vi.fn().mockResolvedValue("failing"),
    });
    const result = await buildReactionContext(
      "agent-needs-input",
      makeSession(),
      "my-app",
      makeConfig(),
      makeRegistry(scm),
    );
    expect(result).toContain("PR #123");
    expect(result).toContain("ACTION PLAN");
  });

  it("includes review comments AND action plan in changes-requested", async () => {
    const scm = makeSCM({
      getPendingComments: vi.fn().mockResolvedValue([
        { path: "src/foo.ts", line: 10, body: "Fix the null check here", isResolved: false, author: "reviewer" },
      ]),
      getCISummary: vi.fn().mockResolvedValue("failing"),
    });
    const result = await buildReactionContext(
      "changes-requested",
      makeSession(),
      "my-app",
      makeConfig(),
      makeRegistry(scm),
    );
    expect(result).toContain("Unresolved review comments");
    expect(result).toContain("ACTION PLAN");
    expect(result).toContain("src/foo.ts");
  });
});
