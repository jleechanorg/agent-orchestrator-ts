import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrchestratorConfig } from "@jleechanorg/ao-core";

// Stable mock references used inside vi.mock factories
// Default implementation: return an empty buffer so bare calls don't throw.
// Tests override specific calls with mockReturnValueOnce / mockImplementationOnce.
const mockExecFileSync = vi.hoisted(() =>
  vi.fn(() => {
    // Default: return an empty buffer (trims to "", no match → false/null).
    // Tests override with mockReturnValueOnce for the specific calls they care about.
    return Buffer.from("");
  }),
);

const MOCK_FS = vi.hoisted(() => {
  let store: Record<string, unknown> = {};
  return {
    get store() {
      return store;
    },
    reset() {
      mockExecFileSync.mockReset();
      store = {};
    },
  };
});

vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock("node:fs", () => ({
  closeSync: () => undefined,
  existsSync: (path: string) =>
    Boolean(MOCK_FS.store[`existsSync:${path}`]),
  mkdirSync: () => undefined,
  openSync: () => 99,
  readFileSync: (path: string) =>
    (MOCK_FS.store[`readFileSync:${path}`] as string) ?? "",
  unlinkSync: (path: string) => {
    MOCK_FS.store[`unlinkSync:${path}`] = true;
  },
  writeFileSync: (path: string, data: string) => {
    MOCK_FS.store[`writeFileSync:${path}`] = data;
  },
}));

vi.mock("@jleechanorg/ao-core", () => ({
  getProjectBaseDir: (_configPath: string, projectPath: string) => {
    const projectId = projectPath.split("/").pop() ?? projectPath;
    return `/tmp/ao-test/${projectId}`;
  },
}));

const {
  getLifecycleWorkerStatus,
  stopLifecycleWorker,
  writeLifecycleWorkerPid,
  clearLifecycleWorkerPid,
} = await import("../../src/lib/lifecycle-service.js");

function mockConfig(projects: Record<string, string>): OrchestratorConfig {
  return {
    configPath: "/tmp/ao-ls-test/agent-orchestrator.yaml",
    projects: Object.fromEntries(
      Object.entries(projects).map(([k, v]) => [k, { path: v }]),
    ),
  } as unknown as OrchestratorConfig;
}

function pidFile(projectId: string): string {
  return `/tmp/ao-test/${projectId}/lifecycle-worker.pid`;
}

function setExists(file: string, val: boolean): void {
  MOCK_FS.store[`existsSync:${file}`] = val;
}

function setReadFile(file: string, val: string): void {
  MOCK_FS.store[`readFileSync:${file}`] = val;
}

function mockPsResult(cmdline: string): void {
  mockExecFileSync.mockReturnValueOnce(Buffer.from(`${cmdline}\n`));
}

function mockPsFailure(): void {
  mockExecFileSync.mockImplementationOnce(() => {
    throw new Error("No such process");
  });
}

beforeEach(() => {
  MOCK_FS.reset();
});

describe("getLifecycleWorkerStatus", () => {
  it("returns running=true when pid file exists and ps matches the project", () => {
    const cfg = mockConfig({ "test-proj": "/repos/test-proj" });
    const pf = pidFile("test-proj");

    setExists(pf, true);
    setReadFile(pf, "12345\n");
    mockPsResult("/path/to/node ao lifecycle-worker test-proj");

    const status = getLifecycleWorkerStatus(cfg, "test-proj");

    expect(status.running).toBe(true);
    expect(status.pid).toBe(12345);
  });

  it("returns running=false and preserves PID file when ps fails (indeterminate)", () => {
    const cfg = mockConfig({ "test-proj": "/repos/test-proj" });
    const pf = pidFile("test-proj");

    setExists(pf, true);
    setReadFile(pf, "99999\n");
    mockPsFailure(); // isLifecycleWorkerProcess returns null

    const status = getLifecycleWorkerStatus(cfg, "test-proj");

    // indeterminate → PID file is NOT cleared; status.pid is null so
    // stopLifecycleWorker knows not to attempt killing an unverified PID
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
  });

  it("returns running=false when ps succeeds but project ID is different", () => {
    const cfg = mockConfig({ "test-proj": "/repos/test-proj" });
    const pf = pidFile("test-proj");

    setExists(pf, true);
    setReadFile(pf, "54321\n");
    // ps finds a different project's lifecycle-worker
    mockPsResult("/path/to/node ao lifecycle-worker other-proj");

    const status = getLifecycleWorkerStatus(cfg, "test-proj");

    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
  });

  it("prevents prefix false positive: api does not match api-v2", () => {
    // Both projects exist, api's PID file is stale and points to api-v2's worker
    const cfg = mockConfig({
      api: "/repos/api",
      "api-v2": "/repos/api-v2",
    });
    const apiPf = pidFile("api");

    setExists(apiPf, true);
    setReadFile(apiPf, "11111\n");
    // ps finds api-v2, not api — PID was recycled
    mockPsResult("/path/to/node ao lifecycle-worker api-v2");

    const status = getLifecycleWorkerStatus(cfg, "api");

    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
  });

  it("api correctly matches lifecycle-worker api", () => {
    const cfg = mockConfig({ api: "/repos/api" });
    const pf = pidFile("api");

    setExists(pf, true);
    setReadFile(pf, "22222\n");
    mockPsResult("/path/to/node ao lifecycle-worker api");

    const status = getLifecycleWorkerStatus(cfg, "api");

    expect(status.running).toBe(true);
    expect(status.pid).toBe(22222);
  });
});

describe("stopLifecycleWorker", () => {
  it("returns false when worker is not running (no pid file)", async () => {
    const cfg = mockConfig({ "test-proj": "/repos/test-proj" });
    setExists(pidFile("test-proj"), false);

    const result = await stopLifecycleWorker(cfg, "test-proj");

    expect(result).toBe(false);
  });

  it("sends SIGTERM and returns true on clean stop", async () => {
    const cfg = mockConfig({ "test-proj": "/repos/test-proj" });
    const pf = pidFile("test-proj");

    setExists(pf, true);
    setReadFile(pf, "33333\n");
    // isLifecycleWorkerProcess call 1 (from getLifecycleWorkerStatus): match → running
    mockPsResult("/path/to/node ao lifecycle-worker test-proj");
    // isLifecycleWorkerProcess call 2 (wait loop): process is gone
    mockPsFailure();

    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      const result = await stopLifecycleWorker(cfg, "test-proj");

      expect(result).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(33333, "SIGTERM");
    } finally {
      killSpy.mockRestore();
    }
  });

  it("returns false when getLifecycleWorkerStatus is indeterminate (ps failed)", async () => {
    // When isLifecycleWorkerProcess returns null (ps failed), status.pid is null,
    // so stopLifecycleWorker cannot safely attempt to kill the process.
    const cfg = mockConfig({ "test-proj": "/repos/test-proj" });
    const pf = pidFile("test-proj");

    setExists(pf, true);
    setReadFile(pf, "44444\n");
    mockPsFailure(); // isLifecycleWorkerProcess returns null

    const result = await stopLifecycleWorker(cfg, "test-proj");

    // Cannot kill a PID we cannot verify — conservative: do not attempt
    expect(result).toBe(false);
  });
});

describe("writeLifecycleWorkerPid / clearLifecycleWorkerPid", () => {
  it("writeLifecycleWorkerPid stores the PID in the correct file", () => {
    const cfg = mockConfig({ "test-proj": "/repos/test-proj" });
    const pf = pidFile("test-proj");

    writeLifecycleWorkerPid(cfg, "test-proj", 77777);

    expect(MOCK_FS.store[`writeFileSync:${pf}`]).toBe("77777\n");
  });

  it("clearLifecycleWorkerPid is called (guarded by PID match)", () => {
    const cfg = mockConfig({ "test-proj": "/repos/test-proj" });
    const pf = pidFile("test-proj");

    setExists(pf, true);
    setReadFile(pf, "88888\n");

    // PID in file is 88888, passed PID is 88888 — should clear via unlinkSync
    clearLifecycleWorkerPid(cfg, "test-proj", 88888);
    expect(MOCK_FS.store[`unlinkSync:${pf}`]).toBe(true);
  });

  it("clearLifecycleWorkerPid skips when PID does not match", () => {
    const cfg = mockConfig({ "test-proj": "/repos/test-proj" });
    const pf = pidFile("test-proj");

    setExists(pf, true);
    setReadFile(pf, "99999\n");

    // PID in file is 99999, passed PID is 88888 — should NOT call unlinkSync
    clearLifecycleWorkerPid(cfg, "test-proj", 88888);
    expect(MOCK_FS.store[`unlinkSync:${pf}`]).toBeUndefined();
  });
});
