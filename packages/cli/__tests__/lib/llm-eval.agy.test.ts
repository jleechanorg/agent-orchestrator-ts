import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockAccessSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn(() => false));
const mockReadFileSync = vi.hoisted(() => vi.fn(() => ""));
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockRealpathSync = vi.hoisted(() => vi.fn((p: string) => p));

vi.mock("node:child_process", async () => {
  const original = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...original,
    execFileSync: mockExecFileSync,
  };
});

// Fully stub the new filesystem side effects of tryAgyPrint() (which reads
// and writes ~/.gemini/trustedFolders.json). Without these mocks the test
// would mutate the developer's real HOME config and depend on whatever is
// already present on disk. We also redirect HOME to a per-suite fixture
// directory so any real-fs fallback path is still isolated.
vi.mock("node:fs", async () => {
  const original = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...original,
    accessSync: mockAccessSync,
    constants: { ...original.constants, X_OK: 1 },
    mkdirSync: mockMkdirSync,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    realpathSync: mockRealpathSync,
  };
});

import { tryAgyPrint } from "../../src/lib/llm-eval.js";

const PASS_VERDICT = "VERDICT: PASS";
const SKIPPED_VERDICT = "VERDICT: SKIPPED";

const ORIGINAL_HOME = process.env["HOME"];
let FIXTURE_HOME = "";

beforeAll(() => {
  FIXTURE_HOME = mkdtempSync(join(tmpdir(), "llm-eval-agy-test-"));
  process.env["HOME"] = FIXTURE_HOME;
});

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL_HOME;
  if (FIXTURE_HOME) {
    try {
      rmSync(FIXTURE_HOME, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; do not fail the suite
    }
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFileSync.mockReset();
  mockAccessSync.mockReset();
  mockMkdirSync.mockReset();
  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
  mockWriteFileSync.mockReset();
  mockRealpathSync.mockReset();
  // Default fs: no existing trusted-folder file, all writes are no-ops on the
  // fixture dir (mocked). This prevents the test from touching the real
  // ~/.gemini/trustedFolders.json even if a fallback path is taken.
  mockExistsSync.mockImplementation(() => false);
  mockReadFileSync.mockImplementation(() => "");
  mockWriteFileSync.mockImplementation(() => undefined);
  mockMkdirSync.mockImplementation(() => undefined);
  mockRealpathSync.mockImplementation((p: string) => p);
  // Default: throw ENOENT for all calls (test overrides per-case as needed)
  mockExecFileSync.mockImplementation(() => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
  // accessSync: throw ENOENT for ALL candidates.
  mockAccessSync.mockImplementation((_path) => {
    const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
});

describe("tryAgyPrint", () => {
  const allowAgyCandidate = () => {
    mockAccessSync.mockImplementation((path: unknown) => {
      if (path === "/usr/local/bin/agy" || path === "agy") return undefined;
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
  };

  it("passes cwd: '/tmp' to execFileSync when running agy", async () => {
    const originalAgyBinary = process.env["AGY_BINARY"];
    process.env["AGY_BINARY"] = "/usr/local/bin/agy";
    try {
      allowAgyCandidate();
      mockExecFileSync.mockReturnValue(PASS_VERDICT);
      const result = await tryAgyPrint("evaluate this");
      expect(result.validVerdict).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "/usr/local/bin/agy",
        ["--dangerously-skip-permissions", "-p", ""],
        expect.objectContaining({
          input: "evaluate this",
          cwd: "/tmp",
          encoding: "utf-8",
        }),
      );
    } finally {
      if (originalAgyBinary === undefined) delete process.env["AGY_BINARY"];
      else process.env["AGY_BINARY"] = originalAgyBinary;
    }
  });

  it("returns validVerdict=false with error string when VERDICT is missing", async () => {
    const originalAgyBinary = process.env["AGY_BINARY"];
    process.env["AGY_BINARY"] = "/usr/local/bin/agy";
    try {
      allowAgyCandidate();
      mockExecFileSync.mockReturnValue("Here is my analysis...");
      const result = await tryAgyPrint("evaluate this");
      expect(result.validVerdict).toBe(false);
      expect(result.error).toContain("missing VERDICT line");
    } finally {
      if (originalAgyBinary === undefined) delete process.env["AGY_BINARY"];
      else process.env["AGY_BINARY"] = originalAgyBinary;
    }
  });

  it("returns error=undefined (try next) when binary is not found (ENOENT)", async () => {
    mockAccessSync.mockImplementation(() => {
      const err = new Error("ENOENT: not found") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const result = await tryAgyPrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toBeUndefined(); // signal: try next tool
  });

  it("returns validVerdict=false with error string when VERDICT is SKIPPED", async () => {
    const originalAgyBinary = process.env["AGY_BINARY"];
    process.env["AGY_BINARY"] = "/usr/local/bin/agy";
    try {
      allowAgyCandidate();
      mockExecFileSync.mockReturnValue(SKIPPED_VERDICT);
      const result = await tryAgyPrint("evaluate this");
      expect(result.validVerdict).toBe(false);
      expect(result.error).toContain("missing VERDICT");
    } finally {
      if (originalAgyBinary === undefined) delete process.env["AGY_BINARY"];
      else process.env["AGY_BINARY"] = originalAgyBinary;
    }
  });

  it("returns error=undefined (try next) for ETIMEDOUT (network timeout = unavailable)", async () => {
    const originalAgyBinary = process.env["AGY_BINARY"];
    process.env["AGY_BINARY"] = "/usr/local/bin/agy";
    try {
      allowAgyCandidate();
      const err = new Error("ETIMEDOUT") as NodeJS.ErrnoException;
      err.code = "ETIMEDOUT";
      mockExecFileSync.mockImplementation(() => {
        throw err;
      });
      const result = await tryAgyPrint("evaluate this");
      expect(result.validVerdict).toBe(false);
      expect(result.error).toBeUndefined(); // signal: try next tool
    } finally {
      if (originalAgyBinary === undefined) delete process.env["AGY_BINARY"];
      else process.env["AGY_BINARY"] = originalAgyBinary;
    }
  });

  it("returns error=undefined (stop) for 403 Forbidden / auth errors", async () => {
    const originalAgyBinary = process.env["AGY_BINARY"];
    process.env["AGY_BINARY"] = "/usr/local/bin/agy";
    try {
      allowAgyCandidate();
      const err = new Error("Forbidden (403)") as NodeJS.ErrnoException;
      mockExecFileSync.mockImplementation(() => {
        throw err;
      });
      const result = await tryAgyPrint("evaluate this");
      expect(result.validVerdict).toBe(false);
      expect(result.error).toBeUndefined();
    } finally {
      if (originalAgyBinary === undefined) delete process.env["AGY_BINARY"];
      else process.env["AGY_BINARY"] = originalAgyBinary;
    }
  });

  it("returns error message for other system errors", async () => {
    const originalAgyBinary = process.env["AGY_BINARY"];
    process.env["AGY_BINARY"] = "/usr/local/bin/agy";
    try {
      allowAgyCandidate();
      const err = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      mockExecFileSync.mockImplementation(() => {
        throw err;
      });
      const result = await tryAgyPrint("evaluate this");
      expect(result.validVerdict).toBe(false);
      expect(result.error).toBe("EPERM: operation not permitted");
    } finally {
      if (originalAgyBinary === undefined) delete process.env["AGY_BINARY"];
      else process.env["AGY_BINARY"] = originalAgyBinary;
    }
  });

  it("continues to next candidate if first candidate throws EPERM but second candidate succeeds", async () => {
    const originalAgyBinary = process.env["AGY_BINARY"];
    process.env["AGY_BINARY"] = "/usr/local/bin/agy";
    try {
      mockAccessSync.mockImplementation((path: unknown) => {
        if (path === "/usr/local/bin/agy" || path === "/opt/homebrew/bin/agy") return undefined;
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      });

      const eperm = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
      eperm.code = "EPERM";

      mockExecFileSync
        .mockImplementationOnce(() => {
          throw eperm;
        })
        .mockReturnValueOnce(PASS_VERDICT);

      const result = await tryAgyPrint("evaluate this");
      expect(result.validVerdict).toBe(true);
      expect(result.output).toBe(PASS_VERDICT);
      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    } finally {
      if (originalAgyBinary === undefined) delete process.env["AGY_BINARY"];
      else process.env["AGY_BINARY"] = originalAgyBinary;
    }
  });
});
