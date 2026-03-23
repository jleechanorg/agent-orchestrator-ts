#!/usr/bin/env node
/**
 * Sync all workspace package versions to match the root package.json version.
 * Called by semantic-release after it bumps the root package.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "glob";

const root = fileURLToPath(new URL("..", import.meta.url));
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const version = rootPkg.version;

const pkgFiles = [
  ...globSync("packages/*/package.json", { cwd: root, ignore: "packages/mobile/package.json" }),
  ...globSync("packages/plugins/*/package.json", { cwd: root }),
];

for (const rel of pkgFiles) {
  const abs = join(root, rel);
  const pkg = JSON.parse(readFileSync(abs, "utf-8"));
  if (pkg.version === undefined) continue; // skip packages without version
  pkg.version = version;
  writeFileSync(abs, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`  bumped ${pkg.name} → ${version}`);
}

console.log(`All packages synced to ${version}`);
