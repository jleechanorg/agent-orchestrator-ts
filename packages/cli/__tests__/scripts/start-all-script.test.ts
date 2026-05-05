import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

    const pythonBinDir = process.env.PYTHON_BIN ? resolve(dirname(process.env.PYTHON_BIN)) : "";
    const testBinDir = `${binDir}${pythonBinDir ? `:${pythonBinDir}` : ""}`;
    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${testBinDir}:/usr/bin:/bin`,
        AO_CONFIG_PATH: explicitConfig,
        AO_STAGING_CONFIG_PATH: stagingConfig,
        AO_PROD_CONFIG_PATH: productionConfig,
        AO_MAIN_REPO: join(tempRoot, "missing-main-repo"),
        AO_START_ALL_LOCKDIR: join(tempRoot, "ao-start-all.lock"),
      },
      encoding: "utf8",
    });

    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).not.toContain("staging config must be a real file");
    expect(result.stdout).toContain(`Config OK: ${explicitConfig}`);
  });

  it("does not restart an already-running lifecycle-worker by default", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-start-all-idempotent-"));
    const explicitConfig = join(tempRoot, "explicit-config.yaml");
    const aoLog = join(tempRoot, "ao-called.log");
    createConfig(explicitConfig);

    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    createFakeBinary(binDir, "pgrep", "exit 0");
    createFakeBinary(binDir, "ao", `echo "$@" >> "${aoLog}"`);

    const pythonBinDir = process.env.PYTHON_BIN ? resolve(dirname(process.env.PYTHON_BIN)) : "";
    const testBinDir = `${binDir}${pythonBinDir ? `:${pythonBinDir}` : ""}`;
    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${testBinDir}:/usr/bin:/bin`,
        AO_CONFIG_PATH: explicitConfig,
        AO_MAIN_REPO: join(tempRoot, "missing-main-repo"),
        AO_START_ALL_LOCKDIR: join(tempRoot, "ao-start-all.lock"),
      },
      encoding: "utf8",
    });

    const aoWasCalled = existsSync(aoLog);
    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("lifecycle-worker already running for script-test");
    expect(aoWasCalled).toBe(false);
  });

  it("replaces an already-running lifecycle-worker when AO_START_REPLACE_EXISTING=1", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-start-all-replace-"));
    const explicitConfig = join(tempRoot, "explicit-config.yaml");
    const aoLog = join(tempRoot, "ao-called.log");
    createConfig(explicitConfig);

    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    // Output a PID so the replacement kill loop has something to iterate over.
    createFakeBinary(binDir, "pgrep", "echo 12345; exit 0");
    createFakeBinary(binDir, "ao", `echo "$@" >> "${aoLog}"`);

    const pythonBinDir = process.env.PYTHON_BIN ? resolve(dirname(process.env.PYTHON_BIN)) : "";
    const testBinDir = `${binDir}${pythonBinDir ? `:${pythonBinDir}` : ""}`;
    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${testBinDir}:/usr/bin:/bin`,
        AO_CONFIG_PATH: explicitConfig,
        AO_MAIN_REPO: join(tempRoot, "missing-main-repo"),
        AO_START_ALL_LOCKDIR: join(tempRoot, "ao-start-all.lock"),
        AO_START_REPLACE_EXISTING: "1",
      },
      encoding: "utf8",
    });

    const aoWasCalled = existsSync(aoLog);
    const aoArgs = aoWasCalled ? readFileSync(aoLog, "utf8") : "";
    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("killing existing lifecycle-worker(s)");
    expect(aoWasCalled).toBe(true);
    expect(aoArgs).toContain("lifecycle-worker script-test");
  });

  it("fails fast on broken managed topology when auto-discovering config", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-start-all-topology-"));
    const stagingConfig = join(tempRoot, ".openclaw", "agent-orchestrator.yaml");
    const productionConfig = join(tempRoot, ".openclaw_prod", "agent-orchestrator.yaml");
    createConfig(productionConfig);
    mkdirSync(dirname(stagingConfig), { recursive: true });
    symlinkSync(productionConfig, stagingConfig);

    const pythonBinDir = process.env.PYTHON_BIN ? resolve(dirname(process.env.PYTHON_BIN)) : "";
    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: pythonBinDir ? `${pythonBinDir}:/usr/bin:/bin` : `/usr/bin:/bin`,
        AO_CONFIG_PATH: "",
        AO_STAGING_CONFIG_PATH: stagingConfig,
        AO_PROD_CONFIG_PATH: productionConfig,
        AO_MAIN_REPO: join(tempRoot, "missing-main-repo"),
        AO_START_ALL_LOCKDIR: join(tempRoot, "ao-start-all.lock"),
      },
      encoding: "utf8",
    });

    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("staging config must be a real file");
  });
});
