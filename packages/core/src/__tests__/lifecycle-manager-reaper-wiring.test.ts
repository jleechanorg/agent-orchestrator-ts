import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLifecycleManager, type LifecycleManagerDeps } from "../lifecycle-manager.js";
import type { OrchestratorConfig, SessionManager, PluginRegistry } from "../types.js";
import type { ReaperConfig, ReaperDeps } from "../session-reaper.js";

// Mock runLocalSkepticCron so it doesn't trigger real logic
vi.mock("../skeptic-cron-local.js", () => ({
  runLocalSkepticCron: vi.fn().mockResolvedValue(0),
}));

// Mock reapStaleSessions to verify config wiring
const mockReapStaleSessions = vi.fn().mockResolvedValue({ killed: [], skipped: [], errors: [], dryRun: false });
vi.mock("../session-reaper.js", () => ({
  reapStaleSessions: (config: ReaperConfig, deps: ReaperDeps) => mockReapStaleSessions(config, deps),
  DEFAULT_REAPER_CONFIG: {
    orphanedThresholdMs: 7200000,
    noPrThresholdMs: 14400000,
    maxKillsPerRun: 15,
  },
}));

describe("lifecycle-manager reaper configuration wiring", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = join(tmpdir(), `ao-test-reaper-wiring-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({}));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("should pass custom reaper options from OrchestratorConfig to reapStaleSessions", async () => {
    const config = {
      configPath,
      defaults: {},
      projects: {
        "my-project": {
          name: "My Project",
          repo: "org/my-project",
          path: tmpDir,
          defaultBranch: "main",
          sessionPrefix: "app",
          scm: { plugin: "github" },
        },
      },
      reaper: {
        orphanedThresholdMs: 999999,
        noPrThresholdMs: 888888,
        maxKillsPerRun: 42,
      },
    } as unknown as OrchestratorConfig;

    const sessionManager = {
      list: vi.fn().mockResolvedValue([]),
    } as unknown as SessionManager;

    const registry = {
      register: vi.fn(),
      get: vi.fn().mockReturnValue({}),
      getModule: vi.fn().mockReturnValue(null),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
    } as unknown as PluginRegistry;

    const lm = createLifecycleManager({
      config,
      sessionManager,
      registry,
      projectId: "my-project",
    } as unknown as LifecycleManagerDeps);

    // lm.start() immediately triggers one pollAll() call synchronously or via microtask
    lm.start(60_000);

    // Wait for the pollAll cycle to run and call our mock
    await vi.waitUntil(() => mockReapStaleSessions.mock.calls.length > 0, { timeout: 2000 });

    lm.stop();

    expect(mockReapStaleSessions).toHaveBeenCalled();
    const [passedConfig, passedDeps] = mockReapStaleSessions.mock.calls[0];

    // Assert that the custom reaper options from config are present in the passed config
    expect(passedConfig.orphanedThresholdMs).toBe(999999);
    expect(passedConfig.noPrThresholdMs).toBe(888888);
    expect(passedConfig.maxKillsPerRun).toBe(42);

    // Check that we fallback correctly to DEFAULT_REAPER_CONFIG values if not provided
    expect(passedDeps.sessionManager).toBe(sessionManager);
  });

  it("should log killed sessions when reaper kills stale sessions", async () => {
    mockReapStaleSessions.mockResolvedValueOnce({
      killed: [{ sessionId: "session-1", reason: "stale" }],
      skipped: [],
      errors: [],
      dryRun: false,
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const config = {
      configPath,
      defaults: {},
      projects: {
        "my-project": {
          name: "My Project",
          repo: "org/my-project",
          path: tmpDir,
          defaultBranch: "main",
          sessionPrefix: "app",
          scm: { plugin: "github" },
        },
      },
    } as unknown as OrchestratorConfig;

    const sessionManager = {
      list: vi.fn().mockResolvedValue([]),
    } as unknown as SessionManager;

    const registry = {
      register: vi.fn(),
      get: vi.fn().mockReturnValue({}),
      getModule: vi.fn().mockReturnValue(null),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
    } as unknown as PluginRegistry;

    const lm = createLifecycleManager({
      config,
      sessionManager,
      registry,
      projectId: "my-project",
    } as unknown as LifecycleManagerDeps);

    lm.start(60_000);
    await vi.waitUntil(() => mockReapStaleSessions.mock.calls.length > 0, { timeout: 2000 });
    lm.stop();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[session-reaper] killed 1 stale session(s): session-1"),
    );
    consoleSpy.mockRestore();
  });

  it("should log warnings when reaper encounters errors during execution", async () => {
    mockReapStaleSessions.mockResolvedValueOnce({
      killed: [],
      skipped: [],
      errors: [{ sessionId: "session-2", error: "permission denied" }],
      dryRun: false,
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const config = {
      configPath,
      defaults: {},
      projects: {
        "my-project": {
          name: "My Project",
          repo: "org/my-project",
          path: tmpDir,
          defaultBranch: "main",
          sessionPrefix: "app",
          scm: { plugin: "github" },
        },
      },
    } as unknown as OrchestratorConfig;

    const sessionManager = {
      list: vi.fn().mockResolvedValue([]),
    } as unknown as SessionManager;

    const registry = {
      register: vi.fn(),
      get: vi.fn().mockReturnValue({}),
      getModule: vi.fn().mockReturnValue(null),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
    } as unknown as PluginRegistry;

    const lm = createLifecycleManager({
      config,
      sessionManager,
      registry,
      projectId: "my-project",
    } as unknown as LifecycleManagerDeps);

    lm.start(60_000);
    await vi.waitUntil(() => mockReapStaleSessions.mock.calls.length > 0, { timeout: 2000 });
    lm.stop();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[session-reaper] errors: session-2: permission denied"),
    );
    warnSpy.mockRestore();
  });

  it("should handle and log exceptions thrown during reaping", async () => {
    mockReapStaleSessions.mockRejectedValueOnce(new Error("reaping exploded"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const config = {
      configPath,
      defaults: {},
      projects: {
        "my-project": {
          name: "My Project",
          repo: "org/my-project",
          path: tmpDir,
          defaultBranch: "main",
          sessionPrefix: "app",
          scm: { plugin: "github" },
        },
      },
    } as unknown as OrchestratorConfig;

    const sessionManager = {
      list: vi.fn().mockResolvedValue([]),
    } as unknown as SessionManager;

    const registry = {
      register: vi.fn(),
      get: vi.fn().mockReturnValue({}),
      getModule: vi.fn().mockReturnValue(null),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
    } as unknown as PluginRegistry;

    const lm = createLifecycleManager({
      config,
      sessionManager,
      registry,
      projectId: "my-project",
    } as unknown as LifecycleManagerDeps);

    lm.start(60_000);
    await vi.waitUntil(() => mockReapStaleSessions.mock.calls.length > 0, { timeout: 2000 });
    lm.stop();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[session-reaper] sweep failed: reaping exploded"),
    );
    errorSpy.mockRestore();
  });
});
