import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const webDirSource = readFileSync(
  resolve(repoRoot, "packages/cli/src/lib/web-dir.ts"),
  "utf8",
);

describe("web-dir.ts error message", () => {
  it("references @jleechanorg/ao-cli (not @composio/ao) in the install hint", () => {
    expect(webDirSource).toContain("npm install -g @jleechanorg/ao-cli");
    expect(webDirSource).not.toContain("@composio/ao");
  });
});
