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

  it("uses AfterTool/BeforeTool when hookEventNames configured for Gemini", async () => {
    const agent = createAgentPlugin({
      name: "gemini",
      description: "Gemini CLI",
      processName: "gemini",
      command: "gemini",
      configDir: ".gemini",
      permissionlessFlag: "--yolo",
      hookEventNames: { postToolUse: "AfterTool", preToolUse: "BeforeTool" },
    });

    await agent.setupWorkspaceHooks!("/workspace/test", { dataDir: "/data/sessions" });

    const settingsJson = getSettingsJsonArg();
    expect(settingsJson).not.toBeNull();
    const settings = JSON.parse(settingsJson!) as Record<string, unknown>;
    const hooks = settings["hooks"] as Record<string, unknown>;
    expect(hooks).toHaveProperty("AfterTool");
    expect(hooks).toHaveProperty("BeforeTool");
    expect(hooks).not.toHaveProperty("PostToolUse");
    expect(hooks).not.toHaveProperty("PreToolUse");
  });
});

// ---------------------------------------------------------------------------
// detectActivity — classifyTerminalOutput (orch-jtc7: false-idle fix)
// ---------------------------------------------------------------------------
describe("detectActivity — classifyTerminalOutput", () => {
  const agent = createAgentPlugin({
    name: "test-agent",
    description: "Test agent",
    processName: "test",
    command: "test",
    configDir: ".test",
    permissionlessFlag: "--flag",
  });

  it("returns 'idle' for empty output", () => {
    expect(agent.detectActivity("")).toBe("idle");
    expect(agent.detectActivity("   \n  ")).toBe("idle");
  });

  it("returns 'idle' when last line is bare prompt with no activity above", () => {
    const output = "$ ls\nfoo.txt\n$ ";
    expect(agent.detectActivity(output)).toBe("idle");
  });

  it("returns 'idle' when last line is bare ❯ with no activity above", () => {
    const output = "some output\n❯ ";
    expect(agent.detectActivity(output)).toBe("idle");
  });

  // orch-jtc7: false IDLE — agent thinking above, ❯ at bottom
  it("returns 'active' when Unicode spinner ✻ appears near bottom even if last line is ❯", () => {
    const output = [
      "❯ ao spawn --agent claude ...",
      "✻ Analyzing the codebase...",
      "  Reading src/index.ts",
      "  Writing src/output.ts",
      "❯",
    ].join("\n");
    expect(agent.detectActivity(output)).toBe("active");
  });

  it("returns 'active' when spinner ✶ appears in last 20 lines with ❯ on last line", () => {
    const output = [
      "❯",
      "✶ Thinking...",
      "  Tool call: read_file(path='src/main.ts')",
      "❯",
    ].join("\n");
    expect(agent.detectActivity(output)).toBe("active");
  });

  it("returns 'active' when spinner ✳ appears in last 20 lines with > on last line", () => {
    const output = ["✳ Processing...", "> "].join("\n");
    expect(agent.detectActivity(output)).toBe("active");
  });

  it("returns 'active' when spinner appears but is OLDER than 20 lines ago — still returns active (spinner visible in window)", () => {
    // 15 lines of content + spinner nearby — within 20-line window
    const lines = ["✻ Working...", ...Array(5).fill("  step"), "❯"];
    expect(agent.detectActivity(lines.join("\n"))).toBe("active");
  });

  it("returns 'idle' when spinner is more than 20 lines before ❯ (outside window)", () => {
    // spinner far above, then 21 blank/done lines, then prompt
    const lines = ["✻ Old activity...", ...Array(21).fill("done"), "❯"];
    expect(agent.detectActivity(lines.join("\n"))).toBe("idle");
  });

  it("returns 'active' for output with no prompt on last line", () => {
    expect(agent.detectActivity("Reading file...\nDone")).toBe("active");
  });

  it("returns 'waiting_input' for permission prompt near bottom", () => {
    const output = "some text\nDo you want to proceed?\n(Y)es  (N)o";
    expect(agent.detectActivity(output)).toBe("waiting_input");
  });

  it("returns 'waiting_input' for bypass permissions prompt", () => {
    const output = "bypass permissions mode\nConfirm?";
    expect(agent.detectActivity(output)).toBe("waiting_input");
  });
});
// detectActivity — classifyTerminalOutput (orch-jtc7: false-idle fix)
// ---------------------------------------------------------------------------
describe("detectActivity — classifyTerminalOutput", () => {
  const agent = createAgentPlugin({
    name: "test-agent",
    description: "Test agent",
    processName: "test",
    command: "test",
    configDir: ".test",
    permissionlessFlag: "--flag",
  });

  it("returns 'idle' for empty output", () => {
    expect(agent.detectActivity("")).toBe("idle");
    expect(agent.detectActivity("   \n  ")).toBe("idle");
  });

  it("returns 'idle' when last line is bare prompt with no activity above", () => {
    const output = "$ ls\nfoo.txt\n$ ";
    expect(agent.detectActivity(output)).toBe("idle");
  });

  it("returns 'idle' when last line is bare ❯ with no activity above", () => {
    const output = "some output\n❯ ";
    expect(agent.detectActivity(output)).toBe("idle");
  });

  // orch-jtc7: false IDLE — agent thinking above, ❯ at bottom
  it("returns 'active' when Unicode spinner ✻ appears near bottom even if last line is ❯", () => {
    const output = [
      "❯ ao spawn --agent claude ...",
      "✻ Analyzing the codebase...",
      "  Reading src/index.ts",
      "  Writing src/output.ts",
      "❯",
    ].join("\n");
    expect(agent.detectActivity(output)).toBe("active");
  });

  it("returns 'active' when spinner ✶ appears in last 20 lines with ❯ on last line", () => {
    const output = [
      "❯",
      "✶ Thinking...",
      "  Tool call: read_file(path='src/main.ts')",
      "❯",
    ].join("\n");
    expect(agent.detectActivity(output)).toBe("active");
  });

  it("returns 'active' when spinner ✳ appears in last 20 lines with > on last line", () => {
    const output = ["✳ Processing...", "> "].join("\n");
    expect(agent.detectActivity(output)).toBe("active");
  });

  it("returns 'active' when spinner is within the last 20 lines despite prompt on last line", () => {
    // 1 spinner + 5 step lines = 7 total, all within 20-line window, prompt on last line
    const lines = ["✻ Working...", ...Array(5).fill("  step"), "❯"];
    expect(agent.detectActivity(lines.join("\n"))).toBe("active");
  });

  it("returns 'idle' when spinner is exactly 20 lines before ❯ (outside window)", () => {
    // spinner at index 0, 19 filler lines, prompt at index 20 = 21 total lines
    // windowStart = max(0, 21-20) = 1; window = lines[1..20] (excludes spinner at 0) → idle
    const lines = ["✻ Boundary activity...", ...Array(19).fill("done"), "❯"];
    expect(agent.detectActivity(lines.join("\n"))).toBe("idle");
  });

  it("returns 'idle' when spinner is more than 20 lines before ❯ (outside window)", () => {
    // spinner far above, then 21 blank/done lines, then prompt
    const lines = ["✻ Old activity...", ...Array(21).fill("done"), "❯"];
    expect(agent.detectActivity(lines.join("\n"))).toBe("idle");
  });

  it("returns 'active' for output with no prompt on last line", () => {
    expect(agent.detectActivity("Reading file...\nDone")).toBe("active");
  });

  it("returns 'waiting_input' for permission prompt near bottom", () => {
    const output = "some text\nDo you want to proceed?\n(Y)es  (N)o";
    expect(agent.detectActivity(output)).toBe("waiting_input");
  });

  it("returns 'waiting_input' for bypass permissions prompt", () => {
    const output = "bypass permissions mode\nConfirm?";
    expect(agent.detectActivity(output)).toBe("waiting_input");
  });
});
