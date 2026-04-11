import { describe, it, expect } from "vitest";
import { resolveAgentSelection, resolveSessionRole } from "../agent-selection.js";
import type { DefaultPlugins, ProjectConfig } from "../types.js";

describe("resolveAgentSelection", () => {
  it("inherits defaults.agentConfig.permissions when project agentConfig omits permissions", () => {
    const defaults: DefaultPlugins = {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: [],
      agentConfig: { permissions: "suggest" },
    };

    const project: ProjectConfig = {
      name: "app",
      repo: "o/r",
      path: "/p",
      defaultBranch: "main",
      sessionPrefix: "app",
      agentConfig: {},
    };

    const sel = resolveAgentSelection({
      role: "worker",
      project,
      defaults,
    });

    expect(sel.permissions).toBe("suggest");
  });

  it("does not treat a numbered worker from a longer prefix as an orchestrator", () => {
    expect(
      resolveSessionRole("app-orchestrator-1", undefined, "app", ["app", "app-orchestrator"]),
    ).toBe("worker");
  });

  it("only treats the exact project orchestrator id as an orchestrator", () => {
    expect(resolveSessionRole("app-orchestrator", undefined, "app", ["app"])).toBe("orchestrator");
    expect(resolveSessionRole("other-orchestrator", undefined, "app", ["app", "other"])).toBe("worker");
  });
});
