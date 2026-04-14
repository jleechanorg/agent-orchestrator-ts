/**
 * Fork-only: monorepo package resolution fallback.
 * Extracted from plugin-registry.ts to isolate fork diff from upstream.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * True when `err` indicates the requested npm package could not be resolved
 * (missing from node_modules / workspace), not runtime/init failures inside a
 * resolved package. Used to avoid swapping in a monorepo copy when the installed
 * plugin threw for other reasons.
 */
export function isPackageResolutionFailure(err: unknown, pkg: string): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") {
    return msg.includes(pkg);
  }
  if (!msg.includes(pkg)) return false;
  if (/cannot find (package|module)/i.test(msg)) return true;
  if (/module not found/i.test(msg)) return true;
  if (/^Not found:/i.test(msg.trim())) return true;
  return false;
}

/**
 * Attempt to resolve a plugin via a path relative to the monorepo root.
 *
 * Uses plugin-registry's own location (`packages/core/dist/`) to walk up to
 * the monorepo root, then into `packages/plugins/<name>/dist/index.js`.
 *
 * Works when `ao` is run from outside the monorepo — npm cannot resolve
 * workspace-linked packages, but the files are present in the monorepo.
 *
 * @param pkg  The package name (e.g. "@jleechanorg/ao-plugin-agent-gemini")
 * @param modUrl  import.meta.url of plugin-registry.js
 * @returns The loaded plugin module, or null if resolution failed
 */
export async function tryMonorepoFallback(
  pkg: string,
  modUrl: string,
): Promise<unknown> {
  const match = pkg.match(/^@jleechanorg\/ao-plugin-(.+)$/);
  if (!match) return null;
  const pluginName = match[1]!;

  try {
    // plugin-registry.ts lives at packages/core/dist/plugin-registry.js
    // Navigate up to monorepo root: ../../../ → project root (dist → core → packages → root)
    const coreDir = dirname(fileURLToPath(modUrl)); // packages/core/dist
    const monorepoRoot = resolve(coreDir, "../../../");
    const pluginPath = join(
      monorepoRoot,
      "packages",
      "plugins",
      pluginName,
      "dist",
      "index.js",
    );

    // Build a file:// URL so dynamic import() can load it as ESM (Windows-safe)
    const pluginUrl = pathToFileURL(pluginPath).href;
    return await import(pluginUrl);
  } catch {
    return null;
  }
}