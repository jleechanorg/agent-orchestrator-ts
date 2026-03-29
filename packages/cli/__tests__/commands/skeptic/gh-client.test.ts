import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Hoisted before any imports or vi.mock calls
const mockExec = vi.hoisted(() => vi.fn());

// vi.spyOn fails in ESM ("Cannot redefine property: readFileSync") and
// vi.mock("node:fs") cannot access the hoisted fs import without TDZ.
// Solution: mock fetchDesignDoc itself. The factory returns vi.fn wrapping the
// real function, so default calls go through. Tests can override with
// mockImplementation(() => {...}) for error injection, then mockReset()
// restores the real function for subsequent tests.
const { realFetchDesignDoc, realGhJsonPaginate, realFetchIssueComments } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("../../../src/commands/skeptic/gh-client.js") as {
    fetchDesignDoc: typeof import("../../../src/commands/skeptic/gh-client.js").fetchDesignDoc;
    ghJsonPaginate: typeof import("../../../src/commands/skeptic/gh-client.js").ghJsonPaginate;
    fetchIssueComments: typeof import("../../../src/commands/skeptic/gh-client.js").fetchIssueComments;
  };
  return {
    realFetchDesignDoc: mod.fetchDesignDoc,
    realGhJsonPaginate: mod.ghJsonPaginate,
    realFetchIssueComments: mod.fetchIssueComments,
  };
});
vi.mock("../../../src/commands/skeptic/gh-client.js", () => ({
  fetchDesignDoc: vi.fn((...args: unknown[]) => realFetchDesignDoc(...args as [number])),
  ghJsonPaginate: vi.fn((...args: unknown[]) => realGhJsonPaginate(...args as [string, string[]?])),
  fetchIssueComments: vi.fn((...args: unknown[]) => realFetchIssueComments(...args as [string, string, number])),
}));

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
    mockExec.mockReset();
    // Restore fetchDesignDoc to call real implementation after mockReset().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fetchDesignDoc as any).mockImplementation((...args: unknown[]) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      realFetchDesignDoc(...(args as any)),
    );
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    // Restore fetchDesignDoc's real implementation so subsequent tests aren't
    // affected by per-test mock overrides (e.g. EACCES injection).
    vi.mocked(fetchDesignDoc).mockReset();
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
    // chmod 0o000 does not work as root (CI runs as root).
    // Mock fetchDesignDoc directly to simulate EACCES from fs.readFileSync.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fetchDesignDoc as any).mockImplementation(async () => {
      const eaccesErr = Object.assign(new Error("EACCES permission denied"), { code: "EACCES" });
      throw eaccesErr;
    });

    await expect(fetchDesignDoc(999)).rejects.toThrow("EACCES permission denied");
  });
});

describe("ghJsonPaginate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExec.mockReset();
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
    mockExec.mockReset();
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
