import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createSessionManager } from "../session-manager.js";
import {
  writeMetadata,
  readMetadataRaw,
} from "../metadata.js";
import { getSessionsDir } from "../paths.js";
import {
  type OrchestratorConfig,
  type PluginRegistry,
  type Runtime,
  type Agent,
  type Workspace,
  type RuntimeHandle,
} from "../types.js";

let tmpDir: string;
let configPath: string;
let sessionsDir: string;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockWorkspace: Workspace;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;
let originalPath: string | undefined;

function makeHandle(id: string): RuntimeHandle {
  return { id, runtimeName: "mock", data: {} };
}

beforeEach(() => {
  originalPath = process.env.PATH;
  tmpDir = join(tmpdir(), `ao-test-session-mgr-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  // Create a temporary config file
  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");

  mockRuntime = {
    name: "mock",
    create: vi.fn().mockResolvedValue(makeHandle("rt-1")),
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
    getEnvironment: vi.fn().mockReturnValue({ AGENT_VAR: "1" }),
    detectActivity: vi.fn().mockReturnValue("active"),
    getActivityState: vi.fn().mockResolvedValue({ state: "active" }),
    isProcessRunning: vi.fn().mockResolvedValue(true),
    getSessionInfo: vi.fn().mockResolvedValue(null),
  };

  mockWorkspace = {
    name: "mock-ws",
    create: vi.fn().mockResolvedValue({
      path: "/tmp/mock-ws/app-1",
      branch: "feat/TEST-1",
      sessionId: "app-1",
      projectId: "my-app",
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  };

  mockRegistry = {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string, _name: string) => {
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
      notifiers: ["desktop"],
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
    notificationRouting: {
      urgent: ["desktop"],
      action: ["desktop"],
      warning: [],
      info: [],
    },
    reactions: {},
    readyThresholdMs: 300_000,
    startupGracePeriodMs: 120_000,
  };

  // Calculate sessions directory
  sessionsDir = getSessionsDir(configPath, join(tmpDir, "my-app"));
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.PATH = originalPath;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe("SessionManager Orchestrator Reuse", () => {
  it("does not reuse session if status is in NON_RESTORABLE_STATUSES during reuse, spawns a new one instead", async () => {
    const configWithReuse: OrchestratorConfig = {
      ...config,
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          orchestratorSessionStrategy: "reuse",
        },
      },
    };

    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: join(tmpDir, "my-app"),
      branch: "main",
      status: "merged",
      role: "orchestrator",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-existing")),
      createdAt: new Date().toISOString(),
    });

    vi.mocked(mockRuntime.isAlive).mockResolvedValue(true);

    const sm = createSessionManager({ config: configWithReuse, registry: mockRegistry });
    const session = await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(session.id).toBe("app-orchestrator");
    expect(session.metadata["orchestratorSessionReused"]).toBeUndefined();
    expect(session.status).toBe("working");
    expect(mockRuntime.destroy).toHaveBeenCalled();
    expect(mockRuntime.create).toHaveBeenCalled();
  });

  it("does not reuse session on reservation conflict if status is in NON_RESTORABLE_STATUSES during reuse, spawns new one", async () => {
    const configWithReuse: OrchestratorConfig = {
      ...config,
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          orchestratorSessionStrategy: "reuse",
        },
      },
    };

    // Write spawning session to skip Path 1
    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: join(tmpDir, "my-app"),
      branch: "main",
      status: "spawning",
      role: "orchestrator",
      project: "my-app",
      createdAt: new Date().toISOString(),
    });

    // Mock readMetadataRaw to return spawning for the first two calls, and the concurrent "merged" session for subsequent calls.
    let callCount = 0;
    const customReadMetadataRaw = vi.fn().mockImplementation((dir: string, id: string) => {
      callCount++;
      if (callCount <= 2) {
        return readMetadataRaw(dir, id);
      }
      return {
        worktree: join(tmpDir, "my-app"),
        branch: "main",
        status: "merged",
        role: "orchestrator",
        project: "my-app",
        runtimeHandle: JSON.stringify(makeHandle("rt-concurrent")),
        createdAt: new Date().toISOString(),
      };
    });

    vi.mocked(mockRuntime.isAlive).mockResolvedValue(true);

    const sm = createSessionManager({
      config: configWithReuse,
      registry: mockRegistry,
      readMetadataRaw: customReadMetadataRaw,
    });
    const session = await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(session.metadata["orchestratorSessionReused"]).toBeUndefined();
    expect(session.status).toBe("working");
    expect(mockRuntime.destroy).toHaveBeenCalled();
    expect(mockRuntime.create).toHaveBeenCalled();
  });

  it("reanimates session on reservation conflict if status is a restorable terminal status (e.g. killed) during reuse", async () => {
    const configWithReuse: OrchestratorConfig = {
      ...config,
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          orchestratorSessionStrategy: "reuse",
        },
      },
    };

    // Write spawning session to skip Path 1
    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: join(tmpDir, "my-app"),
      branch: "main",
      status: "spawning",
      role: "orchestrator",
      project: "my-app",
      createdAt: new Date().toISOString(),
    });

    // Mock readMetadataRaw to return spawning for the first two calls, and the concurrent "killed" session for subsequent calls.
    let callCount = 0;
    const customReadMetadataRaw = vi.fn().mockImplementation((dir: string, id: string) => {
      callCount++;
      if (callCount <= 2) {
        return readMetadataRaw(dir, id);
      }
      return {
        worktree: join(tmpDir, "my-app"),
        branch: "main",
        status: "killed",
        role: "orchestrator",
        project: "my-app",
        runtimeHandle: JSON.stringify(makeHandle("rt-concurrent")),
        createdAt: new Date().toISOString(),
      };
    });

    vi.mocked(mockRuntime.isAlive).mockResolvedValue(true);

    const sm = createSessionManager({
      config: configWithReuse,
      registry: mockRegistry,
      readMetadataRaw: customReadMetadataRaw,
    });
    const session = await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(session.metadata["orchestratorSessionReused"]).toBe("true");
    expect(session.status).toBe("working");
    expect(mockRuntime.create).not.toHaveBeenCalled();
    expect(mockRuntime.destroy).not.toHaveBeenCalled();

    const meta = readMetadataRaw(sessionsDir, "app-orchestrator");
    expect(meta?.["status"]).toBe("working");
  });
});
