import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSessionManager } from "../../session-manager.js";
import { writeMetadata, readMetadataRaw } from "../../metadata.js";
import { getSessionsDir } from "../../paths.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  Runtime,
  Agent,
  RuntimeHandle,
} from "../../types.js";

function makeHandle(id: string): RuntimeHandle {
  return { id, runtimeName: "mock", data: {} };
}

let tmpDir: string;
let configPath: string;
let sessionsDir: string;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;

function setupMockRegistry() {
  mockRuntime = {
    name: "mock",
    create: vi.fn().mockResolvedValue(makeHandle("rt-1")),
    destroy: vi.fn().mockResolvedValue(undefined),
    isAlive: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getOutput: vi.fn().mockResolvedValue(""),
    sendKeys: vi.fn().mockResolvedValue(undefined),
  };

  mockAgent = {
    name: "claude-code",
    getLaunchCommand: vi.fn().mockReturnValue("claude"),
    getEnvironment: vi.fn().mockReturnValue({}),
    getActivityState: vi.fn().mockResolvedValue(null),
    getSessionInfo: vi.fn().mockResolvedValue(null),
    detectActivity: vi.fn().mockReturnValue("active"),
    isProcessRunning: vi.fn().mockResolvedValue(true),
    processName: "claude",
    setupWorkspaceHooks: vi.fn().mockResolvedValue(undefined),
    postLaunchSetup: vi.fn().mockResolvedValue(undefined),
  };

  mockRegistry = {
    get: vi.fn((type: string, _name: string) => {
      if (type === "runtime") return mockRuntime;
      if (type === "agent") return mockAgent;
      return undefined;
    }),
  } as unknown as PluginRegistry;

  config = {
    configPath,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "filesystem",
    },
    projects: {
      "my-app": {
        path: join(tmpDir, "my-app"),
        sessionPrefix: "app",
        runtime: "tmux",
        agent: "claude-code",
        scm: { plugin: "github" },
      },
    },
  };
}

beforeEach(() => {
  tmpDir = join("/tmp", `test-send-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  configPath = join(tmpDir, "config.yaml");
  writeFileSync(configPath, "test: config", "utf-8");
  sessionsDir = getSessionsDir(configPath, join(tmpDir, "my-app"));
  mkdirSync(sessionsDir, { recursive: true });
  setupMockRegistry();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("send", () => {
  it("sends message via runtime.sendMessage", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });
    // Mock output to simulate activity change (confirmation signal)
    vi.mocked(mockRuntime.getOutput)
      .mockResolvedValueOnce("before")
      .mockResolvedValueOnce("after");

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.send("app-1", "Hello world");

    expect(mockRuntime.sendMessage).toHaveBeenCalledWith(
      makeHandle("rt-1"),
      "Hello world",
    );
  });

  it("throws for nonexistent session", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.send("nope", "hello")).rejects.toThrow("not found");
  });

  it("falls back to session ID as runtime handle when no runtimeHandle stored", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });
    // Mock output to simulate activity change
    vi.mocked(mockRuntime.getOutput)
      .mockResolvedValueOnce("before")
      .mockResolvedValueOnce("after");

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.send("app-1", "hello");

    // runtimeName falls back to project.runtime ("tmux")
    expect(mockRuntime.sendMessage).toHaveBeenCalledWith(
      { id: "app-1", runtimeName: "tmux", data: {} },
      "hello",
    );
  });

  it("resolves when delivery cannot be confirmed (message already sent)", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });
    // Steady output with idle activity - confirmation will never flip
    vi.mocked(mockRuntime.getOutput).mockResolvedValue("steady output");
    vi.mocked(mockAgent.detectActivity).mockReturnValue("idle");

    const sm = createSessionManager({ config, registry: mockRegistry });
    // Should resolve without throwing — the message was already sent via
    // sendMessage, so unconfirmed delivery is treated as a soft success
    // to avoid duplicate dispatches on the next poll cycle.
    await expect(sm.send("app-1", "Fix the CI failures")).resolves.toBeUndefined();
    expect(mockRuntime.sendMessage).toHaveBeenCalled();
  });
});
