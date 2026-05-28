/**
 * Plugin version mismatch warning — warns when plugin version doesn't match core version.
 *
 * Companion module: plugin-registry.ts is upstream code; version checking
 * is a fork feature so it lives here to avoid merge conflicts.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginManifest } from "./types.js";

let _coreVersion: string | undefined;

function getCoreVersion(): string {
  if (_coreVersion !== undefined) return _coreVersion;

  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(thisDir, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    _coreVersion = typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    _coreVersion = "0.0.0";
  }

  return _coreVersion!;
}

export interface VersionMismatchWarning {
  pluginName: string;
  pluginSlot: string;
  pluginVersion: string;
  coreVersion: string;
}

export function checkPluginVersionMismatch(
  manifest: PluginManifest,
): VersionMismatchWarning | null {
  const coreVersion = getCoreVersion();
  const pluginVersion = manifest.version;

  if (!pluginVersion || pluginVersion === coreVersion) {
    return null;
  }

  if (isCompatibleMajorVersion(pluginVersion, coreVersion)) {
    return null;
  }

  return {
    pluginName: manifest.name,
    pluginSlot: manifest.slot,
    pluginVersion,
    coreVersion,
  };
}

export function isCompatibleMajorVersion(pluginVersion: string, coreVersion: string): boolean {
  const pluginMajor = parseMajor(pluginVersion);
  const coreMajor = parseMajor(coreVersion);

  if (pluginMajor === null || coreMajor === null) return false;

  return pluginMajor === coreMajor;
}

function parseMajor(version: string): number | null {
  const parts = version.split(".");
  const major = parseInt(parts[0] ?? "", 10);
  return Number.isFinite(major) ? major : null;
}

export function formatVersionMismatchWarning(warning: VersionMismatchWarning): string {
  return (
    `[plugin-version-check] Plugin "${warning.pluginSlot}:${warning.pluginName}" ` +
    `version ${warning.pluginVersion} doesn't match core version ${warning.coreVersion}. ` +
    `Major version mismatch may cause incompatibility.`
  );
}
