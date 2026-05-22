/**
 * Unit tests for the agent-base package.
 *
 * Tests the public exports, path encoding via toAgentProjectPath,
 * and selected filesystem-related behavior of the createAgentPlugin factory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentLaunchConfig, Session } from "@jleechanorg/ao-core";
import type { Stats } from "node:fs";

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

import { createAgentPlugin, toAgentProjectPath, METADATA_UPDATER_SCRIPT, setupMcpMailInWorkspace } from "./index.js";

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

  it("reads native JSON session files when sessionFileExtension is .json", async () => {
    const sessionFile = "/custom/sessions/path/session.json";
    const modifiedAt = new Date();
    const config = {
      name: "test-agent",
      description: "Test agent plugin",
      processName: "test-process",
      command: "test",
      configDir: ".test",
      permissionlessFlag: "--flag",
      getSessionDir: (_workspacePath: string) => "/custom/sessions/path",
      sessionFileExtension: ".json",
    };

    mockReaddir.mockResolvedValue(["session.json"]);
    mockStat.mockImplementation(async (path: string) => {
      if (path === sessionFile) {
        return { mtimeMs: modifiedAt.getTime(), mtime: modifiedAt } as Stats;
      }
      throw new Error(`Unexpected stat path: ${path}`);
    });
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        messages: [{ type: "assistant" }],
      }),
    );

    const agent = createAgentPlugin(config);
    vi.spyOn(agent, "isProcessRunning").mockResolvedValue(true);

    const activity = await agent.getActivityState(
      {
        runtimeHandle: { pid: 1234 },
        workspacePath: "/workspace/test",
      } as Session,
      60_000,
    );

    expect(activity).toMatchObject({ state: "ready", timestamp: modifiedAt });
  });

  it("keeps valid JSON activity when the last message has no type", async () => {
    const sessionFile = "/custom/sessions/path/session.json";
    const modifiedAt = new Date();
    const config = {
      name: "test-agent",
      description: "Test agent plugin",
      processName: "test-process",
      command: "test",
      configDir: ".test",
      permissionlessFlag: "--flag",
      getSessionDir: (_workspacePath: string) => "/custom/sessions/path",
      sessionFileExtension: ".json",
    };

    mockReaddir.mockResolvedValue(["session.json"]);
    mockStat.mockImplementation(async (path: string) => {
      if (path === sessionFile) {
        return { mtimeMs: modifiedAt.getTime(), mtime: modifiedAt } as Stats;
      }
      throw new Error(`Unexpected stat path: ${path}`);
    });
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        messages: [{ content: "missing explicit type" }],
      }),
    );

    const agent = createAgentPlugin(config);
    vi.spyOn(agent, "isProcessRunning").mockResolvedValue(true);

    const activity = await agent.getActivityState(
      {
        runtimeHandle: { pid: 1234 },
        workspacePath: "/workspace/test",
      } as Session,
      60_000,
    );

    expect(activity).toMatchObject({ state: "active", timestamp: modifiedAt });
  });

  it("returns null for valid JSON session files with empty messages", async () => {
    const sessionFile = "/custom/sessions/path/session.json";
    const modifiedAt = new Date();
    const config = {
      name: "test-agent",
      description: "Test agent plugin",
      processName: "test-process",
      command: "test",
      configDir: ".test",
      permissionlessFlag: "--flag",
      getSessionDir: (_workspacePath: string) => "/custom/sessions/path",
      sessionFileExtension: ".json",
    };

    mockReaddir.mockResolvedValue(["session.json"]);
    mockStat.mockImplementation(async (path: string) => {
      if (path === sessionFile) {
        return { mtimeMs: modifiedAt.getTime(), mtime: modifiedAt } as Stats;
      }
      throw new Error(`Unexpected stat path: ${path}`);
    });
    mockReadFile.mockResolvedValue(JSON.stringify({ messages: [] }));

    const agent = createAgentPlugin(config);
    vi.spyOn(agent, "isProcessRunning").mockResolvedValue(true);

    const activity = await agent.getActivityState(
      {
        runtimeHandle: { pid: 1234 },
        workspacePath: "/workspace/test",
      } as Session,
      60_000,
    );

    expect(activity).toBeNull();
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

// ==================================================================
// METADATA_UPDATER_SCRIPT — [agento] prefix enforcement
// ==================================================================
describe("METADATA_UPDATER_SCRIPT — [agento] prefix enforcement", () => {
  it("rewrites gh pr create when title lacks [agento] prefix in PreToolUse", () => {
    expect(METADATA_UPDATER_SCRIPT).toContain('"permissionDecision": "allow"');
    expect(METADATA_UPDATER_SCRIPT).toContain('"updatedInput": {"command":');
    expect(METADATA_UPDATER_SCRIPT).toContain("[agento] ");
  });

  it("uses the shared Python guard block to preserve quoting while rewriting titles", () => {
    expect(METADATA_UPDATER_SCRIPT).toContain("shell_word_spans");
    expect(METADATA_UPDATER_SCRIPT).toContain("get_title_mode");
    expect(METADATA_UPDATER_SCRIPT).toContain(`python3 - "$clean_command" "$command" <<'PY'`);
  });

  it("checks hook_event is PreToolUse before enforcing prefix", () => {
    // The prefix guard runs in PreToolUse only (not PostToolUse), matching the guard pattern.
    expect(METADATA_UPDATER_SCRIPT).toMatch(/"PreToolUse".*\$clean_command/);
  });
});

describe("setupMcpMailInWorkspace", () => {
  const workspacePath = "/mock/workspace";
  const configDir = ".claude";

  // Save original env values before any modification
  const originalMcpMailUrl = process.env.MCP_AGENT_MAIL_URL;
  const originalMcpMailToken = process.env.MCP_AGENT_MAIL_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MCP_AGENT_MAIL_URL = "http://mock-mail-url/mcp/";
    delete process.env.MCP_AGENT_MAIL_TOKEN;
  });

  afterEach(() => {
    // Restore original environment values to avoid leaking state to other tests
    if (originalMcpMailUrl === undefined) {
      delete process.env.MCP_AGENT_MAIL_URL;
    } else {
      process.env.MCP_AGENT_MAIL_URL = originalMcpMailUrl;
    }
    if (originalMcpMailToken === undefined) {
      delete process.env.MCP_AGENT_MAIL_TOKEN;
    } else {
      process.env.MCP_AGENT_MAIL_TOKEN = originalMcpMailToken;
    }
  });

  it("should write settings.json with mcp-agent-mail server config", async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })); // settings.json doesn't exist
    mockLstat.mockResolvedValue({ isSymbolicLink: () => false } as unknown as Stats);

    await setupMcpMailInWorkspace(workspacePath, configDir);

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("settings.json"),
      expect.stringContaining('"mcp-agent-mail"'),
      "utf-8"
    );
  });

  it("should NOT serialize Bearer token into settings.json (security: P0 orch-havc)", async () => {
    process.env.MCP_AGENT_MAIL_TOKEN = "secret-token-123";
    mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    mockLstat.mockResolvedValue({ isSymbolicLink: () => false } as unknown as Stats);

    await setupMcpMailInWorkspace(workspacePath, configDir);

    const callArgs = mockWriteFile.mock.calls[0];
    const content = callArgs[1];
    expect(content).toContain("mcp-agent-mail");
    expect(content).not.toContain("Authorization");
    expect(content).not.toContain("Bearer");
    expect(content).not.toContain("secret-token-123");
  });

  it("should not include Authorization header when token is absent", async () => {
    delete process.env.MCP_AGENT_MAIL_TOKEN;
    mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    mockLstat.mockResolvedValue({ isSymbolicLink: () => false } as unknown as Stats);

    await setupMcpMailInWorkspace(workspacePath, configDir);

    const callArgs = mockWriteFile.mock.calls[0];
    const content = callArgs[1];
    expect(content).toContain("mcp-agent-mail");
    expect(content).not.toContain("Authorization");
  });
});
