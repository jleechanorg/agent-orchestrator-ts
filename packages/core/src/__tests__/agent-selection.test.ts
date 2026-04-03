import { describe, it, expect } from "vitest";
import { resolveAgentSelection } from "../agent-selection.js";
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
});
