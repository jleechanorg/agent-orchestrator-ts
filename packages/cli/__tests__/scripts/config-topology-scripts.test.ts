import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const bootstrapScript = join(repoRoot, "scripts", "bootstrap-openclaw-config.sh");
const promoteScript = join(repoRoot, "scripts", "promote-openclaw-config.sh");
const validateScript = join(repoRoot, "scripts", "validate-config.sh");

describe("OpenClaw config topology scripts", () => {
  it("keeps the packaged topology helper byte-identical to the repo script", () => {
    const repoScript = join(repoRoot, "scripts", "lib", "ao-config-topology.sh");
    const packagedScript = join(repoRoot, "packages", "cli", "scripts", "lib", "ao-config-topology.sh");

    expect(readFileSync(packagedScript, "utf8")).toBe(readFileSync(repoScript, "utf8"));
  });

  it("bootstraps staging without creating production", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-config-bootstrap-"));
    const stagingConfig = join(tempRoot, ".openclaw", "agent-orchestrator.yaml");
    const productionConfig = join(tempRoot, ".openclaw_prod", "agent-orchestrator.yaml");

    const result = spawnSync("bash", [bootstrapScript], {
      env: {
        ...process.env,
        HOME: tempRoot,
        AO_STAGING_CONFIG_PATH: stagingConfig,
        AO_PROD_CONFIG_PATH: productionConfig,
      },
      encoding: "utf8",
    });

    const stagingExists = existsSync(stagingConfig);
    const productionExists = existsSync(productionConfig);
    const stagingContent = stagingExists ? readFileSync(stagingConfig, "utf8") : "";
    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(stagingExists).toBe(true);
    expect(productionExists).toBe(false);
    expect(stagingContent).toContain("Managed staging configuration");
    expect(stagingContent).toContain("projects: {}");
  });

  it("repairs a symlinked staging config when bootstrapping with --force", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-config-bootstrap-force-"));
    const stagingConfig = join(tempRoot, ".openclaw", "agent-orchestrator.yaml");
    const productionConfig = join(tempRoot, ".openclaw_prod", "agent-orchestrator.yaml");

    mkdirSync(dirname(stagingConfig), { recursive: true });
    mkdirSync(dirname(productionConfig), { recursive: true });
    writeFileSync(productionConfig, "projects:\n  prod: {}\n");
    symlinkSync(productionConfig, stagingConfig);

    const result = spawnSync("bash", [bootstrapScript, "--force"], {
      env: {
        ...process.env,
        HOME: tempRoot,
        AO_STAGING_CONFIG_PATH: stagingConfig,
        AO_PROD_CONFIG_PATH: productionConfig,
      },
      encoding: "utf8",
    });

    const repairedStaging = existsSync(stagingConfig) ? readFileSync(stagingConfig, "utf8") : "";
    const productionContent = readFileSync(productionConfig, "utf8");
    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(repairedStaging).toContain("Managed staging configuration");
    expect(productionContent).toBe("projects:\n  prod: {}\n");
  });

  it("promotes a validated staging config into production", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-config-promote-"));
    const stagingConfig = join(tempRoot, ".openclaw", "agent-orchestrator.yaml");
    const productionConfig = join(tempRoot, ".openclaw_prod", "agent-orchestrator.yaml");
    mkdirSync(dirname(stagingConfig), { recursive: true });
    writeFileSync(stagingConfig, "projects: {}\n");

    const result = spawnSync("bash", [promoteScript], {
      env: {
        ...process.env,
        HOME: tempRoot,
        AO_STAGING_CONFIG_PATH: stagingConfig,
        AO_PROD_CONFIG_PATH: productionConfig,
      },
      encoding: "utf8",
    });
    try {
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(existsSync(productionConfig)).toBe(true);
      expect(readFileSync(productionConfig, "utf8")).toBe("projects: {}\n");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("validates an explicit AO_CONFIG_PATH without blocking on broken managed topology", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-config-validate-explicit-"));
    const stagingConfig = join(tempRoot, ".openclaw", "agent-orchestrator.yaml");
    const productionConfig = join(tempRoot, ".openclaw_prod", "agent-orchestrator.yaml");
    const explicitConfig = join(tempRoot, "explicit-config.yaml");

    mkdirSync(dirname(stagingConfig), { recursive: true });
    mkdirSync(dirname(productionConfig), { recursive: true });
    writeFileSync(productionConfig, "projects:\n  prod: {}\n");
    symlinkSync(productionConfig, stagingConfig);
    writeFileSync(explicitConfig, "projects: {}\n");

    const result = spawnSync("bash", [validateScript], {
      env: {
        ...process.env,
        HOME: tempRoot,
        AO_CONFIG_PATH: explicitConfig,
        AO_STAGING_CONFIG_PATH: stagingConfig,
        AO_PROD_CONFIG_PATH: productionConfig,
      },
      encoding: "utf8",
    });

    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain(`OK: ${explicitConfig} is valid YAML`);
    expect(result.stderr).not.toContain("staging config must be a real file");
  });
});
