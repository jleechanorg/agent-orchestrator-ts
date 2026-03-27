/**
 * Unit tests for the skeptic install command.
 * Tests: repo detection, workflow install logic, and flag validation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mockExec = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/shell.js", () => ({
  exec: mockExec,
}));

// Import after mocks
const { detectRepo } = await import("../../../src/commands/skeptic/install.js");

describe("detectRepo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves owner/repo from gh repo view", async () => {
    mockExec.mockResolvedValueOnce({
      stdout: JSON.stringify({ owner: { login: "myorg" }, name: "my-repo" }),
      stderr: "",
    });

    const result = await detectRepo();
    expect(result).toEqual({ owner: "myorg", name: "my-repo" });
    expect(mockExec).toHaveBeenCalledWith("gh", ["repo", "view", "--json", "owner,name"]);
  });

  it("falls back to git remote for HTTPS URLs", async () => {
    mockExec
      .mockRejectedValueOnce(new Error("gh not configured")) // gh fails
      .mockResolvedValueOnce({ stdout: "https://github.com/foo/bar.git\n", stderr: "" });

    const result = await detectRepo();
    expect(result).toEqual({ owner: "foo", name: "bar" });
  });

  it("falls back to git remote for SSH URLs", async () => {
    mockExec
      .mockRejectedValueOnce(new Error("gh not configured"))
      .mockResolvedValueOnce({ stdout: "git@github.com:owner/repo-name.git\n", stderr: "" });

    const result = await detectRepo();
    expect(result).toEqual({ owner: "owner", name: "repo-name" });
  });

  it("handles repo names with dots (no .git suffix)", async () => {
    mockExec
      .mockRejectedValueOnce(new Error("gh not configured"))
      .mockResolvedValueOnce({ stdout: "git@github.com:my.org/my.repo.git\n", stderr: "" });

    const result = await detectRepo();
    expect(result).toEqual({ owner: "my.org", name: "my.repo" });
  });

  it("throws when no repo info available", async () => {
    mockExec
      .mockRejectedValueOnce(new Error("gh not configured"))
      .mockRejectedValueOnce(new Error("git not configured"));

    await expect(detectRepo()).rejects.toThrow("Could not detect repo");
  });
});
