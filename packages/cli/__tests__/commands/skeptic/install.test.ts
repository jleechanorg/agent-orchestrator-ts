/**
 * Unit tests for the skeptic install command.
 * Tests: repo detection, workflow install logic, and flag validation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectRepo } from "../../../src/commands/skeptic/install.js";

const mockExecFile = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

function callCb(
  args: unknown[],
  result: { stdout: string; stderr: string },
  err?: Error,
): void {
  const cb = args[args.length - 1] as (err: Error | null, r?: { stdout: string; stderr: string }) => void;
  void Promise.resolve().then(() => cb(err ?? null, err ? undefined : result));
}

describe("detectRepo", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("resolves owner/repo from gh repo view", async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      callCb(args, { stdout: JSON.stringify({ owner: { login: "myorg" }, name: "my-repo" }), stderr: "" });
    });

    const result = await detectRepo();
    expect(result).toEqual({ owner: "myorg", name: "my-repo" });
  });

  it("falls back to git remote for HTTPS URLs when gh unavailable", async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === "gh") {
        callCb(args, { stdout: "", stderr: "" }, new Error("gh not configured"));
      } else {
        callCb(args, { stdout: "https://github.com/foo/bar.git\n", stderr: "" });
      }
    });

    const result = await detectRepo();
    expect(result).toEqual({ owner: "foo", name: "bar" });
  });

  it("falls back to git remote for SSH URLs when gh unavailable", async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === "gh") {
        callCb(args, { stdout: "", stderr: "" }, new Error("gh not configured"));
      } else {
        callCb(args, { stdout: "git@github.com:owner/repo-name.git\n", stderr: "" });
      }
    });

    const result = await detectRepo();
    expect(result).toEqual({ owner: "owner", name: "repo-name" });
  });

  it("handles repo names with dots when gh unavailable", async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === "gh") {
        callCb(args, { stdout: "", stderr: "" }, new Error("gh not configured"));
      } else {
        callCb(args, { stdout: "git@github.com:my.org/my.repo.git\n", stderr: "" });
      }
    });

    const result = await detectRepo();
    expect(result).toEqual({ owner: "my.org", name: "my.repo" });
  });
});
