import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const scriptPath = join(repoRoot, "scripts", "start-all.sh");
const setupLaunchdScriptPath = join(repoRoot, "scripts", "setup-launchd.sh");

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function createFakeBinary(binDir: string, name: string, body: string): void {
  writeExecutable(join(binDir, name), `#!/bin/bash\nset -e\n${body}\n`);
}

function createFakeSleep(binDir: string): void {
  writeExecutable(join(binDir, "sleep"), "exit 0");
}

// Hermetic python3 stub: bypasses the runtime pyyaml dependency in start-all.sh
// so tests do not require pyyaml installed in the CI runner image. First call
// (`import yaml; yaml.safe_load(...)`) exits 0; second call (`for pid in ...`)
// prints the test project id.
function createPythonStub(binDir: string, projectId: string): void {
  writeExecutable(
    join(binDir, "python3"),
    [
      "#!/bin/bash",
      'case "$*" in',
      `  *"for pid in"*) echo ${JSON.stringify(projectId)} ;;`,
      "esac",
      "exit 0",
    ].join("\n") + "\n",
  );
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

function waitForFile(path: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return true;
    }
  }
  return existsSync(path);
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
    createPythonStub(binDir, "script-test");
    createFakeSleep(binDir);

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${binDir}:/usr/bin:/bin`,
        AO_CONFIG_PATH: explicitConfig,
        AO_STAGING_CONFIG_PATH: stagingConfig,
        AO_PROD_CONFIG_PATH: productionConfig,
        AO_MAIN_REPO: join(tempRoot, "missing-main-repo"),
        AO_START_ALL_LOCKDIR: join(tempRoot, "ao-start-all.lock"),
      },
      encoding: "utf8",
      timeout: 20_000,
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
    createPythonStub(binDir, "script-test");
    createFakeSleep(binDir);

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${binDir}:/usr/bin:/bin`,
        AO_CONFIG_PATH: explicitConfig,
        AO_MAIN_REPO: join(tempRoot, "missing-main-repo"),
        AO_START_ALL_LOCKDIR: join(tempRoot, "ao-start-all.lock"),
      },
      encoding: "utf8",
      timeout: 20_000,
    });

    const aoWasCalled = waitForFile(aoLog, 300);
    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("lifecycle-worker already running for script-test");
    expect(aoWasCalled).toBe(false);
  });

  // TDD Red-phase (fc29232c0): pre-fix pgrep stub had no PID output → for/pid loop
  // iterates 0× → no kill → nohup never fires → aoLog never created → aoWasCalled
  // stays false → "expect(aoWasCalled).toBe(true)" FAILS. Fix: echo a large fake PID.
  it("replaces an already-running lifecycle-worker when AO_START_REPLACE_EXISTING=1", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-start-all-replace-"));
    const explicitConfig = join(tempRoot, "explicit-config.yaml");
    const aoLog = join(tempRoot, "ao-called.log");
    createConfig(explicitConfig);

    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    // Large out-of-range PID prevents kill "$pid" from targeting a real process.
    createFakeBinary(binDir, "pgrep", "echo 999999999; exit 0");
    createFakeBinary(binDir, "ao", `echo "$@" >> "${aoLog}"`);
    createPythonStub(binDir, "script-test");
    createFakeSleep(binDir);

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${binDir}:/usr/bin:/bin`,
        AO_CONFIG_PATH: explicitConfig,
        AO_MAIN_REPO: join(tempRoot, "missing-main-repo"),
        AO_START_ALL_LOCKDIR: join(tempRoot, "ao-start-all.lock"),
        AO_START_REPLACE_EXISTING: "1",
      },
      encoding: "utf8",
      timeout: 20_000,
    });

    const aoWasCalled = waitForFile(aoLog, 1000);
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

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `/usr/bin:/bin`,
        AO_CONFIG_PATH: "",
        AO_STAGING_CONFIG_PATH: stagingConfig,
        AO_PROD_CONFIG_PATH: productionConfig,
        AO_MAIN_REPO: join(tempRoot, "missing-main-repo"),
        AO_START_ALL_LOCKDIR: join(tempRoot, "ao-start-all.lock"),
      },
      encoding: "utf8",
      timeout: 20_000,
    });

    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("staging config must be a real file");
  });

  it("matches launchd lifecycle-workers that run through the resolved ao target", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-setup-launchd-match-"));
    const realBinDir = join(tempRoot, "real-bin");
    const shimBinDir = join(tempRoot, "shim-bin");
    mkdirSync(realBinDir, { recursive: true });
    mkdirSync(shimBinDir, { recursive: true });
    const realAo = join(realBinDir, "ao");
    const shimAo = join(shimBinDir, "ao");
    writeExecutable(realAo, "#!/bin/bash\nexit 0\n");
    symlinkSync(realAo, shimAo);

    const command = [
      "set -euo pipefail",
      "export AO_SETUP_LAUNCHD_SOURCE_ONLY=1",
      `source ${JSON.stringify(setupLaunchdScriptPath)}`,
      'escaped_project="$(escape_ere worldarchitect)"',
      `command_matches_ao_worker ${JSON.stringify(`node ${realAo} lifecycle-worker worldarchitect`)} ${JSON.stringify(shimAo)} "$escaped_project"`,
      `if command_matches_ao_worker ${JSON.stringify(`node ${join(tempRoot, "other", "ao")} lifecycle-worker worldarchitect`)} ${JSON.stringify(shimAo)} "$escaped_project"; then exit 42; fi`,
    ].join("\n");

    const result = spawnSync("bash", ["-lc", command], {
      env: {
        ...process.env,
        PATH: `${shimBinDir}:/usr/bin:/bin`,
        HOME: tempRoot,
      },
      encoding: "utf8",
      timeout: 20_000,
    });

    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
