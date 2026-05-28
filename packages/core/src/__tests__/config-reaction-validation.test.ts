import { describe, it, expect } from "vitest";
import { validateReactionDefinitions } from "../config-reaction-validation.js";
import type { OrchestratorConfig } from "../types.js";

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    projects: {},
    reactions: {},
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      lock: "area-lock",
      notifiers: [],
    },
    ...overrides,
  } as OrchestratorConfig;
}

describe("validateReactionDefinitions", () => {
  it("returns empty for valid reactions", () => {
    const config = makeConfig({
      reactions: {
        "ci-failed": { auto: true, action: "send-to-agent" },
      },
    });
    const issues = validateReactionDefinitions(config);
    expect(issues).toEqual([]);
  });

  it("flags missing action in global reaction", () => {
    const config = makeConfig({
      reactions: {
        "bad-reaction": { auto: true } as any,
      },
    });
    const issues = validateReactionDefinitions(config);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.reactionKey).toBe("bad-reaction");
    expect(issues[0]!.message).toContain("action");
  });

  it("flags missing auto in global reaction", () => {
    const config = makeConfig({
      reactions: {
        "no-auto": { action: "notify" } as any,
      },
    });
    const issues = validateReactionDefinitions(config);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("auto");
  });

  it("flags missing action in project reaction", () => {
    const config = makeConfig({
      projects: {
        "my-app": {
          repo: "org/repo",
          path: "/tmp/app",
          sessionPrefix: "app",
          reactions: {
            "proj-reaction": { auto: true } as any,
          },
        } as any,
      },
    });
    const issues = validateReactionDefinitions(config);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.scope).toBe("project");
    expect(issues[0]!.projectId).toBe("my-app");
  });
});
