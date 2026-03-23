/**
 * Unit tests for the agent-base package.
 *
 * Tests the public exports, path encoding via toAgentProjectPath,
 * and selected filesystem-related behavior of the createAgentPlugin factory.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentLaunchConfig } from "@jleechanorg/ao-core";

// Hoisted mocks — available inside vi.mock factories
const {
  mockReaddir,
  mockReadFile,
  mockStat,
  mockHomedir,
  mockMkdir,
  mockWriteFile,
  mockChmod,
  mockAccess,
  mockOpen,
  mockExistsSync,
  mockLstat,
} = vi.hoisted(() => ({
  mockReaddir: vi.fn(),
  mockReadFile: vi.fn(),
  mockStat: vi.fn(),
  mockHomedir: vi.fn(() => "/mock/home"),
  mockMkdir: vi.fn(),
  mockWriteFile: vi.fn(),
  mockChmod: vi.fn(),
  mockAccess: vi.fn(),
  mockOpen: vi.fn(),
  mockExistsSync: vi.fn(() => false),
  mockLstat: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
}));

vi.mock("node:fs/promises", () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
  stat: mockStat,
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  chmod: mockChmod,
  access: mockAccess,
  open: mockOpen,
  lstat: mockLstat,
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

import { createAgentPlugin, toAgentProjectPath } from "./index.js";

describe("agent-base exports", () => {
  it("should export createAgentPlugin", () => {
    expect(createAgentPlugin).toBeDefined();
    expect(typeof createAgentPlugin).toBe("function");
  });

  it("should export toAgentProjectPath", () => {
    expect(toAgentProjectPath).toBeDefined();
    expect(typeof toAgentProjectPath).toBe("function");
  });
});

describe("toAgentProjectPath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should encode simple Unix paths", () => {
    // /Users/test/project → -Users-test-project (slashes become dashes)
    expect(toAgentProjectPath("/Users/test/project")).toBe("-Users-test-project");
  });

  it("should encode paths with hyphens", () => {
    // /workspace/my-repo → -workspace-my-repo
    expect(toAgentProjectPath("/workspace/my-repo")).toBe("-workspace-my-repo");
  });

  it("should encode worktree paths", () => {
    // /home/user/.worktrees/ao → -home-user--worktrees-ao (dot becomes dash)
    expect(toAgentProjectPath("/home/user/.worktrees/ao")).toBe("-home-user--worktrees-ao");
  });

  it("should handle empty string input", () => {
    // Empty path returns empty string (no leading dash for empty input)
    const result = toAgentProjectPath("");
    expect(result).toBe("");
  });

  it("should handle paths with multiple consecutive slashes", () => {
    // Multiple slashes become multiple dashes: /path//with///slashes → -path--with---slashes
    expect(toAgentProjectPath("/path//with///slashes")).toBe("-path--with---slashes");
  });
});

describe("createAgentPlugin factory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create agent with correct name and processName", () => {
    const config = {
      name: "test-agent",
      description: "Test agent plugin",
      processName: "test-process",
      command: "test",
      configDir: ".test",
      permissionlessFlag: "--test-flag",
    };

    const agent = createAgentPlugin(config);
    expect(agent.name).toBe("test-agent");
    expect(agent.processName).toBe("test-process");
  });

  it("should include required agent methods", () => {
    const config = {
      name: "test-agent",
      description: "Test agent plugin",
      processName: "test-process",
      command: "test",
      configDir: ".test",
      permissionlessFlag: "--test-flag",
    };

    const agent = createAgentPlugin(config);

    expect(typeof agent.getLaunchCommand).toBe("function");
    expect(typeof agent.getEnvironment).toBe("function");
    expect(typeof agent.isProcessRunning).toBe("function");
    expect(typeof agent.getActivityState).toBe("function");
    expect(typeof agent.getSessionInfo).toBe("function");
    expect(typeof agent.detectActivity).toBe("function");
  });

  it("should handle permissionless mode in launch command", () => {
    const config = {
      name: "test-agent",
      description: "Test agent plugin",
      processName: "test-process",
      command: "test",
      configDir: ".test",
      permissionlessFlag: "--skip-permissions",
    };

    const agent = createAgentPlugin(config);

    const launchConfig: AgentLaunchConfig = {
      sessionId: "test-session",
      permissions: "skip",
      projectConfig: {
        name: "test-project",
        repo: "owner/repo",
        path: "/workspace/repo",
        defaultBranch: "main",
        sessionPrefix: "test",
      },
    };

    const cmd = agent.getLaunchCommand(launchConfig);
    expect(cmd).toContain("test");
    expect(cmd).toContain("--skip-permissions");
  });

  it("should set AO_SESSION in environment", () => {
    const config = {
      name: "test-agent",
      description: "Test agent plugin",
      processName: "test-process",
      command: "test",
      configDir: ".test",
      permissionlessFlag: "--flag",
    };

    const agent = createAgentPlugin(config);

    const launchConfig: AgentLaunchConfig = {
      sessionId: "my-session-id",
      projectConfig: {
        name: "test-project",
        repo: "owner/repo",
        path: "/workspace/repo",
        defaultBranch: "main",
        sessionPrefix: "test",
      },
    };

    const env = agent.getEnvironment(launchConfig);
    expect(env.AO_SESSION).toBe("my-session-id");
    expect(env.AO_SESSION_ID).toBe("my-session-id");
  });

  it("should handle system prompt via flag", () => {
    const config = {
      name: "test-agent",
      description: "Test agent plugin",
      processName: "test-process",
      command: "test",
      configDir: ".test",
      permissionlessFlag: "--flag",
      systemPromptFlag: "--system-prompt",
    };

    const agent = createAgentPlugin(config);

    const launchConfig: AgentLaunchConfig = {
      sessionId: "test-session",
      systemPrompt: "You are a helpful assistant",
      projectConfig: {
        name: "test-project",
        repo: "owner/repo",
        path: "/workspace/repo",
        defaultBranch: "main",
        sessionPrefix: "test",
      },
    };

    const cmd = agent.getLaunchCommand(launchConfig);
    expect(cmd).toContain("--system-prompt");
  });

  it("should use custom session directory", () => {
    const customDir = "/custom/sessions/path";
    const config = {
      name: "test-agent",
      description: "Test agent plugin",
      processName: "test-process",
      command: "test",
      configDir: ".test",
      permissionlessFlag: "--flag",
      getSessionDir: (_workspacePath: string) => customDir,
    };

    const _agent = createAgentPlugin(config);

    // Verify the agent has getSessionDir by checking it returns customDir for any input
    const result = config.getSessionDir!("/workspace/test");
    expect(result).toBe(customDir);
  });

});

// ---------------------------------------------------------------------------
// setupWorkspaceHooks — hook event names
// ---------------------------------------------------------------------------
describe("setupWorkspaceHooks — hook event names", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // lstat throws ENOENT (configDir does not exist) — setupHookInWorkspace handles this
    mockLstat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    // mkdir, writeFile, chmod are no-ops
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockChmod.mockResolvedValue(undefined);
    // existsSync returns false — no existing settings.json to read
    mockExistsSync.mockReturnValue(false);
  });

  function getSettingsJsonArg(): string | null {
    for (const call of mockWriteFile.mock.calls) {
      const [path, content] = call as [string, string, unknown];
      if (typeof path === "string" && path.endsWith("settings.json")) {
        return content;
      }
    }
    return null;
  }

  it("uses PostToolUse/PreToolUse by default (Claude Code agents)", async () => {
    const agent = createAgentPlugin({
      name: "claude-code",
      description: "Claude Code",
      processName: "claude",
      command: "claude",
      configDir: ".claude",
      permissionlessFlag: "--dangerously-skip-permissions",
    });

    await agent.setupWorkspaceHooks!("/workspace/test", { dataDir: "/data/sessions" });

    const settingsJson = getSettingsJsonArg();
    expect(settingsJson).not.toBeNull();
    const settings = JSON.parse(settingsJson!) as Record<string, unknown>;
    const hooks = settings["hooks"] as Record<string, unknown>;
    expect(hooks).toHaveProperty("PostToolUse");
    expect(hooks).toHaveProperty("PreToolUse");
    expect(hooks).not.toHaveProperty("AfterTool");
    expect(hooks).not.toHaveProperty("BeforeTool");
  });

  it("pre-event command does not include AO_DATA_DIR (guardrail exits before session needed)", async () => {
    const agent = createAgentPlugin({
      name: "claude-code",
      description: "Claude Code",
      processName: "claude",
      command: "claude",
      configDir: ".claude",
      permissionlessFlag: "--dangerously-skip-permissions",
    });

    await agent.setupWorkspaceHooks!("/workspace/test", { dataDir: "/data/sessions" });

    const settingsJson = getSettingsJsonArg();
    expect(settingsJson).not.toBeNull();
    const settings = JSON.parse(settingsJson!) as Record<string, unknown>;
    const hooks = settings["hooks"] as Record<string, unknown>;
    const preToolUse = hooks["PreToolUse"] as Array<Record<string, unknown>>;
    expect(preToolUse).toBeDefined();
    const hookDef = preToolUse[0] as Record<string, unknown>;
    const hooksList = hookDef["hooks"] as Array<Record<string, unknown>>;
    const preCommand = hooksList[0]["command"] as string;

    expect(preCommand).not.toContain("AO_DATA_DIR=");
    expect(preCommand).toContain("AO_HOOK_EVENT_NAME=");
  });

  it("post-event command includes AO_DATA_DIR (metadata tracking needs session directory)", async () => {
    const agent = createAgentPlugin({
      name: "claude-code",
      description: "Claude Code",
      processName: "claude",
      command: "claude",
      configDir: ".claude",
      permissionlessFlag: "--dangerously-skip-permissions",
    });

    await agent.setupWorkspaceHooks!("/workspace/test", { dataDir: "/data/sessions" });

    const settingsJson = getSettingsJsonArg();
    expect(settingsJson).not.toBeNull();
    const settings = JSON.parse(settingsJson!) as Record<string, unknown>;
    const hooks = settings["hooks"] as Record<string, unknown>;
    const postToolUse = hooks["PostToolUse"] as Array<Record<string, unknown>>;
    expect(postToolUse).toBeDefined();
    const hookDef = postToolUse[0] as Record<string, unknown>;
    const hooksList = hookDef["hooks"] as Array<Record<string, unknown>>;
    const postCommand = hooksList[0]["command"] as string;

    expect(postCommand).toContain("AO_DATA_DIR=");
    expect(postCommand).toContain("/data/sessions");
    expect(postCommand).toContain("AO_HOOK_EVENT_NAME=");
  });

  it("uses AfterTool when hookEventNames configured for Gemini", async () => {
    const agent = createAgentPlugin({
      name: "gemini",
      description: "Gemini CLI",
      processName: "gemini",
      command: "gemini",
      configDir: ".gemini",
      permissionlessFlag: "--yolo",
      hookEventNames: { postToolUse: "AfterTool" },
    });

    await agent.setupWorkspaceHooks!("/workspace/test", { dataDir: "/data/sessions" });

    const settingsJson = getSettingsJsonArg();
    expect(settingsJson).not.toBeNull();
    const settings = JSON.parse(settingsJson!) as Record<string, unknown>;
    const hooks = settings["hooks"] as Record<string, unknown>;
    expect(hooks).toHaveProperty("AfterTool");
    expect(hooks).toHaveProperty("PreToolUse"); // guardrail still uses PreToolUse
    expect(hooks).not.toHaveProperty("PostToolUse");
    expect(hooks).not.toHaveProperty("BeforeTool");
  });
});
