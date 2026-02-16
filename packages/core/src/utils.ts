/**
 * Shared utility functions for agent-orchestrator plugins.
 */

import { open } from "node:fs/promises";

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
 * Read only the last 4KB of JSONL files to find the last entry.
 * Avoids loading entire (potentially large) files into memory.
 */
const TAIL_READ_BYTES = 4096;

/**
 * Read the last entry from a JSONL file efficiently.
 * Only reads the last TAIL_READ_BYTES (4KB) from the file to avoid loading
 * entire potentially large files into memory.
 *
 * @param filePath - Path to the JSONL file
 * @returns Object containing the last entry's type and file mtime, or null if file is empty/invalid
 */
export async function readLastJsonlEntry(
  filePath: string,
): Promise<{ lastType: string | null; modifiedAt: Date } | null> {
  let fh;
  try {
    fh = await open(filePath, "r");
    const fileStat = await fh.stat();
    const size = fileStat.size;
    if (size === 0) return null;

    // Read only the last TAIL_READ_BYTES (4KB) from the file
    const readSize = Math.min(TAIL_READ_BYTES, size);
    const buffer = Buffer.alloc(readSize);
    const { bytesRead } = await fh.read(buffer, 0, readSize, size - readSize);

    const chunk = buffer.toString("utf-8", 0, bytesRead);
    // Walk backwards through lines to find the last valid JSON object with a type
    const lines = chunk.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          const obj = parsed as Record<string, unknown>;
          if (typeof obj.type === "string") {
            return { lastType: obj.type, modifiedAt: fileStat.mtime };
          }
        }
      } catch {
        // Skip malformed lines (possibly truncated first line in our chunk)
      }
    }

    // No entry with a type field found
    return { lastType: null, modifiedAt: fileStat.mtime };
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}
