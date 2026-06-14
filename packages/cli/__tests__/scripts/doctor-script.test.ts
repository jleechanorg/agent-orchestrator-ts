import { describe, it, expect } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const scriptPath = join(repoRoot, "scripts", "ao-doctor.sh");

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function createFakeBinary(binDir: string, name: string, body: string): void {
  writeExecutable(join(binDir, name), `#!/bin/bash\nset -e\n${body}\n`);
}

function createHealthyRepo(tempRoot: string): string {
  const fakeRepo = join(tempRoot, "repo");
  mkdirSync(join(fakeRepo, "node_modules"), { recursive: true });
  mkdirSync(join(fakeRepo, "packages", "core", "dist"), { recursive: true });
  mkdirSync(join(fakeRepo, "packages", "cli", "dist"), { recursive: true });
  mkdirSync(join(fakeRepo, "packages", "agent-orchestrator", "bin"), { recursive: true });
  mkdirSync(join(fakeRepo, "packages", "web"), { recursive: true });
  writeFileSync(join(fakeRepo, "packages", "core", "dist", "index.js"), "export {};\n");
  writeFileSync(join(fakeRepo, "packages", "cli", "dist", "index.js"), "export {};\n");
  writeFileSync(
    join(fakeRepo, "packages", "agent-orchestrator", "bin", "ao.js"),
    '#!/usr/bin/env node\nconsole.log("0.1.0");\n',
  );
  chmodSync(join(fakeRepo, "packages", "agent-orchestrator", "bin", "ao.js"), 0o755);
  return fakeRepo;
}

function createHealthyPath(binDir: string): void {
  createFakeBinary(
    binDir,
    "node",
    'if [ "$1" = "--version" ]; then\n  printf "v20.11.1\\n"\n  exit 0\nfi\nexit 0',
  );
  createFakeBinary(
    binDir,
    "git",
    'if [ "$1" = "--version" ]; then\n  printf "git version 2.43.0\\n"\n  exit 0\nfi\nexit 0',
  );
  createFakeBinary(
    binDir,
    "pnpm",
    [
      "if [ \"$1\" = \"install\" ] && [ \"$2\" = \"-g\" ]; then",
      "  mkdir -p \"${PNPM_HOME:-$HOME/.local/share/pnpm}\"",
      "  printf '#!/bin/bash\\nif [ \"$1\" = \"--version\" ]; then printf \"0.1.3\\\\n\"; exit 0; fi\\nexit 0\\n' > \"${PNPM_HOME:-$HOME/.local/share/pnpm}/ao\"",
      "  chmod +x \"${PNPM_HOME:-$HOME/.local/share/pnpm}/ao\"",
      "fi",
      'if [ "$1" = "--version" ]; then',
      '  printf "9.15.4\\n"',
      '  exit 0',
      "fi",
      "exit 0",
    ].join("\n"),
  );
  createFakeBinary(
    binDir,
    "npm",
    'if [ "$1" = "bin" ]; then\n  printf "/tmp/npm-bin\\n"\n  exit 0\nfi\nexit 0',
  );
  createFakeBinary(
    binDir,
    "tmux",
    'if [ "$1" = "-V" ]; then\n  printf "tmux 3.4\\n"\n  exit 0\nfi\nif [ "$1" = "list-sessions" ]; then\n  exit 1\nfi\nexit 0',
  );
  createFakeBinary(
    binDir,
    "gh",
    'if [ "$1" = "--version" ]; then\n  printf "gh version 2.50.0\\n"\n  exit 0\nfi\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then\n  exit 0\nfi\nexit 0',
  );
  createFakeBinary(binDir, "ao", 'printf "/fake/ao\\n" >/dev/null\nexit 0');
  // timeout is not guaranteed in the restricted test PATH; provide a passthrough shim
  createFakeBinary(binDir, "timeout", 'shift\nexec "$@"');
}

describe("scripts/ao-doctor.sh", () => {
  it("reports a healthy install as PASS", { timeout: 30000 }, () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-doctor-script-"));
    const fakeRepo = createHealthyRepo(tempRoot);
    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    createHealthyPath(binDir);

    const configPath = join(tempRoot, "agent-orchestrator.yaml");
    const dataDir = join(tempRoot, "data");
    const worktreeDir = join(tempRoot, "worktrees");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(
      configPath,
      [`dataDir: ${dataDir}`, `worktreeDir: ${worktreeDir}`, "projects: {}"].join("\n"),
    );

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        // Isolate from a global `ao` on the developer PATH (would skip launcher fix in --fix tests)
        PATH: `${binDir}:/usr/bin:/bin`,
        AO_REPO_ROOT: fakeRepo,
        AO_CONFIG_PATH: configPath,
        AO_STAGING_CONFIG_PATH: join(tempRoot, ".openclaw", "agent-orchestrator.yaml"),
        AO_PROD_CONFIG_PATH: join(tempRoot, ".openclaw_prod", "agent-orchestrator.yaml"),
      },
      encoding: "utf8",
      timeout: 30_000,
    });

    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS");
    expect(result.stdout).toContain("Environment looks healthy");
  });

  it("applies safe fixes for missing launcher, missing dirs, and stale temp files", { timeout: 90_000 }, () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-doctor-fix-"));
    const fakeRepo = createHealthyRepo(tempRoot);
    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    createHealthyPath(binDir);
    rmSync(join(binDir, "ao"), { force: true });

    const configPath = join(tempRoot, "agent-orchestrator.yaml");
    const dataDir = join(tempRoot, "data");
    const worktreeDir = join(tempRoot, "worktrees");
    const commentedDataDir = `${dataDir} # session metadata`;
    const commentedWorktreeDir = `${worktreeDir} # ephemeral worktrees`;
    writeFileSync(
      configPath,
      [`dataDir: ${commentedDataDir}`, `worktreeDir: ${commentedWorktreeDir}`, "projects: {}"].join(
        "\n",
      ),
    );

    const tmpRoot = join(tempRoot, "tmp-root");
    mkdirSync(tmpRoot, { recursive: true });
    const staleFile = join(tmpRoot, "ao-stale.tmp");
    writeFileSync(staleFile, "stale\n");
    const oldTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(staleFile, oldTimestamp, oldTimestamp);

    const pnpmHome = join(tempRoot, "pnpm-global");
    mkdirSync(pnpmHome, { recursive: true });

    const result = spawnSync("bash", [scriptPath, "--fix"], {
      env: {
        ...process.env,
        PATH: `${pnpmHome}:${binDir}:/usr/bin:/bin`,
        PNPM_HOME: pnpmHome,
        AO_REPO_ROOT: fakeRepo,
        AO_CONFIG_PATH: configPath,
        AO_STAGING_CONFIG_PATH: join(tempRoot, ".openclaw", "agent-orchestrator.yaml"),
        AO_PROD_CONFIG_PATH: join(tempRoot, ".openclaw_prod", "agent-orchestrator.yaml"),
        AO_DOCTOR_TMP_ROOT: tmpRoot,
      },
      encoding: "utf8",
      timeout: 60_000,
    });

    const staleStillExists = existsSync(staleFile);
    const dataDirExists = existsSync(dataDir);
    const worktreeDirExists = existsSync(worktreeDir);
    const commentedDataDirExists = existsSync(commentedDataDir);
    const commentedWorktreeDirExists = existsSync(commentedWorktreeDir);
    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("FIXED");
    expect(result.stdout).toContain("pnpm install -g");
    expect(result.stdout).toContain("launcher");
    expect(result.stdout).toContain("stale temp files");
    expect(staleStillExists).toBe(false);
    expect(dataDirExists).toBe(true);
    expect(worktreeDirExists).toBe(true);
    expect(commentedDataDirExists).toBe(false);
    expect(commentedWorktreeDirExists).toBe(false);
  }, 120_000);

  it("fails when the ao launcher resolves into an AO worktree", { timeout: 30000 }, () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-doctor-worktree-link-"));
    const fakeRepo = createHealthyRepo(tempRoot);
    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    createHealthyPath(binDir);

    const fakeHome = join(tempRoot, "home");
    const worktreeBinDir = join(
      fakeHome,
      ".worktrees",
      "agent-orchestrator",
      "pr-528",
      "packages",
      "cli",
      "dist",
    );
    mkdirSync(worktreeBinDir, { recursive: true });
    const worktreeAo = join(worktreeBinDir, "index.js");
    writeExecutable(worktreeAo, "#!/usr/bin/env node\nconsole.log('0.1.3');\n");
    rmSync(join(binDir, "ao"), { force: true });
    symlinkSync(worktreeAo, join(binDir, "ao"));

    const configPath = join(tempRoot, "agent-orchestrator.yaml");
    const dataDir = join(tempRoot, "data");
    const worktreeDir = join(tempRoot, "worktrees");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(
      configPath,
      [`dataDir: ${dataDir}`, `worktreeDir: ${worktreeDir}`, "projects: {}"].join("\n"),
    );

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        HOME: fakeHome,
        PATH: `${binDir}:/usr/bin:/bin`,
        AO_REPO_ROOT: fakeRepo,
        AO_CONFIG_PATH: configPath,
        AO_STAGING_CONFIG_PATH: join(tempRoot, ".openclaw", "agent-orchestrator.yaml"),
        AO_PROD_CONFIG_PATH: join(tempRoot, ".openclaw_prod", "agent-orchestrator.yaml"),
      },
      encoding: "utf8",
      timeout: 30_000,
    });

    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL");
    expect(result.stdout).toContain(".worktrees");
    expect(result.stdout).toContain("ao launcher resolves inside an AO worktree");
  });

  it("treats dist/index.js workers as canonical when canonical ao is a pnpm shim", { timeout: 30000 }, () => {
    // TDD-Red for bd-686.x follow-up: P2 review on PR #690 noted the
    // documented maintainer install (`pnpm install -g $REPO_ROOT/packages/cli`)
    // creates a shell shim at $PNPM_HOME/ao that execs `node <repo>/dist/index.js`.
    // In that case realpath of the shim is the shim itself, not the dist file.
    // The widened regex extracts the dist path from the worker argv, but the
    // comparison only accepted {canonical_binary, canonical_real} which are both
    // the shim path. The check must also accept the shim's exec target.
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-doctor-shim-"));
    const fakeRepo = createHealthyRepo(tempRoot);
    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    createHealthyPath(binDir);

    // Replace the healthy-path `ao` with a pnpm-style shim that execs dist/index.js.
    // This is the documented maintainer install shape from scripts/setup.sh.
    const distPath = join(fakeRepo, "packages", "cli", "dist", "index.js");
    rmSync(join(binDir, "ao"), { force: true });
    writeExecutable(
      join(binDir, "ao"),
      [
        "#!/bin/bash",
        'if [ "$1" = "--version" ]; then printf "0.1.3\\n"; exit 0; fi',
        `exec node "${distPath}" "$@"`,
        "",
      ].join("\n"),
    );

    // Mock `ps aux` to return a worker argv shape using the dist file directly.
    // The doctor's widened regex picks up `/.../dist/index.js`; the comparison
    // must then accept it as canonical even though `command -v ao` returned the
    // shim path, not the dist file.
    createFakeBinary(
      binDir,
      "ps",
      `printf "user  12345  12345  node ${distPath} lifecycle-worker agent-orchestrator\\n"`,
    );

    const configPath = join(tempRoot, "agent-orchestrator.yaml");
    const dataDir = join(tempRoot, "data");
    const worktreeDir = join(tempRoot, "worktrees");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(
      configPath,
      [`dataDir: ${dataDir}`, `worktreeDir: ${worktreeDir}`, "projects: {}"].join("\n"),
    );

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        // Put fake ps + shim ao FIRST on PATH so the doctor sees them.
        PATH: `${binDir}:/usr/bin:/bin`,
        AO_REPO_ROOT: fakeRepo,
        AO_CONFIG_PATH: configPath,
        AO_STAGING_CONFIG_PATH: join(tempRoot, ".openclaw", "agent-orchestrator.yaml"),
        AO_PROD_CONFIG_PATH: join(tempRoot, ".openclaw_prod", "agent-orchestrator.yaml"),
      },
      encoding: "utf8",
      timeout: 30_000,
    });

    rmSync(tempRoot, { recursive: true, force: true });

    // The shim case must NOT emit "non-canonical lifecycle-worker" warnings.
    expect(result.stdout).not.toContain("non-canonical lifecycle-worker");
    expect(result.stdout).toContain("all lifecycle-workers using canonical binary");
  });

  it("still flags a genuinely non-canonical worker binary as non-canonical", { timeout: 30000 }, () => {
    // Counter-test for the shim-extraction fix: a worker pointing to a binary
    // that is neither the shim nor the shim's exec target must still be
    // flagged, otherwise the widened regex silently widens the canonical set.
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-doctor-noncanno-"));
    const fakeRepo = createHealthyRepo(tempRoot);
    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    createHealthyPath(binDir);

    const distPath = join(fakeRepo, "packages", "cli", "dist", "index.js");
    rmSync(join(binDir, "ao"), { force: true });
    writeExecutable(
      join(binDir, "ao"),
      [
        "#!/bin/bash",
        'if [ "$1" = "--version" ]; then printf "0.1.3\\n"; exit 0; fi',
        `exec node "${distPath}" "$@"`,
        "",
      ].join("\n"),
    );

    // A worker pointing at a different binary (some-other-ao, NOT a symlink to
    // the dist file) must still be flagged.
    const otherPath = join(tempRoot, "usr", "local", "bin", "some-other-ao");
    mkdirSync(dirname(otherPath), { recursive: true });
    writeExecutable(otherPath, "#!/bin/bash\nexit 0\n");

    createFakeBinary(
      binDir,
      "ps",
      `printf "user  12345  12345  node ${otherPath} lifecycle-worker agent-orchestrator\\n"`,
    );

    const configPath = join(tempRoot, "agent-orchestrator.yaml");
    const dataDir = join(tempRoot, "data");
    const worktreeDir = join(tempRoot, "worktrees");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(
      configPath,
      [`dataDir: ${dataDir}`, `worktreeDir: ${worktreeDir}`, "projects: {}"].join("\n"),
    );

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${binDir}:/usr/bin:/bin`,
        AO_REPO_ROOT: fakeRepo,
        AO_CONFIG_PATH: configPath,
        AO_STAGING_CONFIG_PATH: join(tempRoot, ".openclaw", "agent-orchestrator.yaml"),
        AO_PROD_CONFIG_PATH: join(tempRoot, ".openclaw_prod", "agent-orchestrator.yaml"),
      },
      encoding: "utf8",
      timeout: 30_000,
    });

    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.stdout).toContain("non-canonical lifecycle-worker");
    expect(result.stdout).toContain("some-other-ao");
  });

  it("warns when running ao version is older than published npm version", { timeout: 30000 }, () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-doctor-version-"));
    const fakeRepo = createHealthyRepo(tempRoot);
    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    createHealthyPath(binDir);

    writeExecutable(
      join(binDir, "ao"),
      '#!/bin/bash\nif [ "$1" = "--version" ]; then printf "0.1.3\\n"; exit 0; fi\nexit 0\n',
    );
    writeExecutable(
      join(binDir, "npm"),
      '#!/bin/bash\nif [ "$1" = "view" ] && [ "$2" = "@jleechanorg/ao-cli" ] && [ "$3" = "version" ]; then printf "0.3.0\\n"; exit 0; fi\nexit 0\n',
    );

    const configPath = join(tempRoot, "agent-orchestrator.yaml");
    const dataDir = join(tempRoot, "data");
    const worktreeDir = join(tempRoot, "worktrees");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(
      configPath,
      [`dataDir: ${dataDir}`, `worktreeDir: ${worktreeDir}`, "projects: {}"].join("\n"),
    );

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${binDir}:/usr/bin:/bin`,
        AO_REPO_ROOT: fakeRepo,
        AO_CONFIG_PATH: configPath,
        AO_STAGING_CONFIG_PATH: join(tempRoot, ".openclaw", "agent-orchestrator.yaml"),
        AO_PROD_CONFIG_PATH: join(tempRoot, ".openclaw_prod", "agent-orchestrator.yaml"),
      },
      encoding: "utf8",
      timeout: 30_000,
    });

    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.stdout).toContain("WARN");
    expect(result.stdout).toContain("OLDER than published npm version");
  });
});
