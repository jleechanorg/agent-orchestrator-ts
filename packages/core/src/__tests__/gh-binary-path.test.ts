import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { getGhBinaryPath } from "../gh-binary-path.js";
import { expandHome } from "../paths.js";

interface GlobalWithMock {
  __mockExistsSync?: (path: string) => boolean;
}

// Mock node:fs existsSync to allow dynamic testing of path resolution in ESM
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: string) => {
      const mock = (globalThis as unknown as GlobalWithMock).__mockExistsSync;
      if (typeof mock === "function") {
        return mock(path);
      }
      return actual.existsSync(path);
    },
  };
});

describe("GitHub Binary Path Resolution", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.AO_GH_PATH;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AO_GH_PATH;
    } else {
      process.env.AO_GH_PATH = originalEnv;
    }
    delete (globalThis as unknown as GlobalWithMock).__mockExistsSync;
  });

  it("resolves to AO_GH_PATH if set", () => {
    process.env.AO_GH_PATH = "/custom/path/to/gh";
    expect(getGhBinaryPath()).toBe("/custom/path/to/gh");
  });

  it("returns a string path by default", () => {
    delete process.env.AO_GH_PATH;
    const path = getGhBinaryPath();
    expect(typeof path).toBe("string");
    expect(path.length).toBeGreaterThan(0);
  });

  it("prioritizes commonPaths in order", () => {
    delete process.env.AO_GH_PATH;

    // Scenario 1: Only /usr/bin/gh exists
    (globalThis as unknown as GlobalWithMock).__mockExistsSync = (p: string) => p === "/usr/bin/gh";
    expect(getGhBinaryPath()).toBe("/usr/bin/gh");

    // Scenario 2: Both ~/.local/bin/gh and /usr/bin/gh exist -> should prefer ~/.local/bin/gh
    const localLocalPath = join(expandHome("~/.local/bin"), "gh");
    (globalThis as unknown as GlobalWithMock).__mockExistsSync = (p: string) =>
      p === localLocalPath || p === "/usr/bin/gh";
    expect(getGhBinaryPath()).toBe(localLocalPath);

    // Scenario 3: None exist -> should fall back to "gh"
    (globalThis as unknown as GlobalWithMock).__mockExistsSync = () => false;
    expect(getGhBinaryPath()).toBe("gh");
  });
});
