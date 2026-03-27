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
const { fetchDesignDoc } = await import(
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
