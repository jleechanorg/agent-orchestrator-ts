
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createLifecycleManager } from "../lifecycle-manager.js";
import * as worktreeGit from "../utils/worktree-git.js";
import type {
  OrchestratorConfig,
  Session,
} from "../types.js";

vi.mock("../utils/worktree-git.js", () => ({
  getWorkspaceChangedFiles: vi.fn(),
}));

describe("LifecycleManager - Area Lock Reservation", () => {
  let tmpDir: string;
  let configPath: string;
  let sessionsDir: string;
  let mockSessionManager: any;
  let mockRegistry: any;
  let mockLock: any;
  let mockAgent: any;
  let config: OrchestratorConfig;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ao-test-lock-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, ""); // Create the file
    sessionsDir = join(tmpDir, "sessions", "my-app");
    mkdirSync(sessionsDir, { recursive: true });

    config = {
      configPath,
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
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
        },
      },
      reactions: {},
      notificationRouting: {},
    } as any;

    mockSessionManager = {
      listSessions: vi.fn(),
      get: vi.fn(),
      kill: vi.fn().mockResolvedValue(undefined),
    };

    mockLock = {
      reserve: vi.fn().mockResolvedValue([]),
    };

    mockAgent = {
      isProcessRunning: vi.fn().mockResolvedValue(true),
      getActivityState: vi.fn().mockResolvedValue({ state: "working" }),
    };

    mockRegistry = {
      get: vi.fn((slot, _name) => {
        if (slot === "lock") return mockLock;
        if (slot === "agent") return mockAgent;
        return null;
      }),
      getModule: vi.fn().mockReturnValue(null),
    };

    vi.mocked(worktreeGit.getWorkspaceChangedFiles).mockResolvedValue(["file1.ts"]);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reserves domain locks when a PR is newly detected", async () => {
    const wsPath = join(tmpDir, "ws");
    mkdirSync(wsPath, { recursive: true });
    const session: Session = {
      id: "app-1",
      projectId: "my-app",
      status: "running",
      activity: "active",
      branch: "feat/test",
      pr: null,
      workspacePath: wsPath,
      metadata: { agent: "test-agent" },
      createdAt: new Date(),
      lastActivityAt: new Date(),
      runtimeHandle: { id: "rt-1", runtimeName: "mock", data: {} },
    } as any;

    mockSessionManager.get.mockResolvedValue(session);

    const mockScm = {
      detectPR: vi.fn().mockResolvedValue({
        number: 123,
        url: "https://github.com/org/repo/pull/123",
        branch: "feat/test",
        baseBranch: "main",
      }),
      getPendingComments: vi.fn().mockResolvedValue([]),
      getAutomatedReviews: vi.fn().mockResolvedValue([]),
      getAutomatedComments: vi.fn().mockResolvedValue([]),
      getReviews: vi.fn().mockResolvedValue([]),
      getCISummary: vi.fn().mockResolvedValue("pending"),
      getReviewDecision: vi.fn().mockResolvedValue(null),
    };
    mockRegistry.get.mockImplementation((slot, _name) => {
      if (slot === "scm") return mockScm;
      if (slot === "lock") return mockLock;
      if (slot === "agent") return mockAgent;
      return null;
    });

    const lm = createLifecycleManager({
      config,
      sessionManager: mockSessionManager,
      registry: mockRegistry,
    });

    await lm.check(session.id);

    expect(worktreeGit.getWorkspaceChangedFiles).toHaveBeenCalledWith(session.workspacePath, "main");
    expect(mockLock.reserve).toHaveBeenCalledWith(123, ["file1.ts"], "test-agent", "feat/test", session.workspacePath);
    
    // Verify metadata was updated
    expect(session.metadata.lockReserved).toBe("true");
  });

  it("reserves domain locks for sessions that already have PR metadata but haven't reserved yet", async () => {
    const wsPath = join(tmpDir, "ws2");
    mkdirSync(wsPath, { recursive: true });
    const session: Session = {
      id: "app-2",
      projectId: "my-app",
      status: "running",
      activity: "active",
      branch: "feat/test2",
      pr: { number: 456, url: "...", branch: "feat/test2" },
      workspacePath: wsPath,
      metadata: { agent: "test-agent-2" },
      createdAt: new Date(),
      lastActivityAt: new Date(),
      runtimeHandle: { id: "rt-2", runtimeName: "mock", data: {} },
    } as any;

    mockSessionManager.get.mockResolvedValue(session);

    const lm = createLifecycleManager({
      config,
      sessionManager: mockSessionManager,
      registry: mockRegistry,
    });

    await lm.check(session.id);

    expect(worktreeGit.getWorkspaceChangedFiles).toHaveBeenCalledWith(session.workspacePath, "main");
    expect(mockLock.reserve).toHaveBeenCalledWith(456, ["file1.ts"], "test-agent-2", "feat/test2", session.workspacePath);
    expect(session.metadata.lockReserved).toBe("true");
  });

  it("does not re-reserve if lockReserved is already true", async () => {
    const wsPath = join(tmpDir, "ws3");
    mkdirSync(wsPath, { recursive: true });
    const session: Session = {
      id: "app-3",
      projectId: "my-app",
      status: "running",
      activity: "active",
      branch: "feat/test3",
      pr: { number: 789, url: "...", branch: "feat/test3" },
      workspacePath: wsPath,
      metadata: { lockReserved: "true" },
      createdAt: new Date(),
      lastActivityAt: new Date(),
      runtimeHandle: { id: "rt-3", runtimeName: "mock", data: {} },
    } as any;

    mockSessionManager.get.mockResolvedValue(session);

    const lm = createLifecycleManager({
      config,
      sessionManager: mockSessionManager,
      registry: mockRegistry,
    });

    await lm.check(session.id);

    expect(mockLock.reserve).not.toHaveBeenCalled();
  });
});
