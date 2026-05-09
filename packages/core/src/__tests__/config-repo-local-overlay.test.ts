import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { findRepoLocalConfigFile } from "../config-topology.js";

const originalHome = process.env["HOME"];
const originalCwd = process.cwd();
const originalStagingPath = process.env["AO_STAGING_CONFIG_PATH"];
const originalProdPath = process.env["AO_PROD_CONFIG_PATH"];
const tempDirs: string[] = [];

afterEach(() => {
  process.env["HOME"] = originalHome;
  if (originalStagingPath === undefined) {
    delete process.env["AO_STAGING_CONFIG_PATH"];
  } else {
    process.env["AO_STAGING_CONFIG_PATH"] = originalStagingPath;
  }
  if (originalProdPath === undefined) {
    delete process.env["AO_PROD_CONFIG_PATH"];
  } else {
    process.env["AO_PROD_CONFIG_PATH"] = originalProdPath;
  }
  process.chdir(originalCwd);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createYaml(path: string, content = "projects: {}\n"): void {
  writeFileSync(path, content, "utf-8");
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

describe("findRepoLocalConfigFile", () => {
  it("finds config in CWD", () => {
    const work = mkdtempSync(join(tmpdir(), "ao-repo-local-"));
    tempDirs.push(work);
    createYaml(join(work, "agent-orchestrator.yaml"));
    process.chdir(work);
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "ao-home-"));
    tempDirs.push(process.env["HOME"]!);

    expect(real(findRepoLocalConfigFile()!)).toBe(real(join(work, "agent-orchestrator.yaml")));
  });

  it("finds config in parent directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "ao-parent-"));
    const child = join(parent, "subdir");
    tempDirs.push(parent);
    mkdirSync(child, { recursive: true });
    createYaml(join(parent, "agent-orchestrator.yaml"));
    process.chdir(child);
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "ao-home-"));
    tempDirs.push(process.env["HOME"]!);

    expect(real(findRepoLocalConfigFile()!)).toBe(real(join(parent, "agent-orchestrator.yaml")));
  });

  it("returns null when no config found", () => {
    const work = mkdtempSync(join(tmpdir(), "ao-no-config-"));
    tempDirs.push(work);
    process.chdir(work);
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "ao-home-"));
    tempDirs.push(process.env["HOME"]!);

    expect(findRepoLocalConfigFile()).toBeNull();
  });

  it("skips managed staging config path", () => {
    const home = mkdtempSync(join(tmpdir(), "ao-home-"));
    const work = mkdtempSync(join(tmpdir(), "ao-work-"));
    tempDirs.push(home, work);

    mkdirSync(join(home, ".hermes"), { recursive: true });
    const managedPath = join(home, ".hermes", "agent-orchestrator.yaml");
    createYaml(managedPath);

    process.env["HOME"] = home;
    process.env["AO_STAGING_CONFIG_PATH"] = managedPath;
    process.chdir(home);

    expect(findRepoLocalConfigFile()).toBeNull();
  });

  it("finds repo-local config even when managed config exists elsewhere", () => {
    const home = mkdtempSync(join(tmpdir(), "ao-home-"));
    const work = mkdtempSync(join(tmpdir(), "ao-work-"));
    tempDirs.push(home, work);

    mkdirSync(join(home, ".hermes"), { recursive: true });
    createYaml(join(home, ".hermes", "agent-orchestrator.yaml"));
    createYaml(join(work, "agent-orchestrator.yaml"));

    process.env["HOME"] = home;
    delete process.env["AO_STAGING_CONFIG_PATH"];
    process.chdir(work);

    expect(real(findRepoLocalConfigFile()!)).toBe(real(join(work, "agent-orchestrator.yaml")));
  });
});
