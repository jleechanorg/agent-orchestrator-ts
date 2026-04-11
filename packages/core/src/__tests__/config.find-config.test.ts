import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { findConfigFile } from "../config.js";

const originalHome = process.env["HOME"];
const originalCwd = process.cwd();
const originalAoConfigPath = process.env["AO_CONFIG_PATH"];
const tempDirs: string[] = [];

afterEach(() => {
  process.env["HOME"] = originalHome;
  if (originalAoConfigPath === undefined) {
    delete process.env["AO_CONFIG_PATH"];
  } else {
    process.env["AO_CONFIG_PATH"] = originalAoConfigPath;
  }
  process.chdir(originalCwd);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createYaml(path: string): void {
  writeFileSync(path, "projects: {}\n", "utf-8");
}

describe("findConfigFile home fallback order", () => {
  it("prefers ~/.openclaw/agent-orchestrator.yaml over ~/.openclaw_prod/agent-orchestrator.yaml", () => {
    const home = mkdtempSync(join(tmpdir(), "ao-config-home-"));
    const work = mkdtempSync(join(tmpdir(), "ao-config-cwd-"));
    tempDirs.push(home, work);

    mkdirSync(join(home, ".openclaw_prod"), { recursive: true });
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    const prod = join(home, ".openclaw_prod", "agent-orchestrator.yaml");
    const legacy = join(home, ".openclaw", "agent-orchestrator.yaml");
    createYaml(prod);
    createYaml(legacy);

    process.env["HOME"] = home;
    delete process.env["AO_CONFIG_PATH"];
    process.chdir(work);

    expect(findConfigFile()).toBe(legacy);
  });

  it("falls back to ~/.openclaw/agent-orchestrator.yaml when prod config is absent", () => {
    const home = mkdtempSync(join(tmpdir(), "ao-config-home-"));
    const work = mkdtempSync(join(tmpdir(), "ao-config-cwd-"));
    tempDirs.push(home, work);

    mkdirSync(join(home, ".openclaw"), { recursive: true });
    const legacy = join(home, ".openclaw", "agent-orchestrator.yaml");
    createYaml(legacy);

    process.env["HOME"] = home;
    delete process.env["AO_CONFIG_PATH"];
    process.chdir(work);

    expect(findConfigFile()).toBe(legacy);
  });
});
