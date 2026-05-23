import { describe, it, expect } from "vitest";
import {
  deriveDisplayName,
  DISPLAY_NAME_MAX_LENGTH,
  MARKDOWN_HEADING_RE,
} from "../upstream-session-header.js";

describe("deriveDisplayName", () => {
  it("returns undefined when no input is provided", () => {
    expect(deriveDisplayName({})).toBeUndefined();
  });

  it("returns undefined when both fields are empty", () => {
    expect(deriveDisplayName({ issueTitle: "", prompt: "" })).toBeUndefined();
  });

  it("returns undefined when both fields are whitespace-only", () => {
    expect(deriveDisplayName({ issueTitle: "   ", prompt: "\t\n" })).toBeUndefined();
  });

  it("prefers issueTitle over prompt", () => {
    const result = deriveDisplayName({
      issueTitle: "Fix login bug",
      prompt: "Something else entirely",
    });
    expect(result).toBe("Fix login bug");
  });

  it("uses prompt when issueTitle is absent", () => {
    const result = deriveDisplayName({
      prompt: "Add rate limiting to /api/upload",
    });
    expect(result).toBe("Add rate limiting to /api/upload");
  });

  it("picks the first non-empty line from prompt", () => {
    const result = deriveDisplayName({
      prompt: "\n\nAdd rate limiting\n\nUse sliding-window counter.",
    });
    expect(result).toBe("Add rate limiting");
  });

  it("strips markdown heading markers from prompt-derived name", () => {
    const result = deriveDisplayName({
      prompt: "### Add rate limiting to /api/upload\n\nUse a sliding-window counter.",
    });
    expect(result).toBe("Add rate limiting to /api/upload");
  });

  it("strips h1 heading marker", () => {
    const result = deriveDisplayName({
      prompt: "# Top-level heading\n\nBody text here.",
    });
    expect(result).toBe("Top-level heading");
  });

  it("strips h6 heading marker", () => {
    const result = deriveDisplayName({
      prompt: "###### Deep heading\n\nBody text here.",
    });
    expect(result).toBe("Deep heading");
  });

  it("does not strip hash that is not a heading marker", () => {
    const result = deriveDisplayName({
      prompt: "#123 is an issue number",
    });
    expect(result).toBe("#123 is an issue number");
  });

  it("collapses whitespace and trims", () => {
    const result = deriveDisplayName({
      prompt: "  Fix   the   login   bug  ",
    });
    expect(result).toBe("Fix the login bug");
  });

  it("truncates long names with ellipsis", () => {
    const longTitle = "A".repeat(200);
    const result = deriveDisplayName({ issueTitle: longTitle });
    expect(result!.length).toBeLessThanOrEqual(DISPLAY_NAME_MAX_LENGTH);
    expect(result!.endsWith("…")).toBe(true);
  });

  it("truncates at code point boundaries (no lone surrogates)", () => {
    const titleWithEmoji = "Fix 🐛 in production — urgent fix needed right now for the login flow that is very very long and goes past eighty characters total";
    const result = deriveDisplayName({ issueTitle: titleWithEmoji });
    expect(result!.endsWith("…")).toBe(true);
    const codePoints = Array.from(result!);
    expect(codePoints.length).toBeLessThanOrEqual(DISPLAY_NAME_MAX_LENGTH);
  });

  it("does not strip heading markers from issueTitle", () => {
    const result = deriveDisplayName({
      issueTitle: "### Feature request",
    });
    expect(result).toBe("### Feature request");
  });

  it("exports the correct DISPLAY_NAME_MAX_LENGTH", () => {
    expect(DISPLAY_NAME_MAX_LENGTH).toBe(80);
  });

  it("MARKDOWN_HEADING_RE matches heading markers", () => {
    expect(MARKDOWN_HEADING_RE.test("# heading")).toBe(true);
    expect(MARKDOWN_HEADING_RE.test("## heading")).toBe(true);
    expect(MARKDOWN_HEADING_RE.test("###### heading")).toBe(true);
    expect(MARKDOWN_HEADING_RE.test("####### heading")).toBe(false);
    expect(MARKDOWN_HEADING_RE.test("#no-space")).toBe(false);
    expect(MARKDOWN_HEADING_RE.test("plain text")).toBe(false);
  });
});
