import { describe, it, expect } from "vitest";
// Unit-test safePath by exercising it through dispatchTool scan/fix (the public interface).
// safePath itself is not exported, so we test via behavior: invalid paths produce errors.
import { dispatchTool } from "../src/mcp-tools.js";

describe("safePath path-traversal guard", () => {
  // All tool handlers call safePath internally; we trigger them with dummy paths
  // to exercise the guard. We don't need real files — safePath rejects before reading.

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
    // "chapter..1.md" is a single segment — no segment equals ".." exactly
    const result = dispatchTool("prose_polish_scan", {
      file_path: "/tmp/chapter..1.md",
    });
    // Should not be rejected by safePath; may fail for other reasons (file not found)
    // but must NOT fail with the safePath error
    if (!result.success) {
      expect(result.error).not.toContain("Invalid file path");
    }
  });

  it("allows absolute path without traversal", () => {
    const result = dispatchTool("prose_polish_scan", {
      file_path: "/tmp/readme.md",
    });
    // safePath allows it; file read may fail, but safePath guard passed
    if (!result.success) {
      expect(result.error).not.toContain("Invalid file path");
    }
  });

  it("rejects absolute path with embedded traversal: /tmp/../etc/passwd", () => {
    const result = dispatchTool("prose_polish_scan", {
      file_path: "/tmp/../etc/passwd",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid file path");
  });
});
