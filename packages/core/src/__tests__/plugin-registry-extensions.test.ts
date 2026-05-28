import { describe, it, expect, vi } from "vitest";
import { applyForkExtensions } from "../plugin-registry-extensions.js";
import type { PluginRegistry, PluginModule } from "../types.js";

describe("applyForkExtensions", () => {
  it("wraps register with version check", () => {
    const origRegister = vi.fn();
    const registry: PluginRegistry = {
      register: origRegister,
      get: vi.fn(),
      getModule: vi.fn(),
      list: vi.fn(),
      loadBuiltins: vi.fn(),
      loadFromConfig: vi.fn(),
    };

    applyForkExtensions(registry);

    const plugin: PluginModule = {
      manifest: {
        name: "test-plugin",
        slot: "agent",
        description: "test",
        version: "0.1.0",
      },
      create: vi.fn(),
    };

    registry.register(plugin, {});

    expect(origRegister).toHaveBeenCalledWith(plugin, {});
  });

  it("logs warning on major version mismatch", () => {
    const origRegister = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry: PluginRegistry = {
      register: origRegister,
      get: vi.fn(),
      getModule: vi.fn(),
      list: vi.fn(),
      loadBuiltins: vi.fn(),
      loadFromConfig: vi.fn(),
    };

    applyForkExtensions(registry);

    const plugin: PluginModule = {
      manifest: {
        name: "mismatched-plugin",
        slot: "agent",
        description: "test",
        version: "99.0.0",
      },
      create: vi.fn(),
    };

    registry.register(plugin, {});

    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls[0]![0] as string;
    expect(msg).toContain("mismatched-plugin");
    warnSpy.mockRestore();
  });
});
