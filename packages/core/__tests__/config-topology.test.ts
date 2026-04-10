import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => process.env["TEST_HOME_DIR"] || actual.homedir(),
  };
});

describe("config-topology", () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    testDir = join(tmpdir(), `ao-config-topology-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    originalEnv = { ...process.env };
    process.env["TEST_HOME_DIR"] = testDir;
    process.env["AO_STAGING_CONFIG_PATH"] = join(testDir, ".openclaw", "agent-orchestrator.yaml");
    process.env["AO_PROD_CONFIG_PATH"] = join(
      testDir,
      ".openclaw_prod",
      "agent-orchestrator.yaml",
    );
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(testDir, { recursive: true, force: true });
  });

  it("prefers staging over production during managed discovery", async () => {
    const { findManagedConfigFile, getManagedConfigPath, getLegacyConfigPaths } = await import(
      "../src/config-topology.js"
    );
    const stagingPath = getManagedConfigPath("staging");
    const productionPath = getManagedConfigPath("production");
    const legacyPath = getLegacyConfigPaths()[0];

    mkdirSync(join(testDir, ".openclaw"), { recursive: true });
    mkdirSync(join(testDir, ".openclaw_prod"), { recursive: true });
    writeFileSync(stagingPath, "projects: {}\n");
    writeFileSync(productionPath, "projects: {}\n");
    mkdirSync(join(testDir), { recursive: true });
    writeFileSync(legacyPath, "projects: {}\n");

    expect(findManagedConfigFile()).toBe(stagingPath);
  });

  it("does not treat legacy aliases as managed configs", async () => {
    const { findManagedConfigFile, getManagedConfigPath, getLegacyConfigPaths } = await import(
      "../src/config-topology.js"
    );
    const stagingPath = getManagedConfigPath("staging");
    const productionPath = getManagedConfigPath("production");
    const legacyPath = getLegacyConfigPaths()[0];
    const sharedConfig = join(testDir, "shared-config.yaml");

    mkdirSync(join(testDir, ".openclaw"), { recursive: true });
    mkdirSync(join(testDir, ".openclaw_prod"), { recursive: true });
    writeFileSync(stagingPath, "projects: {}\n");
    writeFileSync(productionPath, "projects: {}\n");
    writeFileSync(sharedConfig, "projects: {}\n");
    symlinkSync(sharedConfig, legacyPath);

    expect(findManagedConfigFile()).toBe(stagingPath);
    rmSync(productionPath, { force: true });
    rmSync(stagingPath, { force: true });
    expect(findManagedConfigFile()).toBeNull();
  });

  it("reports when staging and prod point at the same file", async () => {
    const { getManagedConfigPath, validateManagedConfigTopology } = await import(
      "../src/config-topology.js"
    );
    const stagingPath = getManagedConfigPath("staging");
    const productionPath = getManagedConfigPath("production");

    mkdirSync(join(testDir, ".openclaw_prod"), { recursive: true });
    writeFileSync(productionPath, "projects: {}\n");
    mkdirSync(join(testDir, ".openclaw"), { recursive: true });
    symlinkSync(productionPath, stagingPath);

    const problems = validateManagedConfigTopology({ requireStaging: true, requireProduction: true });
    expect(problems.map((problem) => problem.issue)).toEqual(
      expect.arrayContaining(["staging_symlinked", "staging_prod_same_target"]),
    );
  });
});
