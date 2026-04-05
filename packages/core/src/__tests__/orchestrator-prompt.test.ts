import { describe, expect, it } from "vitest";
import { generateOrchestratorPrompt } from "../orchestrator-prompt.js";
import type { OrchestratorConfig } from "../types.js";

function makeEvolveLoopConfig(overrides: Record<string, unknown> = {}): OrchestratorConfig {
  return {
    configPath: "/tmp/agent-orchestrator.yaml",
    port: 3000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: "/tmp/my-app",
        defaultBranch: "main",
        sessionPrefix: "app",
        evolveLoop: { enabled: true, ...overrides },
      },
    },
    notifiers: {},
    notificationRouting: {
      urgent: ["desktop"],
      action: ["desktop"],
      warning: [],
      info: [],
    },
    reactions: {},
    readyThresholdMs: 300_000,
    startupGracePeriodMs: 120_000,
  };
}

const config: OrchestratorConfig = {
  configPath: "/tmp/agent-orchestrator.yaml",
  port: 3000,
  defaults: {
    runtime: "tmux",
    agent: "claude-code",
    workspace: "worktree",
    notifiers: ["desktop"],
  },
  projects: {
    "my-app": {
      name: "My App",
      repo: "org/my-app",
      path: "/tmp/my-app",
      defaultBranch: "main",
      sessionPrefix: "app",
    },
  },
  notifiers: {},
  notificationRouting: {
    urgent: ["desktop"],
    action: ["desktop"],
    warning: [],
    info: [],
  },
  reactions: {},
  readyThresholdMs: 300_000,
  startupGracePeriodMs: 120_000,
};

describe("generateOrchestratorPrompt", () => {
  it("requires read-only investigation from the orchestrator session", () => {
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("Investigations from the orchestrator session are **read-only**");
    expect(prompt).toContain("do not edit repository files or implement fixes");
  });

  it("pushes implementation and PR claiming into worker sessions", () => {
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("must be delegated to a **worker session**");
    expect(prompt).toContain("Never claim a PR into `app-orchestrator`");
    expect(prompt).toContain("Delegate implementation, test execution, or PR claiming");
  });
});

describe("generateOrchestratorPrompt — healthy-cycle fast path (bd-l5ko)", () => {
  it("includes healthy-cycle fast-path instruction in Phase 1", () => {
    const cfg = makeEvolveLoopConfig();
    const prompt = generateOrchestratorPrompt({
      config: cfg,
      projectId: "my-app",
      project: cfg.projects["my-app"]!,
    });

    // Should contain the one-line output format (unicode checkmark + em dash)
    expect(prompt).toContain("\u2713 Cycle N: all clear \u2014 N workers alive, N open PRs");
    // Should explicitly say to skip remaining phases
    expect(prompt).toContain("skip Phase 2 through Phase 6 entirely");
  });

  it("includes session budget instruction in Phase 1", () => {
    const cfg = makeEvolveLoopConfig();
    const prompt = generateOrchestratorPrompt({
      config: cfg,
      projectId: "my-app",
      project: cfg.projects["my-app"]!,
    });

    // Should mention the trigger conditions
    expect(prompt).toContain("6 hours or 36+ cycles");
    // Should mention the action to take
    expect(prompt).toContain("SESSION BUDGET");
    expect(prompt).toContain("/clear");
  });

  it("includes handoff file path in session budget instruction", () => {
    const cfg = makeEvolveLoopConfig({ knowledgeBaseDir: "/tmp/kb" });
    const prompt = generateOrchestratorPrompt({
      config: cfg,
      projectId: "my-app",
      project: cfg.projects["my-app"]!,
    });

    // Assert the resolved path, not a literal placeholder
    expect(prompt).toContain("/tmp/kb/my-app-handoff.md");
    expect(prompt).toContain("last 5 findings");
  });
});
