import { describe, it, expect, vi, beforeEach } from "vitest";

const execMock = vi.hoisted(() => {
  const fn = vi.fn<(cmd: string, args: string[]) => Promise<{ stdout: string }>>();
  return fn;
});

vi.mock("../../lib/shell.js", () => ({
  exec: execMock,
}));

import { fetchTestFileContents } from "../../commands/skeptic/gh-client.js";

describe("fetchTestFileContents", () => {
  beforeEach(() => {
    execMock.mockReset();
    execMock.mockImplementation(async (cmd: string, _args: string[]) => {
      if (cmd === "gh" && _args[0] === "api") {
        return { stdout: JSON.stringify({ content: "", encoding: "base64" }) };
      }
      if (cmd === "gh" && _args[0] === "pr" && _args[1] === "diff" && _args[2] === "--name-only") {
        return { stdout: "" };
      }
      return { stdout: "" };
    });
  });

  it("returns empty Map when diff has no test files and gh fallback returns nothing", async () => {
    const results = await fetchTestFileContents("owner", "repo", 123, "--- a/src/main.ts\n+++ b/src/main.ts");
    expect(results.size).toBe(0);
  });

  it("does not crash on valid diff input", async () => {
    const results = await fetchTestFileContents(
      "owner",
      "repo",
      123,
      "diff --git a/src/foo.test.ts b/src/foo.test.ts\n--- a/src/foo.test.ts\n+++ b/src/foo.test.ts",
    );
    expect(results.size).toBe(0);
  });

  it("returns empty Map when only non-test files are in gh pr diff fallback", async () => {
    execMock.mockImplementation(async (cmd: string, _args: string[]) => {
      if (cmd === "gh" && _args[0] === "api") {
        return { stdout: JSON.stringify({ content: "", encoding: "base64" }) };
      }
      if (cmd === "gh" && _args[0] === "pr" && _args[1] === "diff" && _args[2] === "--name-only") {
        return { stdout: "src/main.ts\nsrc/utils.ts\n" };
      }
      return { stdout: "" };
    });
    const results = await fetchTestFileContents("owner", "repo", 123, "--- a/src/main.ts\n+++ b/src/main.ts");
    expect(results.size).toBe(0);
  });

  it("calls gh pr diff --name-only when diff yields no test paths", async () => {
    await fetchTestFileContents("owner", "repo", 123, "--- a/src/main.ts\n+++ b/src/main.ts");
    expect(execMock).toHaveBeenCalledWith("gh", ["pr", "diff", "--name-only", "--repo", "owner/repo", "123"]);
  });
});
