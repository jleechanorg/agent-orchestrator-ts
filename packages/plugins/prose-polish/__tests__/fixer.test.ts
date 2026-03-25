import { describe, it, expect } from "vitest";
import { fixLine } from "../src/fixer.js";

describe("fixLine", () => {
  it("preserves leading whitespace", () => {
    const result = fixLine("  just a note");
    expect(result).toBe("  a note");
  });

  it("preserves Markdown hard-break suffix (trailing 2+ spaces)", () => {
    const result = fixLine("Hello world  ");
    expect(result).toBe("Hello world  ");
  });

  it("preserves both leading whitespace and trailing hard-break", () => {
    const result = fixLine("  Hello world  ");
    expect(result).toBe("  Hello world  ");
  });

  it("does not destroy trailing hard-break when filler is removed", () => {
    // The filler "just" is adjacent to trailing hard-break; trailing suffix must survive
    const result = fixLine("Hello just world  ");
    expect(result).toBe("Hello world  ");
  });

  it("removes filler word from middle of line", () => {
    const result = fixLine("This is simply great");
    expect(result).toBe("This is great");
  });

  it("collapses internal whitespace but preserves hard-break", () => {
    // Multiple trailing spaces = hard-break; collapse should not touch them
    const result = fixLine("Text    here  ");
    expect(result).toBe("Text here  ");
  });
});
