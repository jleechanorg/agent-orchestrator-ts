import { describe, it, expect } from "vitest";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readlinkSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const scriptPath = join(repoRoot, "scripts", "install-repo-skills.sh");

describe("scripts/install-repo-skills.sh", () => {
  it("installs all repo-local skills into Claude and Codex user skill dirs", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-install-skills-"));
    const fakeHome = join(tempRoot, "home");
    mkdirSync(fakeHome, { recursive: true });
    chmodSync(scriptPath, 0o755);

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        HOME: fakeHome,
        AO_REPO_ROOT: repoRoot,
      },
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(result.status).toBe(0);

    // All skills in the repo's skills/ dir should be symlinked
    const repoSkills = readdirSync(join(repoRoot, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    for (const skill of repoSkills) {
      const expectedTarget = join(repoRoot, "skills", skill);
      const claudeTarget = join(fakeHome, ".claude", "skills", skill);
      const codexTarget = join(fakeHome, ".codex", "skills", skill);

      expect(lstatSync(claudeTarget).isSymbolicLink(), `claude: ${skill} should be symlink`).toBe(true);
      expect(lstatSync(codexTarget).isSymbolicLink(), `codex: ${skill} should be symlink`).toBe(true);
      expect(readlinkSync(claudeTarget).replace(/\/$/, "")).toBe(expectedTarget.replace(/\/$/, ""));
      expect(readlinkSync(codexTarget).replace(/\/$/, "")).toBe(expectedTarget.replace(/\/$/, ""));
    }

    rmSync(tempRoot, { recursive: true, force: true });
  });
});
