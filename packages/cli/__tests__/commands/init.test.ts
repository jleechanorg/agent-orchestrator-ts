import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Command } from "commander";
import { registerInit } from "../../src/commands/init.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("init command", () => {
  it("rejects when config file already exists", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ao-init-test-"));
    const outputPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(outputPath, "existing: true\n");

    const program = new Command();
    program.exitOverride();
    registerInit(program);

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    await expect(
      program.parseAsync(["node", "test", "init", "--output", outputPath]),
    ).rejects.toThrow("process.exit(1)");

    // Original file should be untouched
    expect(existsSync(outputPath)).toBe(true);
  });
});
