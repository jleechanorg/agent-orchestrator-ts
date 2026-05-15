import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("release config", () => {
  it("publishes workspace packages to npm so the CLI installs without source", () => {
    const config = JSON.parse(readFileSync(resolve(repoRoot, ".releaserc.json"), "utf8"));
    const execPlugin = config.plugins.find((entry: unknown) => {
      return Array.isArray(entry) && entry[0] === "@semantic-release/exec";
    });

    expect(execPlugin).toBeTruthy();
    expect(execPlugin[1]).toMatchObject({
      prepareCmd: "node scripts/bump-all-packages.js ${nextRelease.version}",
      publishCmd: "pnpm -r publish --access public --no-git-checks",
    });
    expect(
      config.plugins.some(
        (entry: unknown) => Array.isArray(entry) && entry[0] === "@semantic-release/npm",
      ),
    ).toBe(false);
  });
});
