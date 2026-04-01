import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_PLUGINS } from "../plugin-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readCliPackageJson(): Record<string, unknown> {
  const cliPkgPath = resolve(__dirname, "../../../cli/package.json");
  return JSON.parse(readFileSync(cliPkgPath, "utf-8"));
}

describe("BUILTIN_PLUGINS ↔ CLI package.json consistency", () => {
  const cliPkg = readCliPackageJson();
  const cliRuntimeDeps = (cliPkg.dependencies ?? {}) as Record<string, string>;

  it("registry lists builtin plugins", () => {
    expect(BUILTIN_PLUGINS.length).toBeGreaterThan(10);
  });

  // Every builtin plugin package MUST be a runtime dependency of the CLI,
  // otherwise `npm install -g @jleechanorg/ao-cli` will miss it
  // and `ao spawn --agent <name>` will fail with "plugin not found".
  for (const builtin of BUILTIN_PLUGINS) {
    it(`CLI depends on ${builtin.pkg} (${builtin.slot}:${builtin.name})`, () => {
      expect(cliRuntimeDeps).toHaveProperty(builtin.pkg, expect.any(String));
    });
  }
});
