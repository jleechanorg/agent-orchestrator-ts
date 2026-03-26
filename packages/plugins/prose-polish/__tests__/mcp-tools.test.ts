import { describe, it, expect, vi, beforeEach } from "vitest";
// Unit-test safePath by exercising it through dispatchTool scan/fix (the public interface).
// safePath itself is not exported, so we test via behavior: invalid paths produce errors.
import { dispatchTool } from "../src/mcp-tools.js";

// ---- Mock filesystem so file-read errors don't mask safePath validation ----
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => "# Sample markdown content\n"),
  writeFileSync: vi.fn(),
}));

describe("safePath path-traversal guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // All tool handlers call safePath internally; we trigger them with dummy paths
  // to exercise the guard. safePath rejects before reading, so real files aren't needed
  // for path-rejection tests.

  it("rejects plain traversal: ..", () => {
    const result = dispatchTool("prose_polish_scan", { file_path: ".." });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid file path");
  });

  it("rejects relative traversal: ../etc/passwd", () => {
    const result = dispatchTool("prose_polish_scan", { file_path: "../etc/passwd" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid file path");
  });

  it("rejects multi-segment traversal: a/b/../../etc/passwd", () => {
    const result = dispatchTool("prose_polish_scan", {
      file_path: "a/b/../../etc/passwd",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid file path");
  });

  it("rejects backslash traversal: a\\b\\..\\etc", () => {
    const result = dispatchTool("prose_polish_scan", {
      file_path: "a\\b\\..\\etc",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid file path");
  });

  it("allows legitimate name containing '..' segment: chapter..1.md", () => {
    // "chapter..1.md" is a single segment — no segment equals ".." exactly,
    // so safePath must accept it (mocked fs means the read succeeds).
    const result = dispatchTool("prose_polish_scan", {
      file_path: "/tmp/chapter..1.md",
    });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("allows absolute path without traversal", () => {
    const result = dispatchTool("prose_polish_scan", {
      file_path: "/tmp/readme.md",
    });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("rejects absolute path with embedded traversal: /tmp/../etc/passwd", () => {
    const result = dispatchTool("prose_polish_scan", {
      file_path: "/tmp/../etc/passwd",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid file path");
  });
});
