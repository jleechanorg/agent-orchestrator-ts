import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const scriptPath = join(repoRoot, "scripts", "start-all.sh");

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function createFakeBinary(binDir: string, name: string, body: string): void {
  writeExecutable(join(binDir, name), `#!/bin/bash\nset -e\n${body}\n`);
}

function createConfig(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      "projects:",
      "  script-test:",
      "    repo: test/script-test",
      "    path: /tmp/script-test",
      "    defaultBranch: main",
    ].join("\n"),
  );
}

describe("scripts/start-all.sh", () => {
  it("skips topology validation when AO_CONFIG_PATH is set explicitly", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-start-all-explicit-"));
    const explicitConfig = join(tempRoot, "explicit-config.yaml");
    const stagingConfig = join(tempRoot, ".openclaw", "agent-orchestrator.yaml");
    const productionConfig = join(tempRoot, ".openclaw_prod", "agent-orchestrator.yaml");
    createConfig(explicitConfig);
    createConfig(productionConfig);
    mkdirSync(dirname(stagingConfig), { recursive: true });
    symlinkSync(productionConfig, stagingConfig);

    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    createFakeBinary(binDir, "pgrep", "exit 0");

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${binDir}:/usr/bin:/bin`,
        AO_CONFIG_PATH: explicitConfig,
        AO_STAGING_CONFIG_PATH: stagingConfig,
        AO_PROD_CONFIG_PATH: productionConfig,
        AO_MAIN_REPO: join(tempRoot, "missing-main-repo"),
      },
      encoding: "utf8",
    });

    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).not.toContain("staging config must be a real file");
    expect(result.stdout).toContain(`Config OK: ${explicitConfig}`);
  });

  it("fails fast on broken managed topology when auto-discovering config", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-start-all-topology-"));
    const stagingConfig = join(tempRoot, ".openclaw", "agent-orchestrator.yaml");
    const productionConfig = join(tempRoot, ".openclaw_prod", "agent-orchestrator.yaml");
    createConfig(productionConfig);
    mkdirSync(dirname(stagingConfig), { recursive: true });
    symlinkSync(productionConfig, stagingConfig);

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `/usr/bin:/bin`,
        AO_CONFIG_PATH: "",
        AO_STAGING_CONFIG_PATH: stagingConfig,
        AO_PROD_CONFIG_PATH: productionConfig,
        AO_MAIN_REPO: join(tempRoot, "missing-main-repo"),
      },
      encoding: "utf8",
    });

    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("staging config must be a real file");
  });
});
