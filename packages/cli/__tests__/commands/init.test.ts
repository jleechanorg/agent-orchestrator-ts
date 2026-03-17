import { describe, it, expect, vi } from "vitest";

import { Command } from "commander";
import { registerInit } from "../../src/commands/init.js";

describe("init command", () => {
  it("registers as a deprecated command", () => {
    const program = new Command();
    registerInit(program);

    const initCmd = program.commands.find((c) => c.name() === "init");
    expect(initCmd).toBeDefined();
    expect(initCmd!.description()).toContain("deprecated");
  });

  it("prints deprecation warning and delegates to createConfigOnly", async () => {
    // Mock the dynamic import of start.js
    const mockCreateConfigOnly = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../../src/commands/start.js", () => ({
      createConfigOnly: mockCreateConfigOnly,
    }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerInit(program);

    await program.parseAsync(["node", "test", "init"]);

    // Should print deprecation warning
    const logCalls = logSpy.mock.calls.map((args) => args.join(" "));
    const hasDeprecationWarning = logCalls.some((msg) => msg.includes("deprecated"));
    expect(hasDeprecationWarning).toBe(true);

    logSpy.mockRestore();
    vi.doUnmock("../../src/commands/start.js");
  });

  it("has no --output, --auto, or --smart flags", () => {
    const program = new Command();
    registerInit(program);

    const initCmd = program.commands.find((c) => c.name() === "init");
    expect(initCmd).toBeDefined();

    const optionNames = initCmd!.options.map((o) => o.long);
    expect(optionNames).not.toContain("--output");
    expect(optionNames).not.toContain("--auto");
    expect(optionNames).not.toContain("--smart");
  });
});
