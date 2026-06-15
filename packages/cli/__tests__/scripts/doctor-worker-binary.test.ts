import { describe, it, expect } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const scriptPath = join(repoRoot, "packages", "cli", "scripts", "ao-doctor.sh");

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
  createFakeBinary(binDir, "timeout", 'shift\nexec "$@"');
}

function runDoctorWithEnv(
  binDir: string,
  fakeRepo: string,
  configPath: string,
  tempRoot: string,
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [scriptPath], {
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
}

function writeConfig(tempRoot: string): string {
  const configPath = join(tempRoot, "agent-orchestrator.yaml");
  const dataDir = join(tempRoot, "data");
  const worktreeDir = join(tempRoot, "worktrees");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(worktreeDir, { recursive: true });
  writeFileSync(
    configPath,
    [`dataDir: ${dataDir}`, `worktreeDir: ${worktreeDir}`, "projects: {}"].join("\n"),
  );
  return configPath;
}

describe("scripts/ao-doctor.sh — lifecycle-worker binary canonicalization", () => {
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

    const configPath = writeConfig(tempRoot);
    const result = runDoctorWithEnv(binDir, fakeRepo, configPath, tempRoot);
    rmSync(tempRoot, { recursive: true, force: true });

    // The shim case must NOT emit "non-canonical lifecycle-worker" warnings.
    expect(result.stdout).not.toContain("non-canonical lifecycle-worker");
    expect(result.stdout).toContain("all lifecycle-workers using canonical binary");
  });

  it("resolves $basedir-style pnpm shims and accepts their exec target as canonical", { timeout: 30000 }, () => {
    // pnpm 9+ generates shell shims of the form:
    //   exec node "$basedir/../path/to/node_modules/@jleechanorg/ao-cli/dist/index.js" "$@"
    // where $basedir is the directory containing the shim. The doctor's
    // canonical_shim parsing must substitute $basedir → shim's dir before
    // comparing, so workers spawned as `node $realDistPath lifecycle-worker …`
    // are still recognized as canonical.
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-doctor-basedir-"));
    const fakeRepo = createHealthyRepo(tempRoot);
    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    createHealthyPath(binDir);

    // The pnpm shim is placed in binDir (the shim directory) and references
    // $basedir/../<repo>/packages/cli/dist/index.js. After $basedir substitution
    // by the doctor, this resolves to <repo>/packages/cli/dist/index.js.
    const repoRelativeDist = "../repo/packages/cli/dist/index.js";
    rmSync(join(binDir, "ao"), { force: true });
    writeExecutable(
      join(binDir, "ao"),
      [
        "#!/bin/bash",
        'if [ "$1" = "--version" ]; then printf "0.1.3\\n"; exit 0; fi',
        // pnpm's actual shim writes the literal text "$basedir/..." into the
        // shim file (the variable is exported above the exec line). The
        // doctor's $basedir substitution will rewrite this to the resolved
        // shim-dir before comparing to worker argv.
        `exec node "$basedir/${repoRelativeDist}" "$@"`,
        "",
      ].join("\n"),
    );

    // Worker argv uses the resolved dist path.
    const distPath = join(fakeRepo, "packages", "cli", "dist", "index.js");
    createFakeBinary(
      binDir,
      "ps",
      `printf "user  12345  12345  node ${distPath} lifecycle-worker agent-orchestrator\\n"`,
    );

    const configPath = writeConfig(tempRoot);
    const result = runDoctorWithEnv(binDir, fakeRepo, configPath, tempRoot);
    rmSync(tempRoot, { recursive: true, force: true });

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

    const configPath = writeConfig(tempRoot);
    const result = runDoctorWithEnv(binDir, fakeRepo, configPath, tempRoot);
    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.stdout).toContain("non-canonical lifecycle-worker");
    expect(result.stdout).toContain("some-other-ao");
  });

  it("recognizes workers as canonical when ao is a direct symlink to dist/index.js (ao_realpath path)", { timeout: 30000 }, () => {
    // Gate 8a coverage: ao_realpath() symlink resolution.
    // When `ao` is a direct OS symlink (not a shell shim) pointing to
    // dist/index.js, `command -v ao` returns the symlink path but
    // ao_realpath() follows it to dist/index.js, stored as canonical_real.
    // Workers spawning as `node dist/index.js lifecycle-worker` must be
    // accepted as canonical via the canonical_real match, not rejected.
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-doctor-symlink-"));
    const fakeRepo = createHealthyRepo(tempRoot);
    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    createHealthyPath(binDir);

    // Replace the healthy-path shell-script `ao` with a direct OS symlink.
    // This matches the pnpm npm-pack install shape where ao -> dist/index.js.
    // Use realpathSync to normalize the target so /var and /private/var agree
    // on macOS (where /var is itself a symlink to /private/var and ao_realpath()
    // returns the /private/var form while tmpdir() returns /var).
    const distPath = realpathSync(join(fakeRepo, "packages", "cli", "dist", "index.js"));
    rmSync(join(binDir, "ao"), { force: true });
    symlinkSync(distPath, join(binDir, "ao"));

    // Worker argv uses the resolved dist path (exec resolves symlinks at spawn).
    createFakeBinary(
      binDir,
      "ps",
      `printf "user  12345  12345  node ${distPath} lifecycle-worker agent-orchestrator\\n"`,
    );

    const configPath = writeConfig(tempRoot);
    const result = runDoctorWithEnv(binDir, fakeRepo, configPath, tempRoot);
    rmSync(tempRoot, { recursive: true, force: true });

    // ao_realpath() resolves binDir/ao -> distPath, so cmd == canonical_real.
    expect(result.stdout).not.toContain("non-canonical lifecycle-worker");
    expect(result.stdout).toContain("all lifecycle-workers using canonical binary");
  });
});
