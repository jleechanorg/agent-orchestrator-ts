/**
 * Prose pattern detectors.
 */

import type { ProseMatch, ScanResult, Severity } from "./types.js";

// --- Configuration constants ---

const NOT_X_THRESHOLD = 3;
const PROXIMITY_WINDOW = 10;

const FILLERS = [
  "literally", "basically", "simply", "actually", "obviously",
  "clearly", "totally", "completely", "absolutely", "utterly",
  "really", "truly", "just", "quite", "somehow",
];

const WEAK_OPENINGS = [
  /^there\s(is|are|was|were)\b/i,
  /^it\s(is|was)\b/i,
  /^this\s(is|was)\b/i,
  /^there\shave\sbeen/i,
  /^there\swill\sbe/i,
];

const REDUNDANT_PHRASES: Array<[RegExp, string]> = [
  [/\bvery\sunique\b/gi, "unique (remove 'very')"],
  [/\bvery\sspecial\b/gi, "special (remove 'very')"],
  [/\bfree\sgift\b/gi, "gift (remove 'free')"],
  [/\bpast\shistory\b/gi, "history (remove 'past')"],
  [/\bfuture\splans\b/gi, "plans (remove 'future')"],
  [/\bcompletely\seliminate\b/gi, "eliminate (remove 'completely')"],
  [/\bunexpected\ssurprise\b/gi, "surprise (remove 'unexpected')"],
  [/\bblatantly\sobvious\b/gi, "obvious (remove 'blatantly')"],
];

const WEASEL_WORDS = [
  "many", "some", "various", "a lot of", "lots of",
  "several", "few", "almost", "nearly", "practically",
  "kind of", "sort of", "somewhat",
];

const RULE_DESCRIPTIONS: Record<string, string> = {
  "not-x-repetition": "3+ 'Not X.' lines found — repetition dilutes impact",
  "forced-rule-of-3": "Structurally identical triplets near each other",
  "weak-sentence-opening": "Weak opening: 'There is', 'It is', 'This is'",
  "filler-word": "Filler word dilutes prose",
  "redundant-phrase": "Redundant phrase",
  "weasel-word": "Vague quantifier",
  "repeated-sentence-starters": "Same first word in 3+ consecutive lines",
  "proximity-repetition": "Same content word 3+ times within 10-line window",
};

/**
 * Tokenize text into words (lowercased, alpha-only).
 */
function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/\b[a-z]+\b/g) ?? [];
}

/**
 * Strip stopwords to get content words.
 */
const STOPWORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for",
  "of","with","by","from","is","was","are","were","be","been",
  "being","have","has","had","do","does","did","will","would",
  "could","should","may","might","must","shall","can","this",
  "that","these","those","i","you","he","she","it","we","they",
  "my","your","his","her","its","our","their","what","which",
  "who","whom","when","where","why","how","all","each","every",
  "both","few","more","most","other","some","such","no","nor",
  "not","only","own","same","so","than","too","very","just",
]);

function contentWords(text: string): string[] {
  return wordsOf(text).filter(w => w.length > 3 && !STOPWORDS.has(w));
}

/**
 * Detect Not-X repetition: 3+ lines matching "Not X."
 */
export function detectNotXRepetition(
  lines: string[],
  threshold = NOT_X_THRESHOLD
): ProseMatch[] {
  const matches: ProseMatch[] = [];
  const notXLines: Array<{ line: number; text: string; phrase: string }> = [];

  const notXPattern = /^not[\s-]+([a-z][a-z\s-]{0,30})\.?$/i;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(notXPattern);
    if (m) {
      notXLines.push({ line: i + 1, text: lines[i].trim(), phrase: m[1].trim() });
    }
  }

  if (notXLines.length >= threshold) {
    for (const { line, text, phrase } of notXLines) {
      matches.push({
        rule: "not-x-repetition",
        category: "not-x-repetition",
        line,
        text,
        message: `"Not ${phrase}." — repetition dilutes impact`,
        severity: "warn",
        autoFixable: false,
        suggestion: "Consider varying phrasing or combining into one assertion",
      });
    }
  }

  return matches;
}

/**
 * Detect forced Rule of 3s: structurally identical triplets.
 */
export function detectForcedRuleOf3(lines: string[]): ProseMatch[] {
  const matches: ProseMatch[] = [];

  for (let i = 0; i < lines.length - 2; i++) {
    const [a, b, c] = lines.slice(i, i + 3).map(l => l.trim()).filter(l => l.length > 0);
    if (!a || !b || !c) continue;

    // Structural fingerprint: first word + last word + word count bucket
    const fp = (s: string) =>
      `${s.split(/\s+/)[0].toLowerCase()}|${
        s.split(/\s+/).pop()?.toLowerCase() ?? ""
      }|${Math.floor(s.split(/\s+/).length / 5)}`;

    if (fp(a) === fp(b) && fp(b) === fp(c)) {
      matches.push({
        rule: "forced-rule-of-3",
        category: "forced-rule-of-3",
        line: i + 1,
        text: [a, b, c].join(" | "),
        message: "Structurally identical triplet — forced Rule of 3",
        severity: "info",
        autoFixable: false,
      });
    }
  }

  return matches;
}

/**
 * Detect weak sentence openings.
 */
export function detectWeakOpenings(lines: string[]): ProseMatch[] {
  const matches: ProseMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    for (const pattern of WEAK_OPENINGS) {
      if (pattern.test(trimmed)) {
        matches.push({
          rule: "weak-sentence-opening",
          category: "weak-sentence-opening",
          line: i + 1,
          text: trimmed,
          message: `Weak opening: "${trimmed.slice(0, 40)}…" — prefer active subject-verb`,
          severity: "info",
          autoFixable: false,
        });
        break;
      }
    }
  }

  return matches;
}

/**
 * Detect filler words.
 */
export function detectFillers(lines: string[]): ProseMatch[] {
  const matches: ProseMatch[] = [];
  const fillerRE = new RegExp(`\\b(${FILLERS.join("|")})\\b`, "gi");

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const found = trimmed.match(fillerRE);
    if (found) {
      matches.push({
        rule: "filler-word",
        category: "filler-word",
        line: i + 1,
        text: trimmed,
        message: `Filler word "${found[0]}" dilutes prose`,
        severity: "info",
        autoFixable: true,
        suggestion: `Remove "${found[0]}"`,
      });
    }
  }

  return matches;
}

/**
 * Detect redundant phrases.
 */
export function detectRedundantPhrases(lines: string[]): ProseMatch[] {
  const matches: ProseMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    for (const [pattern, suggestion] of REDUNDANT_PHRASES) {
      pattern.lastIndex = 0;
      if (pattern.test(trimmed)) {
        matches.push({
          rule: "redundant-phrase",
          category: "redundant-phrase",
          line: i + 1,
          text: trimmed,
          message: `Redundant phrase — ${suggestion}`,
          severity: "warn",
          autoFixable: true,
          suggestion,
        });
        break;
      }
    }
  }

  return matches;
}

/**
 * Detect weasel words.
 */
export function detectWeaselWords(lines: string[]): ProseMatch[] {
  const matches: ProseMatch[] = [];
  const weaselRE = new RegExp(`\\b(${WEASEL_WORDS.join("|")})\\b`, "gi");

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const found = trimmed.match(weaselRE);
    if (found) {
      matches.push({
        rule: "weasel-word",
        category: "weasel-word",
        line: i + 1,
        text: trimmed,
        message: `Weasel word "${found[0]}" — be more specific`,
        severity: "info",
        autoFixable: false,
      });
    }
  }

  return matches;
}

/**
 * Detect repeated sentence starters (same first word in 3+ consecutive lines).
 */
export function detectRepeatedStarters(lines: string[]): ProseMatch[] {
  const matches: ProseMatch[] = [];

  for (let i = 0; i < lines.length - 2; i++) {
    const trio = lines.slice(i, i + 3).map(l => {
      const t = l.trim();
      return t.split(/\s+/)[0].toLowerCase();
    });

    if (trio[0] && trio[0] === trio[1] && trio[1] === trio[2]) {
      matches.push({
        rule: "repeated-sentence-starters",
        category: "repeated-sentence-starters",
        line: i + 1,
        text: lines.slice(i, i + 3).join(" | "),
        message: `Repeated starter "${trio[0]}" in 3+ consecutive lines`,
        severity: "warn",
        autoFixable: false,
      });
    }
  }

  return matches;
}

/**
 * Detect proximity repetition: same content word 3+ times within window.
 */
export function detectProximityRepetition(
  lines: string[],
  windowSize = PROXIMITY_WINDOW
): ProseMatch[] {
  const matches: ProseMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const windowLines = lines.slice(i, Math.min(i + windowSize, lines.length));
    const contentByLine = windowLines.map(contentWords);
    const flat = contentByLine.flat();
    const freq = new Map<string, number>();
    for (const w of flat) freq.set(w, (freq.get(w) ?? 0) + 1);

    for (const [word, count] of freq) {
      if (count >= 3) {
        matches.push({
          rule: "proximity-repetition",
          category: "proximity-repetition",
          line: i + 1,
          text: lines[i]?.trim() ?? "",
          message: `Word "${word}" appears ${count}x within ${windowSize}-line window`,
          severity: "info",
          autoFixable: false,
        });
        break;
      }
    }
  }

  return matches;
}

/**
 * Scan all patterns over file lines.
 */
export function detectAllPatterns(
  lines: string[],
  minSeverity: Severity = "info"
): ProseMatch[] {
  const all: ProseMatch[] = [
    ...detectNotXRepetition(lines),
    ...detectForcedRuleOf3(lines),
    ...detectWeakOpenings(lines),
    ...detectFillers(lines),
    ...detectRedundantPhrases(lines),
    ...detectWeaselWords(lines),
    ...detectRepeatedStarters(lines),
    ...detectProximityRepetition(lines),
  ];

  const severityOrder: Severity[] = ["info", "warn", "critical"];
  const minIdx = severityOrder.indexOf(minSeverity);

  return all.filter(m => severityOrder.indexOf(m.severity) >= minIdx);
}

/**
 * Full scan result.
 */
export function scanLines(filename: string, lines: string[], minSeverity: Severity = "info"): ScanResult {
  const issues = detectAllPatterns(lines, minSeverity);
  return {
    file: filename,
    totalLines: lines.length,
    issues,
    summary: {
      critical: issues.filter(i => i.severity === "critical").length,
      warn: issues.filter(i => i.severity === "warn").length,
      info: issues.filter(i => i.severity === "info").length,
    },
  };
}

export { RULE_DESCRIPTIONS };
