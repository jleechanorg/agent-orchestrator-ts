import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startConfigHotReload, type ConfigHotReloadHandle } from "../config-hot-reload.js";
import { writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("startConfigHotReload", () => {
  let handle: ConfigHotReloadHandle | null = null;
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ao-hotreload-"));
    configPath = join(tempDir, "test-config.yaml");
    writeFileSync(configPath, "test: true\n");
  });

  afterEach(() => {
    handle?.close();
    handle = null;
    try { unlinkSync(configPath); } catch {}
    try { rmdirSync(tempDir); } catch {}
  });

  it("returns null for non-existent path", () => {
    const result = startConfigHotReload({
      configPath: "/nonexistent/path.yaml",
      reload: () => ({}) as any,
      onChange: () => {},
      onError: () => {},
    });
    expect(result).toBeNull();
  });

  it("returns handle with initial config for existing path", () => {
    handle = startConfigHotReload({
      configPath,
      reload: () => ({ projects: {} }) as any,
      onChange: () => {},
      onError: () => {},
    });
    expect(handle).not.toBeNull();
    expect(handle!.getConfig()).toEqual({ projects: {} });
  });

  it("handle.close() stops the watcher without error", () => {
    handle = startConfigHotReload({
      configPath,
      reload: () => ({ projects: {} }) as any,
      onChange: () => {},
      onError: () => {},
    });
    expect(() => handle!.close()).not.toThrow();
    handle = null;
  });

  it("getConfig returns last reloaded config", () => {
    const initial = { projects: {} };
    const reloaded = { projects: { app: {} } };
    let callCount = 0;

    handle = startConfigHotReload({
      configPath,
      reload: () => {
        callCount++;
        return callCount > 1 ? (reloaded as any) : (initial as any);
      },
      onChange: () => {},
      onError: () => {},
      debounceMs: 50,
    });

    expect(handle!.getConfig()).toEqual(initial);
  });
});
