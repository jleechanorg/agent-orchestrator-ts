import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock shell.js before importing gh-client
const execMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/shell.js", () => ({
  exec: execMock,
}));

import { fetchTestFileContents } from "../../commands/skeptic/gh-client.js";

describe("fetchTestFileContents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts test files from ---/+++ diff format", async () => {
    execMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ content: Buffer.from("describe('foo', () => {});").toString("base64"), encoding: "base64" }),
    });
    const diff = `--- a/src/foo.test.ts
+++ b/src/foo.test.ts
@@ -1,3 +1,4 @@
+new line`;

    const results = await fetchTestFileContents("owner", "repo", 123, diff);
    expect(results.has("src/foo.test.ts")).toBe(true);
    expect(results.get("src/foo.test.ts")).toBe("describe('foo', () => {});");
  });

  it("filters out non-test files", async () => {
    const diff = `--- a/src/main.ts
+++ b/src/main.ts
--- a/src/utils.ts
+++ b/src/utils.ts`;

    const results = await fetchTestFileContents("owner", "repo", 123, diff);
    expect(results.size).toBe(0);
  });

  it("falls back to gh pr diff --name-only when no test files in diff", async () => {
    // ghJson for empty diff: returns empty results
    execMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ content: "", encoding: "base64" }),
    });
    // gh pr diff --name-only fallback
    execMock.mockResolvedValueOnce({
      stdout: "src/foo.test.ts\n",
    });
    // ghJson for file content fetch
    execMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ content: Buffer.from("test() {}").toString("base64"), encoding: "base64" }),
    });

    const diff = `--- a/src/main.ts
+++ b/src/main.ts`;

    const results = await fetchTestFileContents("owner", "repo", 123, diff);
    expect(results.has("src/foo.test.ts")).toBe(true);
  });

  it("returns empty Map when no test files exist anywhere", async () => {
    execMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ content: "", encoding: "base64" }),
    });
    execMock.mockResolvedValueOnce({
      stdout: "src/main.ts\nsrc/utils.ts\n",
    });

    const diff = `--- a/src/main.ts
+++ b/src/main.ts`;

    const results = await fetchTestFileContents("owner", "repo", 123, diff);
    expect(results.size).toBe(0);
  });

  it("degrades gracefully when gh fallback exec fails", async () => {
    execMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ content: "", encoding: "base64" }),
    });
    execMock.mockRejectedValueOnce(new Error("gh not available"));

    const diff = `--- a/src/main.ts
+++ b/src/main.ts`;

    const results = await fetchTestFileContents("owner", "repo", 123, diff);
    expect(results.size).toBe(0);
  });

  it("uses ref parameter in API requests when provided", async () => {
    let capturedArgs: string[] = [];
    execMock.mockImplementation(async (_cmd: string, args: string[]) => {
      capturedArgs = args;
      return { stdout: JSON.stringify({ content: Buffer.from("test").toString("base64"), encoding: "base64" }) };
    });

    await fetchTestFileContents(
      "owner",
      "repo",
      123,
      "--- a/src/foo.test.ts\n+++ b/src/foo.test.ts",
      "feature-branch",
    );
    expect(capturedArgs.some((a) => a.includes("ref=feature-branch"))).toBe(true);
  });
});
