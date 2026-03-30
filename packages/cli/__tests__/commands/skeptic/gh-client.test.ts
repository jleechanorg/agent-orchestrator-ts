import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Use a mutable object so vi.mock factories (which are hoisted) can write to it.
// vi.hoisted creates const bindings — only the object's properties are mutable.
const refs = vi.hoisted(() => ({
  realFetchDesignDoc: null as (prNumber: number) => Promise<string | null>,
  realGhJsonPaginate: null as (endpoint: string, args?: string[]) => Promise<unknown>,
  realFetchIssueComments:
    null as (owner: string, repo: string, prNumber: number) => Promise<unknown[]>,
  realReadFileSync: null as ((
    path: Parameters<typeof import("node:fs")["readFileSync"]>[0],
    ...args: unknown[]
  ) => string),
}));

const mockExec = vi.hoisted(() => vi.fn());

// vi.mock factory is async — vitest awaits it before the module import completes,
// so the real functions are resolved and assigned to the refs object before the mock
// is installed. This sidesteps the ESM TDZ problem entirely.
vi.mock("../../../src/commands/skeptic/gh-client.js", async () => {
  const mod = await import("../../../src/commands/skeptic/gh-client.js");
  refs.realFetchDesignDoc = mod.fetchDesignDoc;
  refs.realGhJsonPaginate = mod.ghJsonPaginate;
  refs.realFetchIssueComments = mod.fetchIssueComments;
  return {
    fetchDesignDoc: vi.fn((...args: unknown[]) => refs.realFetchDesignDoc(...(args as [number]))),
    ghJsonPaginate: vi.fn((...args: unknown[]) =>
      refs.realGhJsonPaginate(...(args as [string, string[]?])),
    ),
    fetchIssueComments: vi.fn((...args: unknown[]) =>
      refs.realFetchIssueComments(...(args as [string, string, number])),
    ),
  };
});

vi.mock("node:fs", async () => {
  const fs = await import("node:fs");
  refs.realReadFileSync = fs.readFileSync;
  return {
    ...fs,
    readFileSync: vi.fn((...args: Parameters<typeof fs.readFileSync>) =>
      refs.realReadFileSync(...args),
    ),
  };
});

vi.mock("../../../src/lib/shell.js", () => ({
  exec: mockExec,
}));

// Import after mocks are defined — at this point the async vi.mock factory has run.
const { fetchDesignDoc, ghJsonPaginate, fetchIssueComments } = await import(
  "../../../src/commands/skeptic/gh-client.js"
);
const { readFileSync } = await import("node:fs");

describe("fetchDesignDoc", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skeptic-test-"));
    // Reset mock call history but NOT the implementation (restored below).
    // Note: mockReset() clears the mock implementation, so restore it immediately after.
    vi.mocked(fetchDesignDoc).mockReset();
    vi.mocked(readFileSync).mockReset();
    mockExec.mockReset();
    // Restore fetchDesignDoc and readFileSync to call their real implementations.
    vi.mocked(fetchDesignDoc).mockImplementation(
      (...args: unknown[]) => refs.realFetchDesignDoc(...(args as [number])),
    );
    vi.mocked(readFileSync).mockImplementation(
      (...args: Parameters<typeof import("node:fs")["readFileSync"]>) =>
        refs.realReadFileSync(...(args as [Parameters<typeof import("node:fs")["readFileSync"]>[0], ...unknown[]])),
    );
    // Clear call history after restoring implementations.
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    // Restore fetchDesignDoc's and readFileSync's real implementation so subsequent tests aren't
    // affected by per-test mock overrides (e.g. EACCES injection).
    vi.mocked(fetchDesignDoc).mockReset();
    vi.mocked(readFileSync).mockReset();
  });

  it("returns file content when the design doc exists", async () => {
    const prNum = 123;
    const docDir = join(tmp, "docs", "design", "pr-designs");
    mkdirSync(docDir, { recursive: true });
    const filePath = join(docDir, "pr-" + prNum + ".md");
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

    await expect(fetchDesignDoc(789)).rejects.toThrow("fatal: not a git repository");
  });

  it("throws when readFileSync fails with a non-ENOENT error", async () => {
    // chmod 0o000 does not work as root (CI runs as root).
    // Mock exec to return a valid repo root so readFileSync is the next call to fail.
    mockExec.mockResolvedValueOnce({ stdout: tmp + "\n", stderr: "" });
    // Mock readFileSync directly to simulate EACCES so the real fetchDesignDoc code path runs.
    vi.mocked(readFileSync).mockImplementation(
      (..._args: Parameters<typeof import("node:fs")["readFileSync"]>) => {
        const eaccesErr = Object.assign(new Error("EACCES permission denied"), { code: "EACCES" });
        throw eaccesErr;
      },
    );

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
      "--jq",
      ".[].body",
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

    await expect(ghJsonPaginate("repos/owner/repo/pulls/999")).rejects.toThrow("gh api failed");
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
    const page1 = [{ id: 1, body: "page1 comment", user: { login: "alice" } }];
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
