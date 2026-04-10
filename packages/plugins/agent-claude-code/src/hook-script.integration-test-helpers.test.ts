import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { symlinkAvailableCommands } from "./hook-script.integration-test-helpers.js";

describe("symlinkAvailableCommands", () => {
  it("skips missing commands without failing the harness setup", () => {
    const lookupCommand = vi.fn((command: string) => {
      if (command === "cat") {
        return "/bin/cat";
      }
      throw new Error(`${command} missing`);
    });
    const symlink = vi.fn();

    expect(() => symlinkAvailableCommands(["cat", "jq"], "/tmp/no-python-bin", { lookupCommand, symlink })).not.toThrow();
    expect(lookupCommand).toHaveBeenCalledTimes(2);
    expect(symlink).toHaveBeenCalledTimes(1);
    expect(symlink).toHaveBeenCalledWith("/bin/cat", "/tmp/no-python-bin/cat");
  });

  it("uses PATH lookup for the default resolver without shell interpolation", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ao-hook-helper-path-"));
    const fakeCat = join(tempDir, "cat");
    const symlink = vi.fn();
    const originalPath = process.env.PATH;

    try {
      writeFileSync(fakeCat, "#!/bin/sh\nexit 0\n");
      chmodSync(fakeCat, 0o755);
      process.env.PATH = tempDir;

      symlinkAvailableCommands(["cat"], "/tmp/no-python-bin", { symlink });

      expect(symlink).toHaveBeenCalledTimes(1);
      expect(symlink).toHaveBeenCalledWith(fakeCat, "/tmp/no-python-bin/cat");
    } finally {
      process.env.PATH = originalPath;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
