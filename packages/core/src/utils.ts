/**
 * Shared utility functions for agent-orchestrator plugins.
 */

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * POSIX-safe shell escaping: wraps value in single quotes,
 * escaping any embedded single quotes as '\\'' .
 *
 * Safe for use in both `sh -c` and `execFile` contexts.
 */
export function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Escape a string for safe interpolation inside AppleScript double-quoted strings.
 * Handles backslashes and double quotes which would otherwise break or inject.
 */
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Validate that a URL starts with http:// or https://.
 * Throws with a descriptive error including the plugin label if invalid.
 */
export function validateUrl(url: string, label: string): void {
  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    throw new Error(`[${label}] Invalid url: must be http(s), got "${url}"`);
  }
}

/**
 * Read the last entry from a JSONL file.
 * Uses `tail -1` to efficiently read the last line, then JSON.parse in Node.
 *
 * @param filePath - Path to the JSONL file
 * @returns Object containing the last entry's type and file mtime, or null if empty/invalid
 */
export async function readLastJsonlEntry(
  filePath: string,
): Promise<{ lastType: string | null; modifiedAt: Date } | null> {
  try {
    const [{ stdout }, fileStat] = await Promise.all([
      execFileAsync("tail", ["-1", filePath], { timeout: 5_000 }),
      stat(filePath),
    ]);

    const line = stdout.trim();
    if (!line) return null;

    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const lastType = typeof obj.type === "string" ? obj.type : null;
      return { lastType, modifiedAt: fileStat.mtime };
    }

    return { lastType: null, modifiedAt: fileStat.mtime };
  } catch {
    return null;
  }
}
