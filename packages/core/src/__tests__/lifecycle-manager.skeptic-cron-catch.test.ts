import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLifecycleManager } from "../lifecycle-manager.js";
import type { OrchestratorConfig, Session } from "../types.js";

// Mock runLocalSkepticCron to throw/reject
const mockRunLocalSkepticCron = vi.fn();
vi.mock("../skeptic-cron-local.js", () => ({
  runLocalSkepticCron: (...args: any[]) => mockRunLocalSkepticCron(...args),
}));

describe("lifecycle-manager skeptic-cron catch handler", () => {
  let consoleErrorSpy: any;
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

    const config: OrchestratorConfig = {
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
    } as any;

    const mockSession: Session = {
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
    } as any;

    const sessionManager = {
      listSessions: vi.fn().mockResolvedValue([mockSession]),
      getSession: vi.fn().mockResolvedValue(mockSession),
      get: vi.fn().mockResolvedValue(mockSession),
      saveSession: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([mockSession]),
    } as any;

    const registry = {
      get: vi.fn().mockReturnValue({}),
    } as any;

    const observer = {
      recordOperation: vi.fn(),
      recordSessionStateChange: vi.fn(),
      recordSloStatus: vi.fn(),
    } as any;

    const lm = createLifecycleManager({
      config,
      sessionManager,
      registry,
      observer,
      projectId: "my-project",
    } as any);

    lm.start(60_000);

    // Wait until the mock runLocalSkepticCron function is called
    await vi.waitUntil(() => mockRunLocalSkepticCron.mock.calls.length > 0, { timeout: 5000 });

    lm.stop();

    // Since runLocalSkepticCron is called fire-and-forget, wait a tick for the promise rejection catch block to run
    await new Promise((resolve) => process.nextTick(resolve));

    expect(mockRunLocalSkepticCron).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
    const errorLog = consoleErrorSpy.mock.calls.find((call: any[]) =>
      call[0] && call[0].includes("[skeptic-cron] failed")
    );
    expect(errorLog).toBeDefined();
    expect(errorLog[0]).toContain("projectId=my-project");
    expect(errorLog[0]).toContain("test skeptic cron failure");
  });
});
