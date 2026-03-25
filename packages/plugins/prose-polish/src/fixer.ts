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

/** Trim leading whitespace only. */
function ltrim(str: string): string {
  return str.replace(/^\s+/, "");
}

/**
 * Apply auto-fixable corrections to a line, preserving leading indentation.
 *
 * Filler-word removal can leave single artifact spaces (e.g. "Just a note" →
 * " a note") because the filler itself is 1 char and the space after it is a
 * single char — below the \s{2,} collapse threshold.  We solve this by:
 *   1. Stripping and stashing any leading indentation
 *   2. Removing fillers and collapsing whitespace in the content
 *   3. Trimming only the content (removes artifact trailing space)
 *   4. ltrim()ing the content (removes artifact leading space)
 *   5. Restoring the original indentation
 */
function fixLine(line: string): string {
  // Preserve leading indentation (tabs/spaces that form the line's indent)
  const indentMatch = line.match(/^(\s+)/);
  const indent = indentMatch ? indentMatch[1] : "";
  let result = ltrim(line);

  // Remove filler words (now ltrimmed so no artifact leading space)
  const fillerRE = new RegExp(`\\b(${FILLERS.join("|")})\\b`, "gi");
  result = result.replace(fillerRE, "").replace(/\s{2,}/g, " ").trim();

  // Fix redundant phrases
  for (const [pattern, replacement] of REDUNDANT_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }

  return indent + result;
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

  for (const issue of autoFixable) {
    const idx = issue.line - 1;
    if (idx >= 0 && idx < fixed.length) {
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
