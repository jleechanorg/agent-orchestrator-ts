import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

describe("start command — expandUserPath helper", () => {
  it("expandUserPath wrapper handles bare '~', '~/foo', '~\\foo', and other formats", async () => {
    const { expandUserPath } = await import("../../src/commands/start.js");
    
    // Bare "~" resolves to user's home directory
    expect(expandUserPath("~")).toBe(homedir());
    
    // POSIX path separators (expanded via join(homedir(), ...))
    expect(expandUserPath("~/foo")).toBe(join(homedir(), "foo"));
    expect(expandUserPath("~/a/b/c")).toBe(join(homedir(), "a/b/c"));
    
    // Windows path separators (expanded via join(homedir(), ...))
    expect(expandUserPath("~\\foo")).toBe(join(homedir(), "foo"));
    expect(expandUserPath("~\\a\\b\\c")).toBe(join(homedir(), "a\\b\\c"));
    
    // Absolute paths are unchanged
    expect(expandUserPath("/abs/foo")).toBe("/abs/foo");
    
    // Relative paths are unchanged
    expect(expandUserPath("foo/bar")).toBe("foo/bar");
    
    // ~user paths are unsupported and remain unchanged
    expect(expandUserPath("~user/foo")).toBe("~user/foo");
  });
});
