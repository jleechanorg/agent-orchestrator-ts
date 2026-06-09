import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockAccessSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const original = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...original,
    execFileSync: mockExecFileSync,
  };
});

vi.mock("node:fs", async () => {
  const original = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...original,
    accessSync: mockAccessSync,
    constants: { ...original.constants, X_OK: 1 },
  };
});

import { tryAgyPrint } from "../../src/lib/llm-eval.js";

const PASS_VERDICT = "VERDICT: PASS";
const SKIPPED_VERDICT = "VERDICT: SKIPPED";

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFileSync.mockReset();
  mockAccessSync.mockReset();
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
        ["--yolo", "-p", ""],
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
