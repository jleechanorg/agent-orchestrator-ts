/**
 * Tests for scripts/ao-health.sh AO_CLI_PATH → AO_MATCH liveness scoping.
 *
 * PR #563 fix: AO_MATCH now uses AO_CLI_PATH so workers launched via
 * `node /path/to/index.js lifecycle-worker <project>` (source-tree CLI) are
 * correctly detected as running. Before the fix AO_MATCH always used the PATH
 * shim, causing false "worker missing" detections for source-tree workers.
 */

import { describe, it, expect } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const scriptPath = join(repoRoot, "scripts", "ao-health.sh");

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

/** Creates a minimal agent-orchestrator.yaml with one project. */
function createConfig(configPath: string, projectId = "ao-health-test"): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    [
      "projects:",
      `  ${projectId}:`,
      `    repo: test/${projectId}`,
      `    path: /tmp/${projectId}`,
      "    defaultBranch: main",
    ].join("\n") + "\n",
  );
}

/**
 * Runs ao-health.sh with a controlled stub environment.
 *
 * pgrep/ps stubs simulate a running lifecycle-worker with the given cmdline.
 * Omit workerCmdline to simulate no running worker.
 */
function runAoHealth(opts: {
  tempRoot: string;
  aoCliPath?: string;
  projectId?: string;
  workerCmdline?: string;
}): string {
  const {
    tempRoot,
    aoCliPath,
    projectId = "ao-health-test",
    workerCmdline,
  } = opts;

  const binDir = join(tempRoot, "bin");
  mkdirSync(binDir, { recursive: true });

  const logsDir = join(tempRoot, "logs");
  mkdirSync(logsDir, { recursive: true });

  const configPath = join(tempRoot, "agent-orchestrator.yaml");
  createConfig(configPath, projectId);

  // python3: stub YAML parser — echoes project ID
  writeExecutable(
    join(binDir, "python3"),
    `#!/bin/bash\necho ${JSON.stringify(projectId)}\nexit 0\n`,
  );

  if (workerCmdline) {
    // pgrep: returns fake PID 12345 when queried for lifecycle-worker
    writeExecutable(
      join(binDir, "pgrep"),
      `#!/bin/bash\nif [[ "$*" == *"lifecycle-worker"* ]]; then echo 12345; exit 0; fi\nexit 1\n`,
    );
    // ps: returns the simulated worker cmdline for PID 12345
    writeExecutable(
      join(binDir, "ps"),
      `#!/bin/bash\nif [[ "$*" == *"12345"* ]]; then echo ${JSON.stringify(workerCmdline)}; fi\nexit 0\n`,
    );
  } else {
    // No running worker
    writeExecutable(join(binDir, "pgrep"), "#!/bin/bash\nexit 1\n");
    writeExecutable(join(binDir, "ps"), "#!/bin/bash\nexit 0\n");
  }

  // nohup / sleep: no-ops for launch path
  writeExecutable(join(binDir, "nohup"), "#!/bin/bash\nexit 0\n");
  writeExecutable(join(binDir, "sleep"), "#!/bin/bash\nexit 0\n");

  // ao: stub
  writeExecutable(join(binDir, "ao"), "#!/bin/bash\nexit 0\n");

  // node: stub
  writeExecutable(join(binDir, "node"), "#!/bin/bash\nexit 0\n");

  // git: return "main" for branch check
  writeExecutable(
    join(binDir, "git"),
    '#!/bin/bash\nif [[ "$*" == *"branch --show-current"* ]]; then echo "main"; fi\nexit 0\n',
  );

  // stat: small file (no rotation)
  writeExecutable(join(binDir, "stat"), "#!/bin/bash\necho 0\n");

  // launchctl: not found (plist bootstrap no-op)
  writeExecutable(
    join(binDir, "launchctl"),
    '#!/bin/bash\necho "Could not find service"; exit 0\n',
  );

  const env: Record<string, string> = {
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin`,
    AO_CONFIG_PATH: configPath,
    AO_LOG_DIR: logsDir,
    HOME: tempRoot,
    AO_REPO_ROOT: repoRoot,
  };

  if (aoCliPath !== undefined) {
    env["AO_CLI_PATH"] = aoCliPath;
  } else {
    delete env["AO_CLI_PATH"];
  }

  const result = spawnSync("bash", [scriptPath], {
    env,
    encoding: "utf8",
    timeout: 15_000,
  });

  // Script must always exit 0 (launchd throttle fix)
  expect(result.status, `ao-health.sh exited ${result.status}: ${result.stderr}`).toBe(0);

  const logFile = join(logsDir, "ao-health.log");
  if (!existsSync(logFile)) return "";
  return readFileSync(logFile, "utf8");
}

describe("ao-health.sh AO_MATCH liveness scoping", () => {
  it("detects a source-tree worker (launched via AO_CLI_PATH) as own worker", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-health-match-"));

    // Source-tree CLI path (non-executable JS file, like dist/index.js)
    const distDir = join(tempRoot, "packages", "cli", "dist");
    mkdirSync(distDir, { recursive: true });
    const cliPath = join(distDir, "index.js");
    writeFileSync(cliPath, "// stub");

    // Simulate a running worker whose cmdline is: node /path/to/index.js lifecycle-worker ao-health-test
    const workerCmdline = `node ${cliPath} lifecycle-worker ao-health-test`;

    const log = runAoHealth({ tempRoot, aoCliPath: cliPath, workerCmdline });

    // Worker was detected → script should NOT log "START: worker missing"
    // (it skipped the start because own_worker=true)
    expect(log).not.toContain("worker missing");
  });

  it("starts worker when AO_CLI_PATH is set but no matching process is found", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-health-nomatch-"));

    const distDir = join(tempRoot, "packages", "cli", "dist");
    mkdirSync(distDir, { recursive: true });
    const cliPath = join(distDir, "index.js");
    writeFileSync(cliPath, "// stub");

    // No running worker (pgrep returns nothing)
    const log = runAoHealth({ tempRoot, aoCliPath: cliPath });

    expect(log).toContain("worker missing");
  });

  it("exits 0 always, even when worker start fails (launchd throttle fix)", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-health-exit0-"));
    // runAoHealth already asserts exit 0 inside — this test exists to make the
    // launchd exit-0 invariant an explicit, named test case.
    runAoHealth({ tempRoot });
    // If we reach here, exit code was 0 (asserted in runAoHealth)
  });
});
