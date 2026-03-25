/**
 * Prose auto-fixer.
 */

import { writeFileSync } from "node:fs";
import type { FixResult, Severity } from "./types.js";
import { detectAllPatterns } from "./detector.js";

const FILLERS = [
  "literally", "basicall?y", "simply", "actually", "obviously",
  "clearly", "totally", "completely", "absolutely", "utterly",
  "really", "truly", "just", "quite", "somehow",
];

const REDUNDANT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bvery\sunique\b/gi, "unique"],
  [/\bvery\sspecial\b/gi, "special"],
  [/\bfree\sgift\b/gi, "gift"],
  [/\bpast\shistory\b/gi, "history"],
  [/\bfuture\splans\b/gi, "plans"],
  [/\bcompletely\seliminate\b/gi, "eliminate"],
  [/\bunexpected\ssurprise\b/gi, "surprise"],
  [/\bblatantly\sobvious\b/gi, "obvious"],
];

/**
 * Apply auto-fixable corrections to a line.
 */
function fixLine(line: string): string {
  let result = line;

  // Remove filler words
  const fillerRE = new RegExp(`\\b(${FILLERS.join("|")})\\b`, "gi");
  result = result.replace(fillerRE, "").replace(/\s{2,}/g, " ");

  // Fix redundant phrases
  for (const [pattern, replacement] of REDUNDANT_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

/**
 * Apply auto-fixes to a file and write a .bak backup.
 * Returns the list of changes made.
 */
export function autoFixFile(
  filePath: string,
  content: string,
  minSeverity: Severity | undefined = "info"
): FixResult {
  const lines = content.split("\n");
  const issues = detectAllPatterns(lines, minSeverity);
  const autoFixable = issues.filter(i => i.autoFixable);

  // Build corrected lines (deep copy)
  const fixed = lines.map(l => l);

  // Apply fixes once per unique line to avoid repeated passes
  const linesFixed = new Set<number>();
  for (const issue of autoFixable) {
    const idx = issue.line - 1;
    if (idx >= 0 && idx < fixed.length && !linesFixed.has(idx)) {
      linesFixed.add(idx);
      const original = fixed[idx];
      fixed[idx] = fixLine(original);
      if (fixed[idx] !== original) {
        // Update suggestion with actual change
        issue.suggestion = `"${original}" → "${fixed[idx]}"`;
      }
    }
  }

  // Write backup
  const bakPath = `${filePath}.bak`;
  writeFileSync(bakPath, content, "utf-8");

  // Write fixed
  writeFileSync(filePath, fixed.join("\n"), "utf-8");

  const fixes = autoFixable
    .map(i => ({
      line: i.line,
      original: lines[i.line - 1],
      fixed: fixed[i.line - 1],
    }))
    .filter(f => f.original !== f.fixed);

  return { file: filePath, bakPath, fixes };
}
