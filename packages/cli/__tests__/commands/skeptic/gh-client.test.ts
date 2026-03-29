import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Hoisted before any imports or vi.mock calls
const mockExec = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/shell.js", () => ({
  exec: mockExec,
}));

// Import after mocks are defined
const { fetchDesignDoc, ghJsonPaginate, fetchIssueComments } = await import(
  "../../../src/commands/skeptic/gh-client.js"
);

describe("fetchDesignDoc", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skeptic-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("returns file content when the design doc exists", async () => {
    const prNum = 123;
    const docDir = join(tmp, "docs", "design", "pr-designs");
    mkdirSync(docDir, { recursive: true });
    const filePath = join(docDir, `pr-${prNum}.md`);
    const content = "# Design Doc for PR 123\nSome content here.";
    writeFileSync(filePath, content, "utf8");

    mockExec.mockResolvedValueOnce({ stdout: tmp + "\n", stderr: "" });

    const result = await fetchDesignDoc(prNum);

    expect(mockExec).toHaveBeenCalledWith("git", ["rev-parse", "--show-toplevel"]);
    expect(result).toBe(content);
  });

  it("returns null when the design doc file does not exist (ENOENT)", async () => {
    // Don't create the file — readFileSync will throw ENOENT
    mockExec.mockResolvedValueOnce({ stdout: tmp + "\n", stderr: "" });

    const result = await fetchDesignDoc(456);

    expect(result).toBe(null);
  });

  it("throws when git rev-parse fails (not a git repo)", async () => {
    mockExec.mockRejectedValueOnce(new Error("fatal: not a git repository"));

    await expect(fetchDesignDoc(789)).rejects.toThrow(
      "fatal: not a git repository"
    );
  });

  it("throws when readFileSync fails with a non-ENOENT error", async () => {
    // Create the file so the path resolves, but mock readFileSync to throw EACCES.
    // chmod 0o000 does not work as root (CI runs as root), so we mock the error directly.
    const docDir = join(tmp, "docs", "design", "pr-designs");
    mkdirSync(docDir, { recursive: true });
    writeFileSync(join(docDir, "pr-999.md"), "# doc\n", "utf8");

    mockExec.mockResolvedValueOnce({ stdout: tmp + "\n", stderr: "" });

    // Mock readFileSync to throw EACCES — this simulates a permission-denied error
    // without relying on chmod (which root bypasses on Linux).
    const eaccesErr = Object.assign(new Error("EACCES permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw eaccesErr;
    });

    await expect(fetchDesignDoc(999)).rejects.toThrow("EACCES permission denied");
    vi.mocked(fs.readFileSync).mockReset();
  });
});

describe("ghJsonPaginate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls gh api --paginate and returns parsed JSON for a single-page response", async () => {
    const mockData = { name: "Skeptic Gate", status: "completed" };
    mockExec.mockResolvedValueOnce({ stdout: JSON.stringify(mockData), stderr: "" });

    const result = await ghJsonPaginate("repos/owner/repo/pulls/123");

    expect(mockExec).toHaveBeenCalledOnce();
    const [cmd, args] = mockExec.mock.calls[0]!;
    expect(cmd).toBe("gh");
    expect(args).toContain("api");
    expect(args).toContain("--paginate");
    expect(args).toContain("repos/owner/repo/pulls/123");
    expect(result).toEqual(mockData);
  });

  it("passes additional args through to gh api", async () => {
    const mockData = [{ id: 1 }, { id: 2 }];
    mockExec.mockResolvedValueOnce({ stdout: JSON.stringify(mockData), stderr: "" });

    const result = await ghJsonPaginate("repos/owner/repo/issues/5/comments", [
      "--jq", ".[].body",
    ]);

    const [, args] = mockExec.mock.calls[0]!;
    expect(args).toContain("--jq");
    expect(args).toContain(".[].body");
    expect(result).toEqual(mockData);
  });

  it("rejects with a parse error when stdout is not valid JSON", async () => {
    mockExec.mockResolvedValueOnce({ stdout: "not json at all", stderr: "" });

    await expect(ghJsonPaginate("repos/owner/repo/pulls/1")).rejects.toThrow();
  });

  it("rejects when gh api fails", async () => {
    mockExec.mockRejectedValueOnce(new Error("gh api failed: not found"));

    await expect(ghJsonPaginate("repos/owner/repo/pulls/999")).rejects.toThrow(
      "gh api failed"
    );
  });

  it("returns null when gh api returns null JSON", async () => {
    mockExec.mockResolvedValueOnce({ stdout: "null", stderr: "" });

    const result = await ghJsonPaginate("repos/owner/repo/pulls/1");
    expect(result).toBeNull();
  });
});

describe("fetchIssueComments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls gh api --paginate --slurp for comments endpoint", async () => {
    mockExec.mockResolvedValueOnce({
      stdout: JSON.stringify([[{ id: 1, body: "hello", user: { login: "a" } }]]),
      stderr: "",
    });

    await fetchIssueComments("owner", "repo", 42);

    expect(mockExec).toHaveBeenCalledOnce();
    const [, args] = mockExec.mock.calls[0]!;
    expect(args).toContain("--paginate");
    expect(args).toContain("repos/owner/repo/issues/42/comments");
  });

  // bd-ryw2: ghJsonPaginate returns pages as separate array elements (--slurp).
  // Without .flat(), iterating the outer array never reaches comments on page 2+.
  // This test verifies that multi-page results are properly flattened.
  it("flattens paginated pages so all comments from all pages are returned", async () => {
    const page1 = [
      { id: 1, body: "page1 comment", user: { login: "alice" } },
    ];
    const page2 = [
      { id: 101, body: "skeptic verdict on page 2", user: { login: "jleechan2015" } },
      { id: 102, body: "page2 comment", user: { login: "bob" } },
    ];
    mockExec.mockResolvedValueOnce({
      stdout: JSON.stringify([page1, page2]),
      stderr: "",
    });

    const result = await fetchIssueComments("owner", "repo", 5);

    expect(result).toHaveLength(3);
    expect(result.find((c) => c.id === 1)?.body).toBe("page1 comment");
    expect(result.find((c) => c.id === 101)?.body).toBe("skeptic verdict on page 2");
    expect(result.find((c) => c.id === 102)?.body).toBe("page2 comment");
  });

  it("returns empty array when gh api returns empty pages", async () => {
    mockExec.mockResolvedValueOnce({
      stdout: JSON.stringify([[], []]),
      stderr: "",
    });

    const result = await fetchIssueComments("owner", "repo", 7);
    expect(result).toEqual([]);
  });

  it("returns empty array when gh api returns empty pages", async () => {
    mockExec.mockResolvedValueOnce({
      stdout: JSON.stringify([[]]),
      stderr: "",
    });

    const result = await fetchIssueComments("owner", "repo", 9);
    expect(result).toEqual([]);
  });
});
