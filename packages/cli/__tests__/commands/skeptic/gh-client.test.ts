import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Hoisted before any imports or vi.mock calls
const mockExec = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/shell.js", () => ({
  exec: mockExec,
}));

// Import after mocks are defined
const { fetchDesignDoc, ghJsonPaginate } = await import(
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
    // Create the file and make it unreadable (EACCES)
    const docDir = join(tmp, "docs", "design", "pr-designs");
    mkdirSync(docDir, { recursive: true });
    const filePath = join(docDir, "pr-999.md");
    writeFileSync(filePath, "# doc\n", "utf8");
    chmodSync(filePath, 0o000); // unreadable

    mockExec.mockResolvedValueOnce({ stdout: tmp + "\n", stderr: "" });

    try {
      await expect(fetchDesignDoc(999)).rejects.toThrow();
    } finally {
      // Restore permissions so rmSync can clean up
      chmodSync(filePath, 0o644);
    }
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
