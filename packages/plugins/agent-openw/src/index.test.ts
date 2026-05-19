import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig } from "@jleechanorg/ao-core";

const mockExecFileAsync = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      const result = mockExecFileAsync(...args.slice(0, -1));
      if (result && typeof result.then === "function") {
        result
          .then((r: { stdout: string; stderr: string }) => callback(null, r))
          .catch((e: Error) => callback(e));
      }
    }
  },
}));

import {
  create,
  manifest,
  DEFAULT_OPENW_OPENAI_BASE_URL,
  DEFAULT_OPENW_MODEL,
  default as defaultExport,
} from "./index.js";

function _makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test-project",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/workspace/test",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeTmuxHandle(id = "test-session"): RuntimeHandle {
  return { id, runtimeName: "tmux", data: {} };
}
function makeProcessHandle(pid?: number | string): RuntimeHandle {
  return { id: "proc-1", runtimeName: "process", data: pid !== undefined ? { pid } : {} };
}
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
function mockTmuxWithProcess(processName: string, found = true) {
  mockExecFileAsync.mockImplementation((cmd: string) => {
    if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
    if (cmd === "ps") {
      const line = found ? `  789 ttys003  ${processName}` : "  789 ttys003  bash";
      return Promise.resolve({
        stdout: `  PID TT       ARGS\n${line}\n`,
        stderr: "",
      });
    }
    return Promise.reject(new Error("unexpected"));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("plugin manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "openw",
      slot: "agent",
      description: "Agent plugin: OpenW (Wafer via OpenCode)",
      version: "0.1.0",
      displayName: "OpenW (Wafer via OpenCode)",
    });
  });

  it("create() returns agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("openw");
    expect(agent.processName).toBe("opencode");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
    expect(typeof defaultExport.detect).toBe("function");
  });

  it("exports correct default constants", () => {
    expect(DEFAULT_OPENW_OPENAI_BASE_URL).toBe("https://pass.wafer.ai/v1");
    expect(DEFAULT_OPENW_MODEL).toBe("wafer.ai/GLM-5.1");
  });
});

describe("getLaunchCommand", () => {
  const prevEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...prevEnv };
    delete process.env.OPENW_MODEL;
  });

  it("always includes stripped --model (GLM-5.1) with default env", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    // Provider prefix is stripped before passing to opencode binary
    expect(cmd).toContain("--model 'GLM-5.1'");
    expect(cmd).not.toContain("--model 'wafer.ai/GLM-5.1'");
  });

  it("respects OPENW_MODEL env override and strips prefix", () => {
    process.env.OPENW_MODEL = "wafer.ai/Qwen3.5-397B-A17B";
    const agent = create();
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toContain("--model 'Qwen3.5-397B-A17B'");
    expect(cmd).not.toContain("--model 'wafer.ai/Qwen3.5-397B-A17B'");
  });

  it("rejects provider-only prefix with no model name", () => {
    process.env.OPENW_MODEL = "wafer.ai/";
    const agent = create();
    expect(() => agent.getLaunchCommand(makeLaunchConfig())).toThrow(
      "provider prefix with no model name",
    );
  });

  it("includes --prompt with shell-escaped prompt", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix it" }));
    expect(cmd).toContain("--prompt 'Fix it'");
  });

  it("includes --agent flag when subagent is provided", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ subagent: "sisyphus" }));
    expect(cmd).toContain("--agent 'sisyphus'");
  });

  it("strips provider prefix before passing to opencode binary", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toContain("--model 'GLM-5.1'");
    expect(cmd).not.toContain("--model 'wafer.ai/GLM-5.1'");
  });

  it("uses existing session id when provided", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        projectConfig: {
          name: "my-project",
          repo: "owner/repo",
          path: "/workspace/repo",
          defaultBranch: "main",
          sessionPrefix: "my",
          agentConfig: { opencodeSessionId: "ses_abc123" },
        },
        prompt: "continue",
      }),
    );
    expect(cmd).toBe("opencode --session 'ses_abc123' --prompt 'continue' --model 'GLM-5.1'");
  });
});

describe("getEnvironment", () => {
  const prevEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...prevEnv };
    delete process.env.WAFER_API_KEY;
    delete process.env.OPENW_OPENAI_BASE_URL;
    delete process.env.MCP_AGENT_MAIL_URL;
    delete process.env.MCP_AGENT_MAIL_TOKEN;
  });

  it("sets OPENAI_BASE_URL to wafer by default", () => {
    process.env.WAFER_API_KEY = "sk-test";
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["OPENAI_BASE_URL"]).toBe(DEFAULT_OPENW_OPENAI_BASE_URL);
  });

  it("respects OPENW_OPENAI_BASE_URL override", () => {
    process.env.WAFER_API_KEY = "sk-test";
    process.env.OPENW_OPENAI_BASE_URL = "https://custom.wafer.ai/v1";
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["OPENAI_BASE_URL"]).toBe("https://custom.wafer.ai/v1");
  });

  it("maps WAFER_API_KEY to OPENAI_API_KEY", () => {
    process.env.WAFER_API_KEY = "sk-wafer-xyz";
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["OPENAI_API_KEY"]).toBe("sk-wafer-xyz");
  });

  it("sets AO_SESSION_ID", () => {
    process.env.WAFER_API_KEY = "sk-test";
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
  });

  it("sets AO_ISSUE_ID when provided", () => {
    process.env.WAFER_API_KEY = "sk-test";
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "GH-42" }));
    expect(env["AO_ISSUE_ID"]).toBe("GH-42");
  });

  it("passes MCP_AGENT_MAIL_URL when set", () => {
    process.env.WAFER_API_KEY = "sk-test";
    process.env.MCP_AGENT_MAIL_URL = "http://mail:8080";
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["MCP_AGENT_MAIL_URL"]).toBe("http://mail:8080");
  });

  it("logs debug when WAFER_API_KEY is resolved", () => {
    process.env.WAFER_API_KEY = "sk-test";
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const agent = create();
    agent.getEnvironment(makeLaunchConfig());
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining("[ao-plugin-agent-openw] WAFER_API_KEY resolved"),
    );
    debug.mockRestore();
  });

  it("logs error when WAFER_API_KEY is missing", () => {
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

describe("detectActivity", () => {
  const agent = create();

  it("returns idle for empty terminal output", () => {
    expect(agent.detectActivity("")).toBe("idle");
  });

  it("returns active for non-empty terminal output", () => {
    expect(agent.detectActivity("opencode is working\n")).toBe("active");
  });

  it('returns waiting_input for structural [y/n] widget', () => {
    expect(agent.detectActivity("Apply changes? [y/n]")).toBe("waiting_input");
  });

  it('returns waiting_input for structural [yes/no] widget', () => {
    expect(agent.detectActivity("Proceed? [yes/no]")).toBe("waiting_input");
  });

  it("returns idle when last line is bare OpenCode prompt", () => {
    expect(agent.detectActivity("Some output\n>")).toBe("idle");
    expect(agent.detectActivity("Some output\n> ")).toBe("idle");
  });

  it("returns active for non-prompt non-empty output", () => {
    expect(agent.detectActivity("press enter to continue")).toBe("active");
  });
});

describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when opencode found on tmux pane TTY", async () => {
    mockTmuxWithProcess("opencode");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when opencode not on tmux pane TTY", async () => {
    mockTmuxWithProcess("opencode", false);
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true for process handle with alive PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(123, 0);
    killSpy.mockRestore();
  });

  it("returns false for process handle with dead PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(false);
    killSpy.mockRestore();
  });
});

describe("getRestoreCommand", () => {
  it("does not provide getRestoreCommand (not implemented)", () => {
    const agent = create();
    expect(agent.getRestoreCommand).toBeUndefined();
  });
});
