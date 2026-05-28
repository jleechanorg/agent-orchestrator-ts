import { describe, it, expect } from "vitest";
import {
  resolveAgentStartupTimeout,
  augmentAgentConfigWithTimeout,
  DEFAULT_AGENT_STARTUP_TIMEOUT_MS,
} from "../plugin-agent-timeout.js";
import type { OrchestratorConfig, AgentSpecificConfig } from "../types.js";

function makeConfig(overrides: Record<string, unknown> = {}): OrchestratorConfig {
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

describe("resolveAgentStartupTimeout", () => {
  it("returns default when no config", () => {
    const config = makeConfig();
    expect(resolveAgentStartupTimeout(config, "missing")).toBe(DEFAULT_AGENT_STARTUP_TIMEOUT_MS);
  });

  it("uses project-level timeout when set", () => {
    const config = makeConfig({
      projects: {
        "my-app": {
          repo: "org/repo",
          path: "/tmp/app",
          sessionPrefix: "app",
          agentConfig: { startupTimeoutMs: 30000 },
        },
      },
    } as any);
    expect(resolveAgentStartupTimeout(config as OrchestratorConfig, "my-app")).toBe(30000);
  });

  it("falls back to defaults timeout", () => {
    const config = {
      projects: {},
      reactions: {},
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        lock: "area-lock",
        notifiers: [] as string[],
        agentConfig: { startupTimeoutMs: 60000 } as any,
      },
    } as OrchestratorConfig;
    expect(resolveAgentStartupTimeout(config, "missing")).toBe(60000);
  });
});

describe("augmentAgentConfigWithTimeout", () => {
  it("does not override existing timeout", () => {
    const config: AgentSpecificConfig = { startupTimeoutMs: 5000, permissions: "permissionless" };
    const result = augmentAgentConfigWithTimeout(config, 30000);
    expect(result.startupTimeoutMs).toBe(5000);
  });

  it("adds timeout when missing", () => {
    const config: AgentSpecificConfig = { permissions: "permissionless" };
    const result = augmentAgentConfigWithTimeout(config, 30000);
    expect(result.startupTimeoutMs).toBe(30000);
  });
});
