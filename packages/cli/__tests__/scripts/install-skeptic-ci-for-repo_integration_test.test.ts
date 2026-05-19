import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const scriptPath = join(repoRoot, "scripts", "install-skeptic-ci-for-repo.sh");

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

/** Minimal curl stub: supports `curl -fsSL <url> -o <path>` used by the installer. */
function createFakeCurl(binDir: string): void {
  writeExecutable(
    join(binDir, "curl"),
    `#!/bin/bash
set -e
url=""
dest=""
expect_o=false
for arg in "$@"; do
  if [ "$expect_o" = true ]; then
    dest="$arg"
    expect_o=false
    continue
  fi
  if [ "$arg" = "-o" ]; then
    expect_o=true
    continue
  fi
  case "$arg" in
    http*) url="$arg" ;;
  esac
done
if [ -z "$url" ] || [ -z "$dest" ]; then
  echo "fake curl: could not parse url/dest" >&2
  exit 1
fi
mkdir -p "$(dirname "$dest")"
if [[ "$url" == *skeptic-gate.yml ]]; then
  echo "# skeptic-gate template" > "$dest"
elif [[ "$url" == *skeptic-cron.yml ]]; then
  echo "# skeptic-cron template" > "$dest"
else
  echo "fake curl: unexpected url $url" >&2
  exit 1
fi
exit 0
`,
  );
}

function initBareGitRepo(dir: string): void {
  const init = spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  expect(init.status).toBe(0);
}

describe("scripts/install-skeptic-ci-for-repo.sh", () => {
  it("prints help and exits 0", () => {
    const result = spawnSync("bash", [scriptPath, "--help"], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Install only skeptic-gate");
  });

  it("with no flags, installs both workflow files", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "install-skeptic-ci-"));
    try {
      const fakeRepo = join(tempRoot, "repo");
      mkdirSync(fakeRepo, { recursive: true });
      initBareGitRepo(fakeRepo);

      const binDir = join(tempRoot, "bin");
      mkdirSync(binDir, { recursive: true });
      createFakeCurl(binDir);

      const result = spawnSync("bash", [scriptPath], {
        cwd: fakeRepo,
        env: {
          ...process.env,
          PATH: `${binDir}:/usr/bin:/bin:/usr/local/bin`,
          SKEPTIC_CI_REPO: "fake/ignored",
          SKEPTIC_CI_REF: "main",
        },
        encoding: "utf8",
        timeout: 20_000,
      });

      const gate = join(fakeRepo, ".github", "workflows", "skeptic-gate.yml");
      const cron = join(fakeRepo, ".github", "workflows", "skeptic-cron.yml");
      const gateBody = existsSync(gate) ? readFileSync(gate, "utf8") : "";
      const cronBody = existsSync(cron) ? readFileSync(cron, "utf8") : "";

      expect(result.status).toBe(0);
      expect(gateBody).toContain("skeptic-gate");
      expect(cronBody).toContain("skeptic-cron");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("with --gate only, installs skeptic-gate.yml", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "install-skeptic-gate-"));
    try {
      const fakeRepo = join(tempRoot, "repo");
      mkdirSync(fakeRepo, { recursive: true });
      initBareGitRepo(fakeRepo);

      const binDir = join(tempRoot, "bin");
      mkdirSync(binDir, { recursive: true });
      createFakeCurl(binDir);

      const result = spawnSync("bash", [scriptPath, "--gate"], {
        cwd: fakeRepo,
        env: {
          ...process.env,
          PATH: `${binDir}:/usr/bin:/bin:/usr/local/bin`,
          SKEPTIC_CI_REPO: "fake/ignored",
          SKEPTIC_CI_REF: "main",
        },
        encoding: "utf8",
        timeout: 20_000,
      });

      const gate = join(fakeRepo, ".github", "workflows", "skeptic-gate.yml");
      const cron = join(fakeRepo, ".github", "workflows", "skeptic-cron.yml");
      const gateExists = existsSync(gate);
      const cronExists = existsSync(cron);

      expect(result.status).toBe(0);
      expect(gateExists).toBe(true);
      expect(cronExists).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects --cron --minimal regardless of flag order", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "install-skeptic-minimal-conflict-"));
    try {
      const fakeRepo = join(tempRoot, "repo");
      mkdirSync(fakeRepo, { recursive: true });
      initBareGitRepo(fakeRepo);

      const binDir = join(tempRoot, "bin");
      mkdirSync(binDir, { recursive: true });
      createFakeCurl(binDir);

      const result = spawnSync("bash", [scriptPath, "--cron", "--minimal"], {
        cwd: fakeRepo,
        env: {
          ...process.env,
          PATH: `${binDir}:/usr/bin:/bin:/usr/local/bin`,
          SKEPTIC_CI_REPO: "fake/ignored",
          SKEPTIC_CI_REF: "main",
        },
        encoding: "utf8",
        timeout: 20_000,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("--minimal can't be combined with --cron or --all");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
