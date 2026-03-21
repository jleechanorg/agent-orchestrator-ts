#!/usr/bin/env node
/* eslint-disable no-console */
/* global process */
// Automatically rebuild node-pty from source after pnpm install
// This fixes DirectTerminal "posix_spawnp failed" errors from incompatible prebuilt binaries

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..");

// Find node-pty in pnpm node_modules
const nodePtyPath = join(repoRoot, "node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty");

if (!existsSync(nodePtyPath)) {
  console.log("ℹ️  node-pty not found, skipping rebuild");
  process.exit(0);
}

console.log("🔧 Rebuilding node-pty from source...");

try {
  execSync("npx node-gyp rebuild", {
    cwd: nodePtyPath,
    stdio: "inherit",
  });
  console.log("✅ node-pty rebuilt successfully");
} catch {
  console.warn("⚠️  node-pty rebuild failed (non-critical)");
  console.warn("   DirectTerminal may not work correctly");
  console.warn(
    "   Run manually: cd node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty && npx node-gyp rebuild",
  );
  // Don't fail the install - node-pty rebuild failure is non-critical
  process.exit(0);
}
