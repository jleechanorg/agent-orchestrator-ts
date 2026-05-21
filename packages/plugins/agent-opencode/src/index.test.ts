import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig } from "@jleechanorg/ao-core";

const mockExecFileAsync = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
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
  };
});

import { create, manifest, default as defaultExport, buildSessionIdCaptureScript } from "./index.js";

function makeSession(overrides: Partial<Session> = {}): Session {
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
      name: "opencode",
      slot: "agent",
      description: "Agent plugin: OpenCode",
      version: "0.1.0",
      displayName: "OpenCode",
    });
  });

  it("create() returns agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("opencode");
    expect(agent.processName).toBe("opencode");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

describe("getLaunchCommand", () => {
  const agent = create();

  it("generates base command with positional '.' when no prompt (fresh session)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toBe("opencode run --format json --title 'AO:sess-1' '.'");
  });

  it("uses positional prompt for fresh sessions", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix it" }));
    expect(cmd).toBe("opencode run --format json --title 'AO:sess-1' 'Fix it'");
  });

  it("includes --model with shell-escaped value", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "claude-sonnet-4-5-20250929" }));
    expect(cmd).toContain("--model 'claude-sonnet-4-5-20250929'");
  });

  it("combines prompt and model as positional arg", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ prompt: "Go", model: "claude-sonnet-4-5-20250929" }),
    );
    expect(cmd).toContain("--model 'claude-sonnet-4-5-20250929'");
    expect(cmd).toContain("'Go'");
  });

  it("escapes single quotes in prompt (POSIX shell escaping)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "it's broken" }));
    expect(cmd).toContain("'it'\\''s broken'");
  });

  it("omits optional flags when not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("--agent");
    expect(cmd).not.toContain("--prompt");
  });

  it("includes --agent flag when subagent is provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ subagent: "sisyphus" }));
    expect(cmd).toContain("--agent 'sisyphus'");
  });

  it("generates command with agent and positional prompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ subagent: "sisyphus", prompt: "fix bug" }),
    );
    expect(cmd).toContain("--agent 'sisyphus'");
    expect(cmd).toContain("'fix bug'");
  });

  it("generates command with agent, model, and positional prompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        subagent: "sisyphus",
        model: "claude-sonnet-4-5-20250929",
        prompt: "fix the bug",
      }),
    );
    expect(cmd).toContain("--agent 'sisyphus'");
    expect(cmd).toContain("--model 'claude-sonnet-4-5-20250929'");
    expect(cmd).toContain("'fix the bug'");
  });

  it("does not use node -e pipe or SES_ID json parsing", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("node -e");
    expect(cmd).not.toContain("SES_ID");
  });

  it("includes --title for fresh sessions so discoverOpenCodeSessionIdsByTitle can find them", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toContain("--title 'AO:sess-1'");
  });

  it("does not include --title when resuming an existing session", () => {
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
      }),
    );
    expect(cmd).not.toContain("--title");
    expect(cmd).toContain("--session 'ses_abc123'");
  });

  it("works with different agent names: oracle", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ subagent: "oracle", prompt: "review code" }),
    );
    expect(cmd).toContain("--agent 'oracle'");
    expect(cmd).toContain("'review code'");
  });

  it("works with different agent names: librarian", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ subagent: "librarian", prompt: "find usages" }),
    );
    expect(cmd).toContain("--agent 'librarian");
    expect(cmd).toContain("'find usages'");
  });

  it("backward compatible: no agent flag when subagent not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "fix it" }));
    expect(cmd).not.toContain("--agent");
    expect(cmd).toContain("'fix it'");
  });

  it("combines model and positional prompt without agent (backward compatible)", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ prompt: "Go", model: "claude-sonnet-4-5-20250929" }),
    );
    expect(cmd).not.toContain("--agent");
    expect(cmd).toContain("--model 'claude-sonnet-4-5-20250929'");
    expect(cmd).toContain("'Go'");
  });

  it("combines systemPrompt into positional prompt for fresh session", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ systemPrompt: "You are an orchestrator" }),
    );
    expect(cmd).toBe("opencode run --format json --title 'AO:sess-1' 'You are an orchestrator'");
  });

  it("generates command with systemPrompt and task prompt combined as positional", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ systemPrompt: "You are an orchestrator", prompt: "do the task" }),
    );
    expect(cmd).toBe(
      "opencode run --format json --title 'AO:sess-1' 'You are an orchestrator\n\ndo the task'",
    );
  });

  it("escapes single quotes in combined systemPrompt and prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ systemPrompt: "it's important" }));
    expect(cmd).toContain("'it'\\''s important'");
  });

  it("handles very long systemPrompt", () => {
    const longPrompt = "A".repeat(500);
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ systemPrompt: longPrompt }));
    expect(cmd.length).toBeGreaterThan(500);
  });

  it("generates command with systemPromptFile via shell substitution (positional)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ systemPromptFile: "/tmp/prompt.md" }));
    expect(cmd).toBe("opencode run --format json --title 'AO:sess-1' \"$(cat '/tmp/prompt.md')\"");
  });

  it("systemPromptFile takes precedence over systemPrompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        systemPrompt: "direct prompt",
        systemPromptFile: "/tmp/file-prompt.md",
      }),
    );
    expect(cmd).toBe("opencode run --format json --title 'AO:sess-1' \"$(cat '/tmp/file-prompt.md')\"");
    expect(cmd).not.toContain("direct prompt");
  });

  it("combines systemPromptFile with subagent and prompt (positional)", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        systemPromptFile: "/tmp/orchestrator.md",
        subagent: "sisyphus",
        prompt: "fix the bug",
      }),
    );
    expect(cmd).toBe(
      "opencode run --format json --title 'AO:sess-1' --agent 'sisyphus' \"$(cat '/tmp/orchestrator.md')\n\nfix the bug\"",
    );
  });

  it("escapes special characters in prompt when combined with systemPromptFile", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        systemPromptFile: "/tmp/prompt.md",
        prompt: 'fix "this" and $HOME',
      }),
    );
    expect(cmd).toBe(
      "opencode run --format json --title 'AO:sess-1' \"$(cat '/tmp/prompt.md')\n\nfix \\\"this\\\" and \\$HOME\"",
    );
  });

  it("escapes backticks in prompt when combined with systemPromptFile", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        systemPromptFile: "/tmp/prompt.md",
        prompt: "use `backticks` here",
      }),
    );
    expect(cmd).toBe(
      "opencode run --format json --title 'AO:sess-1' \"$(cat '/tmp/prompt.md')\n\nuse \\`backticks\\` here\"",
    );
  });

  it("escapes backslashes in prompt when combined with systemPromptFile", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        systemPromptFile: "/tmp/prompt.md",
        prompt: "path\\to\\file",
      }),
    );
    expect(cmd).toBe(
      "opencode run --format json --title 'AO:sess-1' \"$(cat '/tmp/prompt.md')\n\npath\\\\to\\\\file\"",
    );
  });

  it("handles prompt with special characters", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ prompt: "fix $PATH/to/file and `rm -rf /unquoted/path`" }),
    );
    expect(cmd).toContain("'fix $PATH/to/file and `rm -rf /unquoted/path`");
  });

  it("handles prompt with newlines", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "line1\nline2\nline3" }));
    expect(cmd).toContain("'line1");
  });

  it("handles prompt with backticks", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "use `backticks` and $vars`" }));
    expect(cmd).toContain("'use `backticks` and $vars`");
  });

  it("handles prompt with dollar signs", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "cost is $100" }));
    expect(cmd).toContain("'cost is $100'");
  });

  it("handles prompt with double quotes", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: 'say "hello" and "goodbye"' }));
    expect(cmd).toContain('\'say "hello" and "goodbye"\'');
  });

  it("handles prompt with unicode characters", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "fix bug in café.js file" }));
    expect(cmd).toContain("'fix bug in café.js file'");
  });

  it("handles prompt with semicolons", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "line1; line2; line3" }));
    expect(cmd).toContain("'line1; line2; line3");
  });

  it("handles empty prompt by using positional '.'", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "" }));
    expect(cmd).not.toContain("--prompt");
    expect(cmd).toContain("'.'");
  });

  it("uses existing session id with --prompt for resume", () => {
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

    expect(cmd).toBe("opencode run --format json --session 'ses_abc123' --prompt 'continue'");
  });

  it("strips provider prefix from model", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "wafer.ai/GLM-5.1" }));
    expect(cmd).toContain("--model 'GLM-5.1'");
    expect(cmd).not.toContain("wafer.ai");
  });
});

describe("getLaunchCommand — Bug 1: positional '.' instead of --command true", () => {
  const agent = create();

  it("uses positional '.' not --command for fresh session without prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--command");
    expect(cmd).toMatch(/'\.'$/);
    expect(cmd).toContain("'.'");
  });

  it("uses positional message arg for fresh session with prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "do work" }));
    expect(cmd).not.toContain("--command");
    expect(cmd).not.toContain("--prompt");
    expect(cmd).toContain("'do work'");
  });

  it("still uses --prompt for session resume", () => {
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
    expect(cmd).toContain("--prompt 'continue'");
    expect(cmd).not.toContain("--command");
  });

  it("always includes --format json for session ID capture", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toContain("--format json");
  });
});

describe("getEnvironment", () => {
  const agent = create();

  it("sets AO_SESSION_ID but not AO_PROJECT_ID (caller's responsibility)", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
    expect(env["AO_PROJECT_ID"]).toBeUndefined();
  });

  it("sets AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "GH-42" }));
    expect(env["AO_ISSUE_ID"]).toBe("GH-42");
  });

  it("omits AO_ISSUE_ID when not provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
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

  it("returns false for unknown runtime without PID", async () => {
    const handle: RuntimeHandle = { id: "x", runtimeName: "other", data: {} };
    expect(await agent.isProcessRunning(handle)).toBe(false);
  });

  it("returns false on tmux command failure", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux not running"));
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true when PID exists but throws EPERM", async () => {
    const epermErr = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw epermErr;
    });
    expect(await agent.isProcessRunning(makeProcessHandle(789))).toBe(true);
    killSpy.mockRestore();
  });

  it("finds opencode on any pane in multi-pane session", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") {
        return Promise.resolve({ stdout: "/dev/ttys001\n/dev/ttys002\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  bash\n  200 ttys002  opencode run hello\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });
});

describe("detectActivity — terminal output classification", () => {
  const agent = create();

  it("returns idle for empty terminal output", () => {
    expect(agent.detectActivity("")).toBe("idle");
  });

  it("returns idle for whitespace-only terminal output", () => {
    expect(agent.detectActivity("   \n  ")).toBe("idle");
  });

  it("returns active for non-empty terminal output", () => {
    expect(agent.detectActivity("opencode is working\n")).toBe("active");
  });

  describe("ready patterns — OpenCode waiting-for-input indicators", () => {
    it('returns ready for "press enter to continue"', () => {
      expect(agent.detectActivity("press enter to continue")).toBe("ready");
    });

    it('returns waiting_input for "[y/n]" prompt', () => {
      expect(agent.detectActivity("Apply changes? [y/n]")).toBe("waiting_input");
    });

    it('returns waiting_input for "[Y/n]" prompt (case-insensitive)', () => {
      expect(agent.detectActivity("Confirm [Y/n]")).toBe("waiting_input");
    });

    it('returns waiting_input for "[yes/no]" prompt', () => {
      expect(agent.detectActivity("Proceed? [yes/no]")).toBe("waiting_input");
    });

    it("returns waiting_input for standalone ? on its own line (last-line extraction)", () => {
      expect(agent.detectActivity("?\n")).toBe("waiting_input");
      expect(agent.detectActivity("  ?  \n")).toBe("waiting_input");
      expect(agent.detectActivity("Thinking...\n?\n")).toBe("waiting_input");
    });

    it("returns active for question-mark in sentence (not standalone)", () => {
      expect(agent.detectActivity("What would you like to do?\n")).toBe("active");
      expect(agent.detectActivity("Missing module — did you install it?\n")).toBe("active");
    });

    it("returns waiting_input for confirm text", () => {
      expect(agent.detectActivity("Please confirm\n")).toBe("waiting_input");
    });

    it("returns waiting_input for standalone confirm?", () => {
      expect(agent.detectActivity("confirm?\n")).toBe("waiting_input");
    });

    it("returns waiting_input for arrow-only line (menu selection)", () => {
      expect(agent.detectActivity("  →  \n")).toBe("waiting_input");
    });

    it("returns ready for waiting text", () => {
      expect(agent.detectActivity("waiting for input\n")).toBe("ready");
    });

    it("returns ready regardless of case", () => {
      expect(agent.detectActivity("PRESS ENTER TO CONTINUE")).toBe("ready");
      expect(agent.detectActivity("WAITING...")).toBe("ready");
    });

    it("returns waiting_input mixed with active output", () => {
      expect(agent.detectActivity("thinking...\nApply changes? [y/n]")).toBe("waiting_input");
    });

    it("returns active when no waiting pattern matches", () => {
      expect(agent.detectActivity("Applying changes to file...")).toBe("active");
      expect(agent.detectActivity("Running tests...\n")).toBe("active");
    });

    it("returns active for 'confirming' (not a standalone word)", () => {
      expect(agent.detectActivity("Confirming deployment...")).toBe("active");
    });

    it("returns active for 'submenu' (partial word match)", () => {
      expect(agent.detectActivity("Enter submenu\n")).toBe("active");
    });
  });
});

describe("getActivityState", () => {
  const agent = create();

  function mockOpencodeSessionRows(rows: Array<Record<string, unknown>>) {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  789 ttys003  opencode\n",
          stderr: "",
        });
      }
      if (cmd === "opencode") {
        return Promise.resolve({
          stdout: JSON.stringify(rows),
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
  }

  function mockOpencodeSessionList(updated: string | number) {
    mockOpencodeSessionRows([{ id: "ses_abc123", updated }]);
  }

  it("returns idle when last activity is older than ready threshold", async () => {
    mockOpencodeSessionList(new Date(Date.now() - 120_000).toISOString());

    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeTmuxHandle(),
        metadata: { opencodeSessionId: "ses_abc123" },
      }),
      60_000,
    );

    expect(state?.state).toBe("idle");
  });

  it("returns ready when last activity is between active window and ready threshold", async () => {
    mockOpencodeSessionList(new Date(Date.now() - 45_000).toISOString());

    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeTmuxHandle(),
        metadata: { opencodeSessionId: "ses_abc123" },
      }),
      60_000,
    );

    expect(state?.state).toBe("ready");
  });

  it("returns active when last activity is recent", async () => {
    mockOpencodeSessionList(new Date(Date.now() - 10_000).toISOString());

    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeTmuxHandle(),
        metadata: { opencodeSessionId: "ses_abc123" },
      }),
      60_000,
    );

    expect(state?.state).toBe("active");
  });

  it("returns null when matching session has invalid updated timestamp", async () => {
    mockOpencodeSessionRows([{ id: "ses_abc123", updated: "not-a-date" }]);

    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeTmuxHandle(),
        metadata: { opencodeSessionId: "ses_abc123" },
      }),
      60_000,
    );

    expect(state).toBeNull();
  });

  it("falls back to AO session title when opencodeSessionId metadata is missing", async () => {
    mockOpencodeSessionRows([
      {
        id: "ses_different",
        title: "AO:test-1",
        updated: new Date(Date.now() - 5_000).toISOString(),
      },
    ]);

    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeTmuxHandle(),
        metadata: {},
      }),
      60_000,
    );

    expect(state?.state).toBe("active");
  });

  it("returns null when opencode session list output is malformed JSON", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  789 ttys003  opencode\n",
          stderr: "",
        });
      }
      if (cmd === "opencode") return Promise.resolve({ stdout: "not json", stderr: "" });
      return Promise.reject(new Error("unexpected"));
    });

    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeTmuxHandle(),
        metadata: { opencodeSessionId: "ses_abc123" },
      }),
    );

    expect(state).toBeNull();
  });
});

describe("getSessionInfo", () => {
  const agent = create();

  it("always returns null (not implemented)", async () => {
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
    expect(await agent.getSessionInfo(makeSession({ workspacePath: "/some/path" }))).toBeNull();
  });
});

describe("invalid session ID rejection", () => {
  it("does not include --session for invalid opencodeSessionId in launch command", () => {
    const agent = create();

    const invalidIds = ["invalid", "SES_uppercase", "ses_", "ses spaces here", "", "ses-123"];

    for (const invalidId of invalidIds) {
      const cmd = agent.getLaunchCommand(
        makeLaunchConfig({
          projectConfig: {
            name: "my-project",
            repo: "owner/repo",
            path: "/workspace/repo",
            defaultBranch: "main",
            sessionPrefix: "my",
            agentConfig: { opencodeSessionId: invalidId },
          },
          prompt: "continue",
        }),
      );

      expect(cmd).not.toContain(`--session '${invalidId}'`);
      expect(cmd).toContain("'continue'");
    }
  });

  it("only accepts valid ses_ prefix session IDs", () => {
    const agent = create();

    const validIds = ["ses_abc123", "ses_test-session", "ses_12345"];

    for (const validId of validIds) {
      const cmd = agent.getLaunchCommand(
        makeLaunchConfig({
          projectConfig: {
            name: "my-project",
            repo: "owner/repo",
            path: "/workspace/repo",
            defaultBranch: "main",
            sessionPrefix: "my",
            agentConfig: { opencodeSessionId: validId },
          },
          prompt: "continue",
        }),
      );

      expect(cmd).toContain(`--session '${validId}'`);
    }
  });
});

describe("session ID capture from JSON stream — Bug 2: sessionID camelCase", () => {
  it("buildSessionIdCaptureScript returns a single-line script", () => {
    const script = buildSessionIdCaptureScript();
    expect(script).not.toContain("\n");
    expect(script.length).toBeGreaterThan(0);
  });

  it("captures sessionID (camelCase) from JSON stream", async () => {
    const script = buildSessionIdCaptureScript();
    const { execFileSync } = await import("node:child_process");
    const result = execFileSync("node", ["-e", script], {
      input: '{"sessionID":"ses_abc123"}\n',
      timeout: 5000,
      encoding: "utf-8",
    });
    expect(result.trim()).toBe("ses_abc123");
  });

  it("captures session_id (snake_case) as fallback", async () => {
    const script = buildSessionIdCaptureScript();
    const { execFileSync } = await import("node:child_process");
    const result = execFileSync("node", ["-e", script], {
      input: '{"session_id":"ses_xyz789"}\n',
      timeout: 5000,
      encoding: "utf-8",
    });
    expect(result.trim()).toBe("ses_xyz789");
  });

  it("captures id field as last resort", async () => {
    const script = buildSessionIdCaptureScript();
    const { execFileSync } = await import("node:child_process");
    const result = execFileSync("node", ["-e", script], {
      input: '{"id":"ses_def456"}\n',
      timeout: 5000,
      encoding: "utf-8",
    });
    expect(result.trim()).toBe("ses_def456");
  });

  it("prefers sessionID over session_id and id", async () => {
    const script = buildSessionIdCaptureScript();
    const { execFileSync } = await import("node:child_process");
    const result = execFileSync("node", ["-e", script], {
      input: '{"sessionID":"ses_first","session_id":"ses_second","id":"ses_third"}\n',
      timeout: 5000,
      encoding: "utf-8",
    });
    expect(result.trim()).toBe("ses_first");
  });

  it("rejects non-ses_ prefixed values", async () => {
    const script = buildSessionIdCaptureScript();
    const { execFileSync } = await import("node:child_process");
    let exitCode = 0;
    try {
      execFileSync("node", ["-e", script], {
        input: '{"sessionID":"invalid-id"}\n',
        timeout: 5000,
        encoding: "utf-8",
      });
    } catch {
      exitCode = 1;
    }
    expect(exitCode).toBe(1);
  });

  it("handles multi-line JSON stream", async () => {
    const script = buildSessionIdCaptureScript();
    const { execFileSync } = await import("node:child_process");
    const result = execFileSync("node", ["-e", script], {
      input: '{"type":"start"}\n{"sessionID":"ses_multi_line"}\n{"type":"end"}\n',
      timeout: 5000,
      encoding: "utf-8",
    });
    expect(result.trim()).toBe("ses_multi_line");
  });

  it("exits with code 1 when no valid session ID found", async () => {
    const script = buildSessionIdCaptureScript();
    const { execFileSync } = await import("node:child_process");
    let exitCode = 0;
    try {
      execFileSync("node", ["-e", script], {
        input: '{"type":"start"}\n{"status":"ok"}\n',
        timeout: 5000,
        encoding: "utf-8",
      });
    } catch {
      exitCode = 1;
    }
    expect(exitCode).toBe(1);
  });

  it("ignores malformed JSON lines gracefully", async () => {
    const script = buildSessionIdCaptureScript();
    const { execFileSync } = await import("node:child_process");
    const result = execFileSync("node", ["-e", script], {
      input: 'not json\n{"sessionID":"ses_after_bad"}\n',
      timeout: 5000,
      encoding: "utf-8",
    });
    expect(result.trim()).toBe("ses_after_bad");
  });
});
