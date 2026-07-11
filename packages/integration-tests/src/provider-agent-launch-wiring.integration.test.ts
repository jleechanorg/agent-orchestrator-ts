/**
 * Asserts provider agent plugins wire getLaunchCommand / getEnvironment the same way
 * production orchestration does (no tmux, no API calls).
 */

import { afterEach, describe, expect, it } from "vitest";
import type { AgentLaunchConfig } from "@jleechanorg/ao-core";
import claudeCodePlugin from "@jleechanorg/ao-plugin-agent-claude-code";
import minimaxPlugin from "@jleechanorg/ao-plugin-agent-minimax";
import waferPlugin from "@jleechanorg/ao-plugin-agent-wafer";

function makeLaunchConfig(overrides: Partial<AgentLaunchConfig> = {}): AgentLaunchConfig {
  return {
    sessionId: "launch-wire-1",
    projectConfig: {
      name: "wire",
      repo: "jleechanorg/agent-orchestrator-ts",
      path: "/workspace",
      defaultBranch: "main",
      sessionPrefix: "w",
    },
    ...overrides,
  };
}

describe("provider launch wiring (integration)", () => {
  const prev = { ...process.env };

  afterEach(() => {
    process.env = { ...prev };
  });

  it("minimax getLaunchCommand + getEnvironment set Anthropic-compatible MiniMax endpoint", () => {
    process.env.MINIMAX_API_KEY = "sk-test-minimax";
    delete process.env.MINIMAX_ANTHROPIC_BASE_URL;
    delete process.env.MINIMAX_MODEL;
    const agent = minimaxPlugin.create();
    const cfg = makeLaunchConfig({ permissions: "permissionless" });
    expect(agent.getLaunchCommand(cfg)).toContain("claude");
    expect(agent.getLaunchCommand(cfg)).toContain("--dangerously-skip-permissions");
    const env = agent.getEnvironment(cfg);
    expect(env["ANTHROPIC_BASE_URL"]).toMatch(/minimax/i);
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-test-minimax");
  });

  it("wafer getLaunchCommand + getEnvironment set Wafer endpoint and model", () => {
    process.env.WAFER_API_KEY = "sk-test-wafer";
    process.env.WAFER_MODEL = "GLM-5.1";
    delete process.env.WAFER_ANTHROPIC_BASE_URL;
    const agent = waferPlugin.create();
    const cfg = makeLaunchConfig({ permissions: "permissionless" });
    const cmd = agent.getLaunchCommand(cfg);
    expect(cmd).toContain("claude");
    expect(cmd).toMatch(/GLM-5\.1/);
    const env = agent.getEnvironment(cfg);
    expect(env["ANTHROPIC_BASE_URL"]).toMatch(/wafer/i);
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-test-wafer");
  });

  it("claude-code Z.AI model maps getLaunchCommand through z.ai base URL + GLM model id", () => {
    process.env.GLM_API_KEY = "sk-test-glm";
    const agent = claudeCodePlugin.create();
    const cfg = makeLaunchConfig({ model: "z.ai/GLM-5.1", permissions: "permissionless" });
    const cmd = agent.getLaunchCommand(cfg);
    expect(cmd).toContain("api.z.ai");
    expect(cmd).toMatch(/GLM-5\.1/);
    const env = agent.getEnvironment(cfg);
    expect(env["ANTHROPIC_BASE_URL"]).toMatch(/z\.ai/);
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-test-glm");
  });
});
