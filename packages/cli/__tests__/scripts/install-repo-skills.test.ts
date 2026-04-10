import { describe, it, expect } from "vitest";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readlinkSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const scriptPath = join(repoRoot, "scripts", "install-repo-skills.sh");

describe("scripts/install-repo-skills.sh", () => {
  it("installs the repo-local AO skill into Claude and Codex user skill dirs", () => {
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
    });

    const claudeTarget = join(fakeHome, ".claude", "skills", "agent-orchestrator");
    const codexTarget = join(fakeHome, ".codex", "skills", "agent-orchestrator");
    const expectedTarget = join(repoRoot, "skills", "agent-orchestrator");

    expect(result.status).toBe(0);
    expect(lstatSync(claudeTarget).isSymbolicLink()).toBe(true);
    expect(lstatSync(codexTarget).isSymbolicLink()).toBe(true);
    expect(readlinkSync(claudeTarget)).toBe(expectedTarget);
    expect(readlinkSync(codexTarget)).toBe(expectedTarget);

    rmSync(tempRoot, { recursive: true, force: true });
  });
});
