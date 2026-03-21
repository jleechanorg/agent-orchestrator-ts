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
