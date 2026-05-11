import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentLaunchConfig } from "@jleechanorg/ao-core";
import {
  create,
  manifest,
  DEFAULT_WAFER_ANTHROPIC_BASE_URL,
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

describe("agent-wafer plugin", () => {
  const prevEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...prevEnv };
  });

  afterEach(() => {
    process.env = { ...prevEnv };
  });

  it("exports manifest", () => {
    expect(manifest.name).toBe("wafer");
    expect(manifest.slot).toBe("agent");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
    expect(typeof defaultExport.detect).toBe("function");
  });

  it("create() returns agent named wafer with claude processName", () => {
    const agent = create();
    expect(agent.name).toBe("wafer");
    expect(agent.processName).toBe("claude");
  });
});

describe("getLaunchCommand", () => {
  const prevEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...prevEnv };
    delete process.env.WAFER_MODEL;
  });

  afterEach(() => {
    process.env = { ...prevEnv };
  });

  it("includes default model GLM-5.1 when WAFER_MODEL is unset", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ model: "claude-sonnet-4-20250514", permissions: "default" }),
    );
    expect(cmd).toMatch(/--model\s+'?GLM-5\.1'?/);
  });

  it("includes WAFER_MODEL when set", () => {
    process.env.WAFER_MODEL = "GLM-5.5";
    const agent = create();
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ model: "claude-sonnet-4-20250514", permissions: "default" }),
    );
    expect(cmd).toMatch(/--model\s+'?GLM-5\.5'?/);
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
    delete process.env.WAFER_API_KEY;
    delete process.env.WAFER_ANTHROPIC_BASE_URL;
    delete process.env.WAFER_MODEL;
  });

  afterEach(() => {
    process.env = { ...prevEnv };
  });

  it("sets ANTHROPIC_BASE_URL to default when WAFER_ANTHROPIC_BASE_URL is unset", () => {
    process.env.WAFER_API_KEY = "sk-test";
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["ANTHROPIC_BASE_URL"]).toBe(DEFAULT_WAFER_ANTHROPIC_BASE_URL);
  });

  it("respects WAFER_ANTHROPIC_BASE_URL override", () => {
    process.env.WAFER_API_KEY = "sk-test";
    process.env.WAFER_ANTHROPIC_BASE_URL = "https://custom.wafer.ai";
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://custom.wafer.ai");
  });

  it("maps WAFER_API_KEY to ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY", () => {
    process.env.WAFER_API_KEY = "sk-wafer-xyz";
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("sk-wafer-xyz");
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-wafer-xyz");
  });

  it("sets ANTHROPIC_MODEL when WAFER_MODEL is set", () => {
    process.env.WAFER_API_KEY = "sk-test";
    process.env.WAFER_MODEL = "GLM-5.5";
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["ANTHROPIC_MODEL"]).toBe("GLM-5.5");
  });

  it("logs debug with source attribution when WAFER_API_KEY is resolved", () => {
    process.env.WAFER_API_KEY = "sk-test";
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const agent = create();
    agent.getEnvironment(makeLaunchConfig());
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining("[ao-plugin-agent-wafer] WAFER_API_KEY resolved"),
    );
    debug.mockRestore();
  });

  it("logs error with actionable advice when WAFER_API_KEY is missing", () => {
    delete process.env.WAFER_API_KEY;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const agent = create();
    agent.getEnvironment(makeLaunchConfig());
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("WAFER_API_KEY not found"),
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
