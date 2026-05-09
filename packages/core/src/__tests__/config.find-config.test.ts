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
  it("prefers ~/.hermes/agent-orchestrator.yaml over ~/.hermes_prod/agent-orchestrator.yaml", () => {
    const home = mkdtempSync(join(tmpdir(), "ao-config-home-"));
    const work = mkdtempSync(join(tmpdir(), "ao-config-cwd-"));
    tempDirs.push(home, work);

    mkdirSync(join(home, ".hermes_prod"), { recursive: true });
    mkdirSync(join(home, ".hermes"), { recursive: true });
    const prod = join(home, ".hermes_prod", "agent-orchestrator.yaml");
    const staging = join(home, ".hermes", "agent-orchestrator.yaml");
    createYaml(prod);
    createYaml(staging);

    process.env["HOME"] = home;
    delete process.env["AO_CONFIG_PATH"];
    process.chdir(work);

    expect(findConfigFile()).toBe(staging);
  });

  it("falls back to ~/.hermes/agent-orchestrator.yaml when prod config is absent", () => {
    const home = mkdtempSync(join(tmpdir(), "ao-config-home-"));
    const work = mkdtempSync(join(tmpdir(), "ao-config-cwd-"));
    tempDirs.push(home, work);

    mkdirSync(join(home, ".hermes"), { recursive: true });
    const staging = join(home, ".hermes", "agent-orchestrator.yaml");
    createYaml(staging);

    process.env["HOME"] = home;
    delete process.env["AO_CONFIG_PATH"];
    process.chdir(work);

    expect(findConfigFile()).toBe(staging);
  });
});
