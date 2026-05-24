
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createSessionManager } from "../session-manager.js";
import * as worktreeGit from "../utils/worktree-git.js";
import { writeMetadata, readMetadataRaw } from "../metadata.js";
import { getSessionsDir } from "../paths.js";
import type {
  OrchestratorConfig,
} from "../types.js";

vi.mock("../utils/worktree-git.js", () => ({
  getWorkspaceChangedFiles: vi.fn(),
}));

describe("SessionManager - Area Lock", () => {
  let tmpDir: string;
  let configPath: string;
  let sessionsDir: string;
  let mockRuntime: any;
  let mockAgent: any;
  let mockWorkspace: any;
  let mockRegistry: any;
  let mockLock: any;
  let config: OrchestratorConfig;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ao-test-session-lock-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "");

    config = {
      configPath,
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: {
        runtime: "mock-rt",
        agent: "mock-agent",
        workspace: "mock-ws",
        lock: "area-lock",
        notifiers: [],
      },
      projects: {
        "my-app": {
          name: "My App",
          repo: "org/repo",
          path: tmpDir,
          defaultBranch: "main",
          scm: { plugin: "github" },
          sessionPrefix: "app-",
        },
      },
      reactions: {},
      notificationRouting: {},
    } as any;

    const project = config.projects["my-app"];
    sessionsDir = getSessionsDir(config.configPath, project.path);
    mkdirSync(sessionsDir, { recursive: true });

    mockRuntime = {
      create: vi.fn().mockResolvedValue({ id: "rt-1", runtimeName: "mock", data: {} }),
    };

    mockAgent = {
      create: vi.fn().mockResolvedValue({}),
      isProcessRunning: vi.fn().mockResolvedValue(true),
      getLaunchCommand: vi.fn().mockReturnValue("mock-cmd"),
      getEnvironment: vi.fn().mockReturnValue({}),
    };

    mockWorkspace = {
      create: vi.fn().mockResolvedValue({ path: join(tmpDir, "ws-1") }),
    };

    mockLock = {
      check: vi.fn().mockResolvedValue({ status: "free" }),
      reserve: vi.fn().mockResolvedValue([]),
      release: vi.fn().mockResolvedValue([]),
    };

    mockRegistry = {
      get: vi.fn((slot, _name) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "lock") return mockLock;
        return null;
      }),
    };

    vi.mocked(worktreeGit.getWorkspaceChangedFiles).mockResolvedValue(["file1.ts"]);
    mkdirSync(join(tmpDir, "ws-1"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("blocks spawn if domain lock is held", async () => {
    mockLock.check.mockResolvedValue({
      status: "held",
      held_by: [{ pr_number: 123, agent: "other", branch: "feat/other" }],
    });

    const sm = createSessionManager({ config, registry: mockRegistry });

    await expect(
      sm.spawn({ projectId: "my-app", issueId: "456" })
    ).rejects.toThrow(/Spawn blocked: Domain lock is held/);

    expect(mockLock.check).toHaveBeenCalled();
  });

  it("reserves domain lock during spawn if free", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({ projectId: "my-app", issueId: "456" });

    expect(mockLock.check).toHaveBeenCalledWith(["file1.ts"], expect.any(String));
    expect(mockLock.reserve).toHaveBeenCalledWith(456, ["file1.ts"], "mock-agent", "feat/456", expect.any(String));
    
    const raw = readMetadataRaw(sessionsDir, session.id);
    expect(raw.lockReserved).toBe("true");
  });

  it("releases domain lock when session is killed", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    
    // Setup a session with PR metadata
    writeMetadata(sessionsDir, "app-1", {
      id: "app-1",
      projectId: "my-app",
      pr: "https://github.com/org/repo/pull/123",
      status: "merged",
    });

    await sm.kill("app-1");

    expect(mockLock.release).toHaveBeenCalledWith(123, expect.any(String));
  });

  it("releases old lock and reserves new lock during claimPR", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    // Setup a session with an old PR
    const wsPath = join(tmpDir, "ws-claim");
    mkdirSync(wsPath, { recursive: true });
    writeMetadata(sessionsDir, "app-claim", {
      id: "app-claim",
      projectId: "my-app",
      pr: "https://github.com/org/repo/pull/111",
      worktree: wsPath,
    });

    const mockScm = {
      resolvePR: vi.fn().mockResolvedValue({
        number: 222,
        url: "https://github.com/org/repo/pull/222",
        branch: "feat/new",
        baseBranch: "main",
      }),
      checkoutPR: vi.fn().mockResolvedValue(true),
      getPRState: vi.fn().mockResolvedValue("open"),
    };
    mockRegistry.get.mockImplementation((slot, _name) => {
      if (slot === "scm") return mockScm;
      if (slot === "lock") return mockLock;
      if (slot === "runtime") return mockRuntime;
      if (slot === "agent") return mockAgent;
      if (slot === "workspace") return mockWorkspace;
      return null;
    });

    await sm.claimPR("app-claim", "222");

    // Should release old lock
    expect(mockLock.release).toHaveBeenCalledWith(111, wsPath);
    
    // Should reserve new lock
    expect(mockLock.reserve).toHaveBeenCalledWith(222, ["file1.ts"], "mock-agent", "feat/new", wsPath);
    
    const raw = readMetadataRaw(sessionsDir, "app-claim");
    expect(raw.lockReserved).toBe("true");
  });
  it("releases lock on spawn failure after reservation", async () => {
    // Simulate reserve succeeding but runtime creation failing
    mockRuntime.create.mockRejectedValue(new Error("runtime creation failed"));

    const sm = createSessionManager({ config, registry: mockRegistry });

    await expect(
      sm.spawn({ projectId: "my-app", issueId: "456" })
    ).rejects.toThrow(/runtime creation failed/);

    // Lock should have been reserved then released on cleanup
    expect(mockLock.reserve).toHaveBeenCalledWith(456, ["file1.ts"], "mock-agent", "feat/456", expect.any(String));
    expect(mockLock.release).toHaveBeenCalledWith(456, expect.any(String));
  });

  it("reserves new lock before releasing old lock in claimPR", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const wsPath = join(tmpDir, "ws-order");
    mkdirSync(wsPath, { recursive: true });
    writeMetadata(sessionsDir, "app-order", {
      id: "app-order",
      projectId: "my-app",
      pr: "https://github.com/org/repo/pull/111",
      worktree: wsPath,
    });

    const callOrder: string[] = [];
    const mockScm = {
      resolvePR: vi.fn().mockResolvedValue({
        number: 222,
        url: "https://github.com/org/repo/pull/222",
        branch: "feat/new",
        baseBranch: "main",
      }),
      checkoutPR: vi.fn().mockImplementation(async () => { callOrder.push("checkout"); return true; }),
      getPRState: vi.fn().mockResolvedValue("open"),
    };
    mockLock.reserve.mockImplementation(async () => { callOrder.push("reserve"); return []; });
    mockLock.release.mockImplementation(async () => { callOrder.push("release"); return []; });
    mockRegistry.get.mockImplementation((slot, _name) => {
      if (slot === "scm") return mockScm;
      if (slot === "lock") return mockLock;
      if (slot === "runtime") return mockRuntime;
      if (slot === "agent") return mockAgent;
      if (slot === "workspace") return mockWorkspace;
      return null;
    });

    await sm.claimPR("app-order", "222");

    // Order must be: checkout → reserve → release (not release before checkout)
    expect(callOrder).toEqual(["checkout", "reserve", "release"]);
  });

});