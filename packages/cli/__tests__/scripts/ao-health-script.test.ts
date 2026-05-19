/**
 * Tests for scripts/ao-health.sh AO_CLI_PATH → AO_LAUNCH construction.
 *
 * Verifies that when AO_CLI_PATH points to a non-executable JS file the
 * lifecycle-worker is launched as `node <path>`, and when AO_CLI_PATH is
 * unset the fallback is `ao`.
 */

import { describe, it, expect } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
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
 * Returns the content of the log file written by the script.
 */
function runAoHealth(opts: {
  tempRoot: string;
  aoCliPath?: string;
  projectId?: string;
}): string {
  const { tempRoot, aoCliPath, projectId = "ao-health-test" } = opts;

  const binDir = join(tempRoot, "bin");
  mkdirSync(binDir, { recursive: true });

  const logsDir = join(tempRoot, "logs");
  mkdirSync(logsDir, { recursive: true });

  const configPath = join(tempRoot, "agent-orchestrator.yaml");
  createConfig(configPath, projectId);

  // python3: stub YAML parser — prints the project ID when called with a config path
  writeExecutable(
    join(binDir, "python3"),
    `#!/bin/bash\necho ${JSON.stringify(projectId)}\nexit 0\n`,
  );

  // pgrep: always returns empty (no workers running)
  writeExecutable(join(binDir, "pgrep"), "#!/bin/bash\nexit 1\n");

  // ps: returns nothing
  writeExecutable(join(binDir, "ps"), "#!/bin/bash\nexit 0\n");

  // nohup: discard actual launch (we only care about the log line)
  writeExecutable(join(binDir, "nohup"), "#!/bin/bash\nexit 0\n");

  // sleep: instant
  writeExecutable(join(binDir, "sleep"), "#!/bin/bash\nexit 0\n");

  // launchctl: report service not found so bootstrap branch no-ops
  writeExecutable(
    join(binDir, "launchctl"),
    '#!/bin/bash\necho "Could not find service"; exit 0\n',
  );

  // stat: return 0 (small file, no rotation)
  writeExecutable(join(binDir, "stat"), "#!/bin/bash\necho 0\n");

  // ao: stub (fallback binary)
  writeExecutable(join(binDir, "ao"), "#!/bin/bash\nexit 0\n");

  // node: stub (used when AO_CLI_PATH is a .js file)
  writeExecutable(join(binDir, "node"), "#!/bin/bash\nexit 0\n");

  // git: stub to avoid slow git operations in CI (branch check in ao-health.sh)
  writeExecutable(join(binDir, "git"), '#!/bin/bash\nif [[ "$*" == *"branch --show-current"* ]]; then echo "main"; fi\nexit 0\n');

  // command: shell builtin — use a wrapper that returns the stub path
  // (used by ao-health.sh: AO_MATCH="$(command -v ao ...)")
  // We leave this to the real shell builtin; our stub ao is on PATH.

  const env: Record<string, string> = {
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin`,
    AO_CONFIG_PATH: configPath,
    AO_LOG_DIR: logsDir,
    HOME: tempRoot,
    // Prevent repo topology walk from hitting the real home dir
    AO_REPO_ROOT: repoRoot,
  };

  if (aoCliPath !== undefined) {
    env["AO_CLI_PATH"] = aoCliPath;
  } else {
    delete env["AO_CLI_PATH"];
  }

  spawnSync("bash", [scriptPath], {
    env,
    encoding: "utf8",
    timeout: 15_000,
  });

  const logFile = join(logsDir, "ao-health.log");
  if (!existsSync(logFile)) return "";
  return readFileSync(logFile, "utf8");
}

describe("ao-health.sh AO_LAUNCH construction", () => {
  it("uses 'node <path>' when AO_CLI_PATH points to a non-executable JS file", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-health-test-"));

    // Create a non-executable JS file (simulates packages/cli/dist/index.js)
    const distDir = join(tempRoot, "packages", "cli", "dist");
    mkdirSync(distDir, { recursive: true });
    const cliPath = join(distDir, "index.js");
    writeFileSync(cliPath, "// stub\n");
    // NOT chmodSync to 0o755 — stays non-executable

    const log = runAoHealth({ tempRoot, aoCliPath: cliPath });
    rmSync(tempRoot, { recursive: true, force: true });

    expect(log).toContain(`cmd=node ${cliPath}`);
    expect(log).not.toContain("cmd=ao");
  });

  it("falls back to 'ao' when AO_CLI_PATH is not set", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-health-fallback-"));

    const log = runAoHealth({ tempRoot }); // no aoCliPath
    rmSync(tempRoot, { recursive: true, force: true });

    expect(log).toContain("cmd=ao");
  });

  it("uses the executable directly when AO_CLI_PATH is an executable script", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-health-exec-"));

    const binDir = join(tempRoot, "custom-bin");
    mkdirSync(binDir, { recursive: true });
    const execPath = join(binDir, "ao-custom");
    writeFileSync(execPath, "#!/bin/bash\nexit 0\n");
    chmodSync(execPath, 0o755);

    const log = runAoHealth({ tempRoot, aoCliPath: execPath });
    rmSync(tempRoot, { recursive: true, force: true });

    // Should not prepend 'node' for an executable file
    expect(log).toContain(`cmd=${execPath}`);
    expect(log).not.toContain(`cmd=node ${execPath}`);
  });
});
