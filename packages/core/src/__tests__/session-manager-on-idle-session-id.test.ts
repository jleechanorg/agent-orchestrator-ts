/**
 * Regression test: onIdle uses AO sessionId (not runtime handle id) for updateMetadata.
 *
 * Bug (bd-5o1): `onIdle: (idleSessionId) => updateMetadata(sessionsDir, idleSessionId, ...)`
 * used the runtime handle id (tmuxName) rather than the AO sessionId. When
 * tmuxName !== sessionId, metadata was written to the wrong session directory.
 *
 * Fix: `onIdle: (_idleSessionId) => updateMetadata(sessionsDir, sessionId, ...)`
 * uses the outer sessionId from the spawn/restore closure.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createSessionManager } from "../session-manager.js";
import { readMetadata, writeMetadata } from "../metadata.js";
import {
  getSessionsDir,
  getProjectBaseDir,
  generateTmuxName,
} from "../paths.js";
import type { Runtime, Agent, Workspace, RuntimeHandle, PluginRegistry, OrchestratorConfig } from "../types.js";

let tmpDir: string;
let configPath: string;
let sessionsDir: string;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockWorkspace: Workspace;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;

function makeHandle(id: string): RuntimeHandle {
  return { id, runtimeName: "mock", data: {} };
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-test-on-idle-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");

  // tmuxName will differ from sessionId when configPath is set
  const expectedTmuxName = generateTmuxName(configPath, "app", 1);

  mockRuntime = {
    name: "mock",
    create: vi.fn().mockImplementation(async (_opts: unknown) => {
      return makeHandle(expectedTmuxName);
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getOutput: vi.fn().mockResolvedValue(""),
    isAlive: vi.fn().mockResolvedValue(true),
  };

  mockAgent = {
    name: "mock-agent",
    processName: "mock",
    supportsSystemPromptFile: true,
    getLaunchCommand: vi.fn().mockReturnValue("mock-agent --start"),
    getEnvironment: vi.fn().mockReturnValue({}),
    detectActivity: vi.fn().mockReturnValue("active"),
    getActivityState: vi.fn().mockResolvedValue({ state: "active" }),
    isProcessRunning: vi.fn().mockResolvedValue(true),
    getSessionInfo: vi.fn().mockResolvedValue(null),
  };

  mockWorkspace = {
    name: "mock-ws",
    create: vi.fn().mockResolvedValue({
      path: join(tmpDir, "my-app"),
      branch: "feat/TEST-1",
      sessionId: "app-1",
      projectId: "my-app",
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  };

  mockRegistry = {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string) => {
      if (slot === "runtime") return mockRuntime;
      if (slot === "agent") return mockAgent;
      if (slot === "workspace") return mockWorkspace;
      return null;
    }),
    getModule: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn().mockResolvedValue(undefined),
    loadFromConfig: vi.fn().mockResolvedValue(undefined),
  };

  config = {
    configPath,
    port: 3000,
    defaults: {
      runtime: "mock",
      agent: "mock-agent",
      workspace: "mock-ws",
      notifiers: [],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: join(tmpDir, "my-app"),
        defaultBranch: "main",
        sessionPrefix: "app",
        scm: { plugin: "github" },
        tracker: { plugin: "github" },
        configPath,
      },
    },
    notifiers: {},
    readyThresholdMs: 300_000,
    startupGracePeriodMs: 120_000,
  };

  sessionsDir = getSessionsDir(configPath, join(tmpDir, "my-app"));
  mkdirSync(sessionsDir, { recursive: true });

  // Write orchestrator metadata so spawn does not block on orchestrator check
  writeMetadata(sessionsDir, "app-orchestrator", {
    worktree: join(tmpDir, "my-app"),
    branch: "main",
    status: "working",
    role: "orchestrator",
    project: "my-app",
    runtimeHandle: JSON.stringify(makeHandle("rt-orch")),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  const projectBaseDir = getProjectBaseDir(configPath, join(tmpDir, "my-app"));
  if (existsSync(projectBaseDir)) {
    rmSync(projectBaseDir, { recursive: true, force: true });
  }
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("onIdle uses AO sessionId (not runtime handle id) for updateMetadata", () => {
  it("spawn onIdle writes metadata to AO sessionId directory, not tmuxName directory", async () => {
    // Capture the onIdle callback from runtime.create
    let capturedOnIdle: ((id: string) => void) | undefined;
    vi.mocked(mockRuntime.create).mockImplementation(async (opts) => {
      capturedOnIdle = (opts as { onIdle?: (id: string) => void }).onIdle;
      return makeHandle("tmux-handle-xyz"); // tmuxName != sessionId ("app-1")
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const session = await sm.spawn({ projectId: "my-app" });

    expect(session.id).toBe("app-1");
    expect(capturedOnIdle).toBeDefined();

    // Invoke onIdle with the tmuxName (what old code used to persist under)
    capturedOnIdle!("tmux-handle-xyz");

    // Verify metadata was written to the AO sessionId ("app-1"), NOT tmuxName ("tmux-handle-xyz")
    const aoMeta = readMetadata(sessionsDir, "app-1");
    expect(aoMeta?.status).toBe("idle");

    // The wrong target (tmuxName) must NOT exist
    const wrongMeta = readMetadata(sessionsDir, "tmux-handle-xyz");
    expect(wrongMeta).toBeNull();
  });
});
