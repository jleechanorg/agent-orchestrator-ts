/**
 * Cross-platform recursive directory copy.
 * Copies srcDir/ to destDir/ preserving directory structure.
 */
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const [, , srcDir, destDir] = process.argv;

if (!srcDir || !destDir) {
  console.error("Usage: node copy-templates.mjs <srcDir> <destDir>");
  process.exit(1);
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

copyDir(srcDir, destDir);
console.log(`Copied ${srcDir}/ → ${destDir}/`);
