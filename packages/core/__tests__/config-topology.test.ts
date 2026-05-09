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
    process.env["AO_STAGING_CONFIG_PATH"] = join(testDir, ".hermes", "agent-orchestrator.yaml");
    process.env["AO_PROD_CONFIG_PATH"] = join(
      testDir,
      ".hermes_prod",
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

    mkdirSync(join(testDir, ".hermes"), { recursive: true });
    mkdirSync(join(testDir, ".hermes_prod"), { recursive: true });
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

    mkdirSync(join(testDir, ".hermes"), { recursive: true });
    mkdirSync(join(testDir, ".hermes_prod"), { recursive: true });
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

    mkdirSync(join(testDir, ".hermes_prod"), { recursive: true });
    writeFileSync(productionPath, "projects: {}\n");
    mkdirSync(join(testDir, ".hermes"), { recursive: true });
    symlinkSync(productionPath, stagingPath);

    const problems = validateManagedConfigTopology({ requireStaging: true, requireProduction: true });
    expect(problems.map((problem) => problem.issue)).toEqual(
      expect.arrayContaining(["staging_symlinked", "staging_prod_same_target"]),
    );
  });
});

describe("config-topology HERMES_HOME discovery chain", () => {
  // These tests exercise the production config discovery chain WITHOUT setting
  // AO_PROD_CONFIG_PATH / AO_PRODUCTION_CONFIG_PATH, so that the
  // HERMES_HOME -> ~/.hermes_prod chain is actually tested.
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    testDir = join(tmpdir(), `ao-hermes-discovery-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    originalEnv = { ...process.env };
    // Set TEST_HOME_DIR so the mock homedir() returns our test dir.
    process.env["TEST_HOME_DIR"] = testDir;
    // Clear the prod config path overrides so the discovery chain is exercised.
    delete process.env["AO_PROD_CONFIG_PATH"];
    delete process.env["AO_PRODUCTION_CONFIG_PATH"];
    delete process.env["HERMES_HOME"];
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(testDir, { recursive: true, force: true });
  });

  it("discovers production config from HERMES_HOME when set", async () => {
    const { getManagedConfigPath } = await import("../src/config-topology.js");
    const hermesHome = join(testDir, ".hermes");
    mkdirSync(hermesHome, { recursive: true });
    const hermesConfig = join(hermesHome, "agent-orchestrator.yaml");
    writeFileSync(hermesConfig, "projects: {}\n");
    process.env["HERMES_HOME"] = hermesHome;

    const path = getManagedConfigPath("production");

    expect(path).toBe(hermesConfig);
  });

  it("falls back to ~/.hermes_prod when HERMES_HOME has no config", async () => {
    const { getManagedConfigPath } = await import("../src/config-topology.js");
    const hermesProdDir = join(testDir, ".hermes_prod");
    mkdirSync(hermesProdDir, { recursive: true });
    const hermesProdConfig = join(hermesProdDir, "agent-orchestrator.yaml");
    writeFileSync(hermesProdConfig, "projects: {}\n");
    // HERMES_HOME is unset; .hermes_prod should be found.
    delete process.env["HERMES_HOME"];

    const path = getManagedConfigPath("production");

    expect(path).toBe(hermesProdConfig);
  });

  it("HERMES_HOME takes precedence over ~/.hermes_prod", async () => {
    const { getManagedConfigPath } = await import("../src/config-topology.js");
    const hermesHome = join(testDir, ".hermes");
    const hermesProdDir = join(testDir, ".hermes_prod");
    mkdirSync(hermesHome, { recursive: true });
    mkdirSync(hermesProdDir, { recursive: true });
    writeFileSync(join(hermesHome, "agent-orchestrator.yaml"), "projects: {}\n");
    writeFileSync(join(hermesProdDir, "agent-orchestrator.yaml"), "projects: {}\n");
    process.env["HERMES_HOME"] = hermesHome;

    const path = getManagedConfigPath("production");

    // HERMES_HOME should win over .hermes_prod.
    expect(path).toBe(join(hermesHome, "agent-orchestrator.yaml"));
  });

  it("returns default ~/.hermes_prod/agent-orchestrator.yaml when nothing exists", async () => {
    const { getManagedConfigPath } = await import("../src/config-topology.js");
    // No HERMES_HOME, no .hermes_prod.
    delete process.env["HERMES_HOME"];

    const path = getManagedConfigPath("production");

    expect(path).toBe(join(testDir, ".hermes_prod", "agent-orchestrator.yaml"));
  });

  it("AO_PROD_CONFIG_PATH takes precedence over HERMES_HOME", async () => {
    const { getManagedConfigPath } = await import("../src/config-topology.js");
    const explicitPath = join(testDir, "explicit-prod.yaml");
    writeFileSync(explicitPath, "projects: {}\n");
    const hermesHome = join(testDir, ".hermes");
    mkdirSync(hermesHome, { recursive: true });
    writeFileSync(join(hermesHome, "agent-orchestrator.yaml"), "projects: {}\n");
    process.env["AO_PROD_CONFIG_PATH"] = explicitPath;
    process.env["HERMES_HOME"] = hermesHome;

    const path = getManagedConfigPath("production");

    // Explicit env override wins over HERMES_HOME.
    expect(path).toBe(explicitPath);
  });

  it("findManagedConfigFile finds production in HERMES_HOME when present", async () => {
    const { findManagedConfigFile } = await import("../src/config-topology.js");
    const hermesHome = join(testDir, ".hermes");
    mkdirSync(hermesHome, { recursive: true });
    writeFileSync(join(hermesHome, "agent-orchestrator.yaml"), "projects: {}\n");
    process.env["HERMES_HOME"] = hermesHome;
    delete process.env["AO_STAGING_CONFIG_PATH"];
    delete process.env["AO_CONFIG_STAGING_PATH"];

    const found = findManagedConfigFile();

    expect(found).toBe(join(hermesHome, "agent-orchestrator.yaml"));
  });

  it("expands tilde in HERMES_HOME before existence check", async () => {
    const { getManagedConfigPath } = await import("../src/config-topology.js");
    // Set up a config at ~/.hermes_prod/agent-orchestrator.yaml using the real homedir
    // but pass HERMES_HOME as a literal "~" string.
    const hermesProdDir = join(testDir, ".hermes_prod");
    mkdirSync(hermesProdDir, { recursive: true });
    writeFileSync(join(hermesProdDir, "agent-orchestrator.yaml"), "projects: {}\n");
    // Pass ~ literally — the implementation must expand it to the mock homedir.
    process.env["HERMES_HOME"] = "~/.hermes_prod";

    const path = getManagedConfigPath("production");

    expect(path).toBe(join(hermesProdDir, "agent-orchestrator.yaml"));
  });

  it("expands tilde in a custom HERMES_HOME before existence check", async () => {
    const { getManagedConfigPath } = await import("../src/config-topology.js");
    const hermesHome = join(testDir, ".custom-hermes-home");
    mkdirSync(hermesHome, { recursive: true });
    const hermesConfig = join(hermesHome, "agent-orchestrator.yaml");
    writeFileSync(hermesConfig, "projects: {}\n");
    process.env["HERMES_HOME"] = "~/.custom-hermes-home";

    const path = getManagedConfigPath("production");

    expect(path).toBe(hermesConfig);
  });
});
