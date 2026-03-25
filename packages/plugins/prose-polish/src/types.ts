/**
 * Shared types for prose-polish plugin.
 */

export type Severity = "info" | "warn" | "critical";

export type PatternCategory =
  | "not-x-repetition"
  | "forced-rule-of-3"
  | "weak-sentence-opening"
  | "filler-word"
  | "redundant-phrase"
  | "weasel-word"
  | "repeated-sentence-starters"
  | "proximity-repetition";

export interface ProseMatch {
  rule: string;
  category: PatternCategory;
  line: number;
  text: string;
  message: string;
  severity: Severity;
  autoFixable: boolean;
  suggestion?: string;
}

export interface ScanResult {
  file: string;
  totalLines: number;
  issues: ProseMatch[];
  summary: {
    critical: number;
    warn: number;
    info: number;
  };
}

export interface FixResult {
  file: string;
  bakPath: string;
  fixes: Array<{
    line: number;
    original: string;
    fixed: string;
  }>;
}
