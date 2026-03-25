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
 * Exported for unit testing.
 */
export function fixLine(line: string): string {
  // Preserve leading whitespace so indentation is not destroyed
  const leadingWs = line.match(/^(\s*)/)?.[1] ?? "";

  // Preserve Markdown hard-break suffix (trailing 2+ spaces) before processing
  const trailingSuffix = (line.match(/(\s{2,})$/) ?? [])[1] ?? "";

  // Slice result to only the content between leading and trailing whitespace,
  // so filler removal cannot inadvertently alter the trailing hard-break suffix.
  const contentEnd = trailingSuffix ? line.length - trailingSuffix.length : line.length;
  let result = line.slice(leadingWs.length, contentEnd);

  // Remove filler words
  const fillerRE = new RegExp(`\\b(${FILLERS.join("|")})\\b`, "gi");
  result = result.replace(fillerRE, "");

  // Collapse only internal whitespace runs (not leading/trailing)
  result = result.replace(/\s{2,}/g, " ");

  // Strip artifact spaces left when a filler word at the start/end of
  // the non-whitespace content is removed (e.g. "Just a note" → " a note")
  result = result.trim();

  // Fix redundant phrases
  for (const [pattern, replacement] of REDUNDANT_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }

  return leadingWs + result.trimEnd() + trailingSuffix;
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
        issue.suggestion = `"${original.trim()}" → "${fixed[idx].trim()}"`;
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
