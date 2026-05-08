import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentLaunchConfig } from "@jleechanorg/ao-core";
import {
  create,
  manifest,
  DEFAULT_MINIMAX_ANTHROPIC_BASE_URL,
  default as defaultExport,
} from "./index.js";

function makeLaunchConfig(overrides: Partial<AgentLaunchConfig> = {}): AgentLaunchConfig {
  return {
    sessionId: "sess-1",
    projectConfig: {
      name: "my-project",
      repo: "owner/repo",
      path: "/workspace/repo",
      defaultBranch: "main",
      sessionPrefix: "my",
    },
    ...overrides,
  };
}

describe("agent-minimax plugin", () => {
  const prevEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...prevEnv };
  });

  afterEach(() => {
    process.env = { ...prevEnv };
  });

  it("exports manifest", () => {
    expect(manifest.name).toBe("minimax");
    expect(manifest.slot).toBe("agent");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
    expect(typeof defaultExport.detect).toBe("function");
  });

  it("create() returns agent named minimax with claude processName", () => {
    const agent = create();
    expect(agent.name).toBe("minimax");
    expect(agent.processName).toBe("claude");
  });
});

describe("getLaunchCommand", () => {
  const prevEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...prevEnv };
  });

  afterEach(() => {
    process.env = { ...prevEnv };
  });

  it("strips --model (MiniMax models differ from Anthropic IDs)", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ model: "claude-sonnet-4-20250514", permissions: "default" }),
    );
    expect(cmd).not.toContain("--model");
  });

  it("passes permissionless flag when requested", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "permissionless" }));
    expect(cmd).toContain("--dangerously-skip-permissions");
  });
});

describe("getEnvironment", () => {
  const prevEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...prevEnv };
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_ANTHROPIC_BASE_URL;
    delete process.env.MINIMAX_MODEL;
  });

  afterEach(() => {
    process.env = { ...prevEnv };
  });

  it("sets ANTHROPIC_BASE_URL to default when MINIMAX_ANTHROPIC_BASE_URL is unset", () => {
    process.env.MINIMAX_API_KEY = "sk-test";
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["ANTHROPIC_BASE_URL"]).toBe(DEFAULT_MINIMAX_ANTHROPIC_BASE_URL);
  });

  it("respects MINIMAX_ANTHROPIC_BASE_URL override", () => {
    process.env.MINIMAX_API_KEY = "sk-test";
    process.env.MINIMAX_ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://api.minimaxi.com/anthropic");
  });

  it("maps MINIMAX_API_KEY to ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY", () => {
    process.env.MINIMAX_API_KEY = "sk-minimax-xyz";
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("sk-minimax-xyz");
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-minimax-xyz");
  });

  it("sets ANTHROPIC_MODEL when MINIMAX_MODEL is set", () => {
    process.env.MINIMAX_API_KEY = "sk-test";
    process.env.MINIMAX_MODEL = "MiniMax-M2.7";
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["ANTHROPIC_MODEL"]).toBe("MiniMax-M2.7");
  });

  it("logs info with source attribution when MINIMAX_API_KEY is resolved", () => {
    process.env.MINIMAX_API_KEY = "sk-test";
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const agent = create();
    agent.getEnvironment(makeLaunchConfig());
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("[ao-plugin-agent-minimax] MINIMAX_API_KEY resolved"),
    );
    info.mockRestore();
  });

  it("logs error with actionable advice when MINIMAX_API_KEY is missing", () => {
    delete process.env.MINIMAX_API_KEY;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const agent = create();
    agent.getEnvironment(makeLaunchConfig());
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("MINIMAX_API_KEY not found"),
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining("envSource"));
    error.mockRestore();
  });
});

describe("getRestoreCommand", () => {
  it("returns null so launch does not pass incompatible --model on resume", async () => {
    const agent = create();
    await expect(
      agent.getRestoreCommand!(
        {
          id: "s1",
          projectId: "p",
          status: "working",
          activity: "active",
          branch: null,
          issueId: null,
          pr: null,
          workspacePath: "/tmp/w",
          runtimeHandle: null,
          agentInfo: null,
          createdAt: new Date(),
          lastActivityAt: new Date(),
          metadata: {},
        },
        {
          name: "p",
          repo: "o/r",
          path: "/tmp/w",
          defaultBranch: "main",
          sessionPrefix: "x",
        },
      ),
    ).resolves.toBeNull();
  });
});
