import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrchestratorConfig } from "@jleechanorg/ao-core";

// Stable mock references used inside vi.mock factories.
// Default implementation: return an empty buffer so bare calls don't throw.
// Tests override specific calls with mockReturnValueOnce / mockImplementationOnce.
const mockExecFileSync = vi.hoisted(() =>
  vi.fn(() => {
    // Default: return an empty buffer (trims to "", no match → false/null).
    // Tests override with mockReturnValueOnce for the specific calls they care about.
    return Buffer.from("");
  }),
);

const mockSpawn = vi.fn();

const MOCK_FS = vi.hoisted(() => {
  let store: Record<string, unknown> = {};
  let lockHeld = false;
  return {
    get store() {
      return store;
    },
    get lockHeld() {
      return lockHeld;
    },
    set lockHeld(val: boolean) {
      lockHeld = val;
    },
    reset() {
      mockExecFileSync.mockReset();
      mockSpawn.mockReset();
      store = {};
      lockHeld = false;
    },
  };
});

vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
  spawn: mockSpawn,
}));

vi.mock("node:fs", () => ({
  closeSync: () => undefined,
  constants: { O_CREAT: 64, O_EXCL: 128, O_WRONLY: 1 },
  existsSync: (path: string) =>
    Boolean(MOCK_FS.store[`existsSync:${path}`]),
  mkdirSync: () => undefined,
  openSync: (path: string, flags: number | string) => {
    const O_EXCL = 128;
    if (typeof flags === "number" && (flags & O_EXCL) !== 0) {
      if (MOCK_FS.lockHeld) {
        const err = Object.assign(new Error("EEXIST"), { code: "EEXIST" });
        throw err;
      }
      MOCK_FS.lockHeld = true;
      MOCK_FS.store[`existsSync:${path}`] = true;
    }
    return 99;
  },
  readFileSync: (path: string) =>
    (MOCK_FS.store[`readFileSync:${path}`] as string) ?? "",
  unlinkSync: (path: string) => {
    MOCK_FS.store[`unlinkSync:${path}`] = true;
    if (path.endsWith("lifecycle-worker.lock")) {
      MOCK_FS.lockHeld = false;
    }
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
  ensureLifecycleWorker,
  writeLifecycleWorkerPid,
  clearLifecycleWorkerPid,
  tryAcquireLifecycleLock,
  scanForRunningLifecycleWorker,
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
  it("returns running=true and verified=true when pid file exists and ps matches the project", () => {
    const cfg = mockConfig({ "test-proj": "/repos/test-proj" });
    const pf = pidFile("test-proj");

    setExists(pf, true);
    setReadFile(pf, "12345\n");
    mockPsResult("/path/to/node ao lifecycle-worker test-proj");

    const status = getLifecycleWorkerStatus(cfg, "test-proj");

    expect(status.running).toBe(true);
    expect(status.pid).toBe(12345);
    expect(status.verified).toBe(true);
  });

  it("returns verified=null and does NOT call unlinkSync when ps fails (indeterminate)", () => {
    const cfg = mockConfig({ "test-proj": "/repos/test-proj" });
    const pf = pidFile("test-proj");

    setExists(pf, true);
    setReadFile(pf, "99999\n");
    mockPsFailure(); // isLifecycleWorkerProcess returns null

    const status = getLifecycleWorkerStatus(cfg, "test-proj");

    // indeterminate → PID file is NOT cleared; verified=null signals to
    // callers that they should not act on this state.
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    expect(status.verified).toBeNull();
    expect(MOCK_FS.store[`unlinkSync:${pf}`]).toBeUndefined();
  });

  it("returns verified=false when ps succeeds but project ID is different", () => {
    const cfg = mockConfig({ "test-proj": "/repos/test-proj" });
    const pf = pidFile("test-proj");

    setExists(pf, true);
    setReadFile(pf, "54321\n");
    // ps finds a different project's lifecycle-worker
    mockPsResult("/path/to/node ao lifecycle-worker other-proj");

    const status = getLifecycleWorkerStatus(cfg, "test-proj");

    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    expect(status.verified).toBe(false);
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
    expect(status.verified).toBe(false);
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
    expect(status.verified).toBe(true);
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

  it("returns false and does NOT call process.kill when verified=null (ps failed)", async () => {
    // When verified=null, stopLifecycleWorker must not send SIGTERM because the
    // PID file still exists and the worker may be running (ps was just flaky).
    const cfg = mockConfig({ "test-proj": "/repos/test-proj" });
    const pf = pidFile("test-proj");

    setExists(pf, true);
    setReadFile(pf, "44444\n");
    mockPsFailure(); // isLifecycleWorkerProcess returns null → verified=null

    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      const result = await stopLifecycleWorker(cfg, "test-proj");

      // Cannot kill a PID we cannot verify — conservative: do not attempt
      expect(result).toBe(false);
      expect(killSpy).not.toHaveBeenCalled();
      // PID file is also not cleared (verified=null means indeterminate)
      expect(MOCK_FS.store[`unlinkSync:${pf}`]).toBeUndefined();
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe("ensureLifecycleWorker", () => {
  it("does NOT spawn a new worker when verified=null (ps failed) — preserves PID file", async () => {
    // When ps fails (verified=null), ensureLifecycleWorker must not spawn a new
    // worker because a genuine lifecycle-worker may already be running. The PID
    // file is left intact so the next call can retry verification.
    const cfg = mockConfig({ "test-proj": "/repos/test-proj" });
    const pf = pidFile("test-proj");

    setExists(pf, true);
    setReadFile(pf, "55555\n");
    mockPsFailure(); // getLifecycleWorkerStatus: verified=null

    // Mock spawn so we can assert it was NOT called
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockSpawn.mockReturnValueOnce({ pid: 99999, unref: () => {} } as any);

    const result = await ensureLifecycleWorker(cfg, "test-proj");

    // verified=null → must not start a new worker
    expect(result.started).toBe(false);
    // spawn must not have been called — no duplicate worker created
    expect(mockSpawn).not.toHaveBeenCalled();
    // PID file is preserved
    expect(MOCK_FS.store[`unlinkSync:${pf}`]).toBeUndefined();
  });
});


describe("tryAcquireLifecycleLock (orch-886k)", () => {
  it("returns a release function on first acquire", () => {
    const cfg = mockConfig({ "test-proj": "/repos/test-proj" });
    const release = tryAcquireLifecycleLock(cfg, "test-proj");
    expect(release).toBeTypeOf("function");
    if (release) release();
  });

  it("returns null when lock is already held by a live process", () => {
    const cfg = mockConfig({ "test-proj": "/repos/test-proj" });
    // First acquire: succeeds.
    const release1 = tryAcquireLifecycleLock(cfg, "test-proj");
    expect(release1).toBeTypeOf("function");

    // Simulate the lock file contains a PID of a still-alive process.
    const lockFile = `/tmp/ao-test/test-proj/lifecycle-worker.lock`;
    MOCK_FS.store[`readFileSync:${lockFile}`] = "99999\n";
    // ps finds the process alive.
    mockExecFileSync.mockReturnValueOnce(
      Buffer.from("/path/to/node ao lifecycle-worker test-proj\n"),
    );

    // Second acquire: lock is live → must return null.
    const release2 = tryAcquireLifecycleLock(cfg, "test-proj");
    expect(release2).toBeNull();
    if (release1) release1();
  });

  it("reaps a stale lock (crashed owner) and returns a valid release function", () => {
    const cfg = mockConfig({ "test-proj": "/repos/test-proj" });
    const lockFile = `/tmp/ao-test/test-proj/lifecycle-worker.lock`;

    // First acquire succeeds and simulates a crash (no release called).
    const release1 = tryAcquireLifecycleLock(cfg, "test-proj");
    expect(release1).toBeTypeOf("function");
    // Simulate the lock file contains the PID of a crashed process.
    MOCK_FS.store[`readFileSync:${lockFile}`] = "77777\n";
    // ps returns empty (process is dead).
    mockExecFileSync.mockReturnValueOnce(Buffer.from("\n"));

    // Second acquire: stale lock is reaped, re-acquisition succeeds.
    const release2 = tryAcquireLifecycleLock(cfg, "test-proj");
    expect(release2).toBeTypeOf("function");
    if (release2) release2();
    if (release1) release1();
  });

  it("reaps a stale lock when ps fails (process is gone)", () => {
    const cfg = mockConfig({ "test-proj": "/repos/test-proj" });
    const lockFile = `/tmp/ao-test/test-proj/lifecycle-worker.lock`;

    // First acquire succeeds (no release — simulating crash).
    const release1 = tryAcquireLifecycleLock(cfg, "test-proj");
    expect(release1).toBeTypeOf("function");
    // Lock file contains a PID.
    MOCK_FS.store[`readFileSync:${lockFile}`] = "88888\n";
    // ps fails (ESRCH: process does not exist).
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("No such process");
    });

    // Second acquire: ps failure means process is gone → stale lock reaped.
    const release2 = tryAcquireLifecycleLock(cfg, "test-proj");
    expect(release2).toBeTypeOf("function");
    if (release2) release2();
    if (release1) release1();
  });

  it("returns null when lock is already held", () => {
    const cfg = mockConfig({ "test-proj": "/repos/test-proj" });
    const release1 = tryAcquireLifecycleLock(cfg, "test-proj");
    expect(release1).toBeTypeOf("function");
    const release2 = tryAcquireLifecycleLock(cfg, "test-proj");
    expect(release2).toBeNull();
    if (release1) release1();
  });

  it("allows re-acquire after lock is released", () => {
    const cfg = mockConfig({ "test-proj": "/repos/test-proj" });
    const release1 = tryAcquireLifecycleLock(cfg, "test-proj");
    expect(release1).toBeTypeOf("function");
    if (release1) release1();
    const release2 = tryAcquireLifecycleLock(cfg, "test-proj");
    expect(release2).toBeTypeOf("function");
    if (release2) release2();
  });
});

describe("scanForRunningLifecycleWorker (orch-886k)", () => {
  it("returns the PID when a matching lifecycle-worker is found in ps output", () => {
    // ps -ww -o pid,args= format: "  PID command..." (no USER column, no header)
    mockExecFileSync.mockReturnValueOnce(
      Buffer.from("12345 node /path/to/ao lifecycle-worker myproject\n"),
    );
    const pid = scanForRunningLifecycleWorker("myproject");
    expect(pid).toBe(12345);
  });

  it("returns null when no matching lifecycle-worker is in ps output", () => {
    mockExecFileSync.mockReturnValueOnce(
      Buffer.from("99999 node /path/to/ao lifecycle-worker other-project\n"),
    );
    const pid = scanForRunningLifecycleWorker("myproject");
    expect(pid).toBeNull();
  });

  it("returns null when ps fails", () => {
    mockExecFileSync.mockImplementationOnce(() => { throw new Error("ps failed"); });
    const pid = scanForRunningLifecycleWorker("myproject");
    expect(pid).toBeNull();
  });

  it("does not match a project whose name is a prefix of another", () => {
    mockExecFileSync.mockReturnValueOnce(
      Buffer.from("11111 node ao lifecycle-worker api-v2\n"),
    );
    const pid = scanForRunningLifecycleWorker("api");
    expect(pid).toBeNull();
  });
});

describe("ensureLifecycleWorker -- ps-scan fallback (orch-886k)", () => {
  it("does NOT spawn when scanForRunningLifecycleWorker finds a running worker (no PID file)", async () => {
    const cfg = mockConfig({ "test-proj": "/repos/test-proj" });
    setExists(pidFile("test-proj"), false);
    // ps -ww -o pid,args= format: "  PID command..." (no USER column, no header)
    mockExecFileSync.mockReturnValueOnce(
      Buffer.from("77777 node ao lifecycle-worker test-proj\n"),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockSpawn.mockReturnValueOnce({ pid: 88888, unref: () => {} } as any);
    const result = await ensureLifecycleWorker(cfg, "test-proj");
    expect(result.started).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
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
