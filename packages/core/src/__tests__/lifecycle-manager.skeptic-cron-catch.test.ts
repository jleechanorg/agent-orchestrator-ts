import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLifecycleManager, type LifecycleManagerDeps } from "../lifecycle-manager.js";
import type { OrchestratorConfig, Session, SessionManager, PluginRegistry } from "../types.js";
import type { SkepticCronDeps, SkepticCronParams } from "../skeptic-cron-local.js";
import type { ProjectObserver } from "../observability.js";

// Mock runLocalSkepticCron to throw/reject
const mockRunLocalSkepticCron = vi.fn<(deps: SkepticCronDeps, params: SkepticCronParams) => Promise<number>>();
vi.mock("../skeptic-cron-local.js", () => ({
  runLocalSkepticCron: (deps: SkepticCronDeps, params: SkepticCronParams): Promise<number> => mockRunLocalSkepticCron(deps, params),
}));

describe("lifecycle-manager skeptic-cron catch handler", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn<typeof console, "error">>;
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    tmpDir = join(tmpdir(), `ao-test-skeptic-catch-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({}));
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("should catch and log error when runLocalSkepticCron rejects", async () => {
    mockRunLocalSkepticCron.mockRejectedValue(new Error("test skeptic cron failure"));

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

    const mockSession = {
      id: "app-1",
      projectId: "my-project",
      status: "working",
      activity: "active",
      branch: "feat/test",
      issueId: null,
      pr: null,
      workspacePath: tmpDir,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    } as unknown as Session;

    const sessionManager = {
      listSessions: vi.fn().mockResolvedValue([mockSession]),
      getSession: vi.fn().mockResolvedValue(mockSession),
      get: vi.fn().mockResolvedValue(mockSession),
      saveSession: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([mockSession]),
    } as unknown as SessionManager;

    const registry = {
      register: vi.fn(),
      get: vi.fn().mockReturnValue({}),
      getModule: vi.fn().mockReturnValue(null),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
    } as unknown as PluginRegistry;

    const observer = {
      recordOperation: vi.fn(),
      recordSessionStateChange: vi.fn(),
      recordSloStatus: vi.fn(),
    } as unknown as ProjectObserver;

    const lm = createLifecycleManager({
      config,
      sessionManager,
      registry,
      projectId: "my-project",
    } as unknown as LifecycleManagerDeps);

    lm.start(60_000);

    // Wait until the mock runLocalSkepticCron function is called
    await vi.waitUntil(() => mockRunLocalSkepticCron.mock.calls.length > 0, { timeout: 5000 });

    lm.stop();

    // Since runLocalSkepticCron is called fire-and-forget, wait a tick for the promise rejection catch block to run
    await new Promise((resolve) => process.nextTick(resolve));

    expect(mockRunLocalSkepticCron).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
    const errorLog = consoleErrorSpy.mock.calls.find((call: Parameters<typeof console.error>): boolean =>
      typeof call[0] === "string" && call[0].includes("[skeptic-cron] failed")
    );
    expect(errorLog).toBeDefined();
    expect(errorLog![0]).toContain("projectId=my-project");
    expect(errorLog![0]).toContain("test skeptic cron failure");
  });
});
