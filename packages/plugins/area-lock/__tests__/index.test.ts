import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CheckResult, LockEntry } from "../src/index.js";

// Mock child_process so tests don't need the real CLI
const mockExecFile = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => {
    const cb = args[args.length - 1] as (...a: unknown[]) => void;
    return mockExecFile(...args, cb);
  },
}));

function mockCliResponse(stdout: string) {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
    cb(null, { stdout, stderr: "" });
  });
}

describe("area-lock plugin", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("exports manifest with correct slot", async () => {
    const mod = await import("../src/index.js");
    expect(mod.manifest.slot).toBe("lock");
    expect(mod.manifest.name).toBe("area-lock");
  });

  it("create() returns an AreaLock with reserve/release/check", async () => {
    const mod = await import("../src/index.js");
    const lock = mod.default.create({ projectRoot: "/tmp/test" });
    expect(lock).toHaveProperty("reserve");
    expect(lock).toHaveProperty("release");
    expect(lock).toHaveProperty("check");
  });

  it("reserve() calls domain_lock CLI with correct args", async () => {
    const entries: LockEntry[] = [
      { domain: "core", pr_number: 42, agent: "test", branch: "feat/x", timestamp: "2026-05-20" },
    ];
    mockCliResponse(JSON.stringify(entries));

    const mod = await import("../src/index.js");
    const lock = mod.default.create({ projectRoot: "/tmp/test" });
    const result = await lock.reserve(42, ["src/core.ts"], "test", "feat/x");

    expect(result).toEqual(entries);
    expect(mockExecFile).toHaveBeenCalled();
    const callArgs = mockExecFile.mock.calls[0][1] as string[];
    expect(callArgs[0]).toBe("reserve");
    expect(callArgs).toContain("--pr");
    expect(callArgs).toContain("42");
  });

  it("release() calls domain_lock CLI with pr number", async () => {
    const entries: LockEntry[] = [
      { domain: "core", pr_number: 42, agent: "test", branch: "feat/x", timestamp: "2026-05-20" },
    ];
    mockCliResponse(JSON.stringify(entries));

    const mod = await import("../src/index.js");
    const lock = mod.default.create({ projectRoot: "/tmp/test" });
    const result = await lock.release(42);

    expect(result).toEqual(entries);
    const callArgs = mockExecFile.mock.calls[0][1] as string[];
    expect(callArgs[0]).toBe("release");
  });

  it("check() returns held status when domain is locked", async () => {
    const checkResult: CheckResult = {
      status: "held",
      held_by: [{ domain: "core", pr_number: 99, agent: "other", branch: "feat/y", timestamp: "2026-05-20" }],
    };
    mockCliResponse(JSON.stringify(checkResult));

    const mod = await import("../src/index.js");
    const lock = mod.default.create({ projectRoot: "/tmp/test" });
    const result = await lock.check(["src/core.ts"]);

    expect(result.status).toBe("held");
    expect(result.held_by).toHaveLength(1);
  });

  it("check() returns free status when no conflicts", async () => {
    const checkResult: CheckResult = { status: "free", held_by: [] };
    mockCliResponse(JSON.stringify(checkResult));

    const mod = await import("../src/index.js");
    const lock = mod.default.create({ projectRoot: "/tmp/test" });
    const result = await lock.check(["src/unlocked.ts"]);

    expect(result.status).toBe("free");
  });

  it("passes registryPath to CLI when configured", async () => {
    mockCliResponse(JSON.stringify({ status: "free", held_by: [] }));

    const mod = await import("../src/index.js");
    const lock = mod.default.create({
      projectRoot: "/tmp/test",
      registryPath: "/custom/file_domains.yaml",
    });
    await lock.check(["src/foo.ts"]);

    const callArgs = mockExecFile.mock.calls[0][1] as string[];
    expect(callArgs).toContain("--registry");
    expect(callArgs).toContain("/custom/file_domains.yaml");
  });

  it("defaults registryPath to projectRoot/file_domains.yaml", async () => {
    mockCliResponse(JSON.stringify({ status: "free", held_by: [] }));

    const mod = await import("../src/index.js");
    const lock = mod.default.create({ projectRoot: "/tmp/test" });
    await lock.check(["src/foo.ts"]);

    const callArgs = mockExecFile.mock.calls[0][1] as string[];
    expect(callArgs).toContain("--registry");
    expect(callArgs).toContain("/tmp/test/file_domains.yaml");
  });

  it("throws descriptive error on invalid JSON from CLI", async () => {
    mockCliResponse("not json");

    const mod = await import("../src/index.js");
    const lock = mod.default.create({ projectRoot: "/tmp/test" });
    await expect(lock.check(["src/foo.ts"])).rejects.toThrow(
      "domain_lock check returned invalid JSON",
    );
  });

  it("uses runtimeProjectRoot override for cwd", async () => {
    mockCliResponse(JSON.stringify({ status: "free", held_by: [] }));

    const mod = await import("../src/index.js");
    const lock = mod.default.create({ projectRoot: "/tmp/test" });
    await lock.check(["src/foo.ts"], "/override/workspace");

    const callOpts = mockExecFile.mock.calls[0][2] as Record<string, unknown>;
    expect(callOpts.cwd).toBe("/override/workspace");
  });
});
