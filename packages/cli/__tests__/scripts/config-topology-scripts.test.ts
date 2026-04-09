import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const bootstrapScript = join(repoRoot, "scripts", "bootstrap-openclaw-config.sh");
const promoteScript = join(repoRoot, "scripts", "promote-openclaw-config.sh");

describe("OpenClaw config topology scripts", () => {
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
});
