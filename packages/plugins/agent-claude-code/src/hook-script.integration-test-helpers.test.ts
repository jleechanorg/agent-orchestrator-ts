import { describe, expect, it, vi } from "vitest";
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
});
