import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { manifest, create } from "./index.js";
import type { AgentLaunchConfig, ProjectConfig, Session } from "@jleechanorg/ao-core";

describe("agent-minimax manifest", () => {
  it("has correct slot and name", () => {
    expect(manifest.slot).toBe("agent");
    expect(manifest.name).toBe("minimax");
  });
});

describe("agent-minimax create()", () => {
  let originalMinimaxApiKey: string | undefined;

  beforeEach(() => {
    originalMinimaxApiKey = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = "test-minimax-key-123";
  });

  afterEach(() => {
    if (originalMinimaxApiKey === undefined) {
      delete process.env.MINIMAX_API_KEY;
    } else {
      process.env.MINIMAX_API_KEY = originalMinimaxApiKey;
    }
  });

  it("returns an agent with required methods", () => {
    const agent = create();
    expect(agent).toHaveProperty("getLaunchCommand");
    expect(agent).toHaveProperty("getEnvironment");
  });

  it("sets ANTHROPIC_BASE_URL to MiniMax endpoint", () => {
    const agent = create();
    const env = agent.getEnvironment!({
      sessionId: "test-session",
      issueId: "test-1",
    } as AgentLaunchConfig);

    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.minimax.io/anthropic");
  });

  it("passes MINIMAX_API_KEY as ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY", () => {
    const agent = create();
    const env = agent.getEnvironment!({
      sessionId: "test-session",
    } as AgentLaunchConfig);

    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("test-minimax-key-123");
    expect(env.ANTHROPIC_API_KEY).toBe("test-minimax-key-123");
  });

  it("sets MiniMax model defaults when launchConfig.model is absent", () => {
    const agent = create();
    const env = agent.getEnvironment!({
      sessionId: "test-session",
    } as AgentLaunchConfig);

    expect(env.ANTHROPIC_MODEL).toBe("MiniMax-M2.7");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("MiniMax-M2.7");
  });

  it("honors launchConfig.model for ANTHROPIC_MODEL env vars", () => {
    const agent = create();
    const env = agent.getEnvironment!({
      sessionId: "test-session",
      model: "MiniMax-M2.5",
    } as AgentLaunchConfig);

    expect(env.ANTHROPIC_MODEL).toBe("MiniMax-M2.5");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("MiniMax-M2.5");
  });

  it("warns when MINIMAX_API_KEY is not set", () => {
    delete process.env.MINIMAX_API_KEY;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const agent = create();
    agent.getEnvironment!({
      sessionId: "test-session",
    } as AgentLaunchConfig);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("MINIMAX_API_KEY not set"),
    );
    warnSpy.mockRestore();
  });

  it("does not set ANTHROPIC_AUTH_TOKEN when MINIMAX_API_KEY is missing", () => {
    delete process.env.MINIMAX_API_KEY;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const agent = create();
    const env = agent.getEnvironment!({
      sessionId: "test-session",
    } as AgentLaunchConfig);

    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    warnSpy.mockRestore();
  });

  it("launch command uses claude CLI", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand({
      sessionId: "test-session",
      permissions: "permissionless",
    } as AgentLaunchConfig);

    expect(cmd).toContain("claude");
    expect(cmd).toContain("--dangerously-skip-permissions");
  });

  it("strips model from launch command (MiniMax models set via env)", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand({
      sessionId: "test-session",
      permissions: "permissionless",
      model: "claude-sonnet-4-20250514",
    } as AgentLaunchConfig);

    expect(cmd).not.toContain("claude-sonnet-4");
    expect(cmd).not.toContain("--model");
  });

  it("getRestoreCommand returns null so restore does not pass incompatible --model", async () => {
    const agent = create();
    const cmd = await agent.getRestoreCommand!(
      { id: "s1" } as Session,
      { agentConfig: { model: "claude-sonnet-4-20250514" } } as ProjectConfig,
    );
    expect(cmd).toBeNull();
  });

  it("sets AO_SESSION_ID in environment", () => {
    const agent = create();
    const env = agent.getEnvironment!({
      sessionId: "minimax-42",
    } as AgentLaunchConfig);

    expect(env.AO_SESSION_ID).toBe("minimax-42");
    expect(env.AO_SESSION).toBe("minimax-42");
  });
});
