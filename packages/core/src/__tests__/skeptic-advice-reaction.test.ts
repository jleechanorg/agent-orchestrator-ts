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

function makeRegistry(scm: SCM): PluginRegistry {
  return {
    get: vi.fn().mockReturnValue(scm),
  } as unknown as PluginRegistry;
}

describe("buildReactionContext skeptic-advice", () => {
  it("returns extracted skeptic sections from a FAIL comment", async () => {
    const scm = {
      name: "mock-scm",
      getSkepticComments: vi.fn().mockResolvedValue([
        {
          id: 100,
          body: `VERDICT: FAIL\n\n## Background\nThe PR introduced a regression in the merge gate.\n\n## Current Problem\nThe action plan does not account for CI failures when CR approved.\n\n## Recommended Solution\nAdd a CI check before posting the green signal.`,
          user: { login: "jleechan2015" },
        },
      ]),
    } as unknown as SCM;

    const result = await buildReactionContext(
      "skeptic-advice",
      makeSession(),
      "my-app",
      makeConfig(),
      makeRegistry(scm),
    );

    expect(result).toContain("## Background");
    expect(result).toContain("regression in the merge gate");
    expect(result).toContain("## Current Problem");
    expect(result).toContain("CI check");
    expect(result).toContain("## Recommended Solution");
    expect(result).toContain("green signal");
  });

  it("returns empty string when there are no skeptic comments", async () => {
    const scm = {
      name: "mock-scm",
      getSkepticComments: vi.fn().mockResolvedValue([]),
    } as unknown as SCM;

    const result = await buildReactionContext(
      "skeptic-advice",
      makeSession(),
      "my-app",
      makeConfig(),
      makeRegistry(scm),
    );

    expect(result).toBe("");
  });

  it("returns empty string when skeptic comments exist but none contain FAIL", async () => {
    const scm = {
      name: "mock-scm",
      getSkepticComments: vi.fn().mockResolvedValue([
        {
          id: 100,
          body: "VERDICT: PASS — all checks passed",
          user: { login: "jleechan2015" },
        },
      ]),
    } as unknown as SCM;

    const result = await buildReactionContext(
      "skeptic-advice",
      makeSession(),
      "my-app",
      makeConfig(),
      makeRegistry(scm),
    );

    expect(result).toBe("");
  });

  it("uses the most recent FAIL comment when multiple FAIL comments exist", async () => {
    const scm = {
      name: "mock-scm",
      getSkepticComments: vi.fn().mockResolvedValue([
        {
          id: 50,
          body: "VERDICT: FAIL — old problem",
          user: { login: "jleechan2015" },
        },
        {
          id: 200,
          body: `VERDICT: FAIL\n\n## Background\nNewest FAIL comment\n\n## Recommended Solution\nUse the latest version`,
          user: { login: "jleechan2015" },
        },
      ]),
    } as unknown as SCM;

    const result = await buildReactionContext(
      "skeptic-advice",
      makeSession(),
      "my-app",
      makeConfig(),
      makeRegistry(scm),
    );

    expect(result).toContain("Newest FAIL comment");
    expect(result).toContain("latest version");
    expect(result).not.toContain("old problem");
  });

  it("falls back to raw body when no ## sections are found in FAIL comment", async () => {
    const scm = {
      name: "mock-scm",
      getSkepticComments: vi.fn().mockResolvedValue([
        {
          id: 100,
          body: "VERDICT: FAIL — test coverage is insufficient. Add more tests.",
          user: { login: "jleechan2015" },
        },
      ]),
    } as unknown as SCM;

    const result = await buildReactionContext(
      "skeptic-advice",
      makeSession(),
      "my-app",
      makeConfig(),
      makeRegistry(scm),
    );

    expect(result).toContain("test coverage");
    expect(result).toContain("FAIL");
  });

  it("returns empty string when SCM does not implement getSkepticComments", async () => {
    const scm = {
      name: "mock-scm",
    } as unknown as SCM;

    const result = await buildReactionContext(
      "skeptic-advice",
      makeSession(),
      "my-app",
      makeConfig(),
      makeRegistry(scm),
    );

    expect(result).toBe("");
  });

  it("returns empty string when session has no PR", async () => {
    const scm = {
      name: "mock-scm",
      getSkepticComments: vi.fn().mockResolvedValue([{ id: 1, body: "FAIL", user: { login: "x" } }]),
    } as unknown as SCM;

    const result = await buildReactionContext(
      "skeptic-advice",
      makeSession({ pr: null }),
      "my-app",
      makeConfig(),
      makeRegistry(scm),
    );

    expect(result).toBe("");
  });
});
