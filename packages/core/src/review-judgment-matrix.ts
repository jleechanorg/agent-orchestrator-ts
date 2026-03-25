/**
 * Review judgment policy matrix — classifies review comments as objective
 * (must-fix) vs subjective (nitpick/blocker) to drive reaction policy.
 *
 * Mechanism (2): judgment policy matrix for objective vs subjective comments.
 *
 * Design:
 * - Objective = code is provably wrong or test is missing/broken → must fix
 * - Subjective = style preference, nit, design opinion → optional / low priority
 * - Blocking = security/vuln/breaking change → escalate immediately
 *
 * Classification is fingerprint-based so repeated identical comments don't
 * re-trigger dispatch (works alongside review-backlog.ts dedup).
 */

import type { ReviewComment } from "./types.js";

// ---------------------------------------------------------------------------
// Classification result
// ---------------------------------------------------------------------------

export type CommentClass = "objective" | "subjective" | "blocking" | "unknown";

export interface JudgmentResult {
  class: CommentClass;
  reason: string;
  /** Fingerprint used for dedup — stable hash of class + reason (not body) */
  policyFingerprint: string;
  /** Severity rank: lower = more urgent */
  severityRank: number; // 1=blocking, 2=objective, 3=subjective, 4=unknown
}

export interface CommentBatchJudgment {
  total: number;
  blocking: ReviewComment[];
  objective: ReviewComment[];
  subjective: ReviewComment[];
  unknown: ReviewComment[];
  /** Fingerprint of the full classification set — stable across runs */
  batchFingerprint: string;
}

// ---------------------------------------------------------------------------
// Keyword / pattern classifiers
// ---------------------------------------------------------------------------

/** Patterns that indicate an objective (must-fix) defect. */
const OBJECTIVE_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(is|does|will)\s+not\s+work/i, reason: "explicit broken behaviour" },
  { pattern: /\bfails?\b.*\b(test|assert|expect)/i, reason: "test failure described" },
  { pattern: /\bnpe|null\s*pointer|null\s*reference\b/i, reason: "null-pointer risk" },
  { pattern: /\bmemory\s*leak\b/i, reason: "memory leak" },
  { pattern: /\bcrash(?:es|ed|ing)?\b/i, reason: "crash described" },
  { pattern: /\bsegfault|segmentation\s*fault\b/i, reason: "segfault" },
  { pattern: /\bsecurity\b.*\b(vuln|vulnerability|exploit|injection|xss|csrf)\b/i, reason: "security issue" },
  { pattern: /\b(vuln|vulnerability)\b/i, reason: "security issue" },
  { pattern: /\bmissing\s+test\b/i, reason: "missing test coverage" },
  { pattern: /\bno\s+error\s+handling\b/i, reason: "missing error handling" },
  { pattern: /\bexception\b.*\b(uncaught|unhandled|swallowed)/i, reason: "unhandled exception" },
  { pattern: /\brace\s*condition\b/i, reason: "race condition" },
  { pattern: /\bdeadlock\b/i, reason: "deadlock risk" },
  { pattern: /\b(breaking|break)\s*change\b/i, reason: "breaking change" },
  { pattern: /\bincorrect\b/i, reason: "incorrect behaviour" },
  { pattern: /\bwrong\b/i, reason: "wrong behaviour" },
  { pattern: /\berror\b.*\bhandl(e|ing)\b/i, reason: "error handling missing" },
  { pattern: /\b(sql\s*injection|xss|csrf)\b/i, reason: "injection vulnerability" },
  { pattern: /\bleaks?\s+(information|data|credentials|secrets?)\b/i, reason: "data leak" },
  { pattern: /\b(typo|misspell)\b.*\b(function|method|class|variable|import)\b/i, reason: "identifier typo" },
  { pattern: /\bdead\s*code\b/i, reason: "dead code" },
  { pattern: /\bunreachable\s+code\b/i, reason: "unreachable code" },
  { pattern: /\b(side\s*effect|mutation)\b.*\bwithout\b/i, reason: "undocumented side effect" },
  { pattern: /\blogic\s*(is\s*)?wrong\b/i, reason: "logic error" },
  { pattern: /\bapi\b.*\b(changed|breaking|broken)\b/i, reason: "API compatibility break" },
  { pattern: /\b(panic|panic:)\b/i, reason: "runtime panic" },
];

/** Patterns that indicate a subjective / nitpick comment. */
const SUBJECTIVE_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /^nit[pic]?[\s:]/i, reason: "nitpick prefix" },
  { pattern: /\bnit[\s:]/i, reason: "nit" },
  { pattern: /\b(nitpick|suggestion|prefer|preferred|consider|you\s+might)\b/i, reason: "optional suggestion" },
  { pattern: /\bcould\s+(use|add|change|improve)\b/i, reason: "optional improvement" },
  { pattern: /\boptional\b/i, reason: "optional" },
  { pattern: /\b(style|readability|cleanup)\b.*\b(only)?\b/i, reason: "style/readability only" },
  { pattern: /\b(small|minor|tiny)\s+(change|improvement|suggestion)\b/i, reason: "minor suggestion" },
  { pattern: /\bfeel\s+free\b/i, reason: "optional / non-blocking" },
  { pattern: /\bnon[- ]?blocking\b/i, reason: "non-blocking" },
  { pattern: /\boptional\b/i, reason: "optional" },
  { pattern: /^fyi[:\s]/i, reason: "fyi / informational" },
  { pattern: /\bif\s+you\s+want\b/i, reason: "optional suggestion" },
  { pattern: /\bmight\s+be\s+nice\b/i, reason: "nice-to-have" },
  { pattern: /\bjust\s+a\s+thought\b/i, reason: "optional thought" },
  { pattern: /\[?\[ optional \]\]/i, reason: "optional marker" },
  { pattern: /\bdesign\s+question\b/i, reason: "design question — not blocking" },
  { pattern: /\bhave\s+you\s+considered\b/i, reason: "design consideration" },
];

/** Patterns that indicate a blocking / security issue requiring escalation. */
const BLOCKING_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(security|vuln|vulnerability|exploit)\b/i, reason: "security issue — escalate" },
  { pattern: /\bhardcoded\s+(api\s*key|secret|credential|token|password)/i, reason: "hardcoded credential — escalate" },
  { pattern: /\b(secret|credential|token|password|api\s*key)s?\s+(exposed|leak|hardcoded|commit)/i, reason: "secret exposure" },
  { pattern: /\b(broken|missing)\s+(auth|authentication|authorization|permission)\b/i, reason: "auth broken" },
  { pattern: /\bdata\s*loss\b/i, reason: "data loss risk" },
  { pattern: /\bbreaking\s*production\b/i, reason: "production break risk" },
  { pattern: /\bcritical\s*bug\b/i, reason: "critical bug" },
];

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

/** Classify a single comment body against the policy matrix. */
export function classifyComment(comment: ReviewComment): JudgmentResult {
  const body = comment.body ?? "";
  const trimmed = body.trim();

  // Blocking first (highest priority)
  for (const { pattern, reason } of BLOCKING_PATTERNS) {
    if (pattern.test(trimmed)) {
      return makeResult("blocking", reason, 1);
    }
  }

  // Objective
  for (const { pattern, reason } of OBJECTIVE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return makeResult("objective", reason, 2);
    }
  }

  // Subjective
  for (const { pattern, reason } of SUBJECTIVE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return makeResult("subjective", reason, 3);
    }
  }

  return makeResult("unknown", "no pattern match", 4);
}

function makeResult(
  cls: CommentClass,
  reason: string,
  severityRank: number,
): JudgmentResult {
  const fp = `${cls}:${reason}`;
  return { class: cls, reason, policyFingerprint: fp, severityRank };
}

/** Simple fingerprint from a set of strings (stable sort). */
function makeFingerprint(items: string[]): string {
  return [...items].sort().join(",");
}

// ---------------------------------------------------------------------------
// Batch judgment — classify and group a full comment list
// ---------------------------------------------------------------------------

/**
 * Classify a batch of review comments into buckets.
 * Returns grouped arrays + a stable batch fingerprint for dedup.
 */
export function judgeCommentBatch(comments: ReviewComment[]): CommentBatchJudgment {
  const blocking: ReviewComment[] = [];
  const objective: ReviewComment[] = [];
  const subjective: ReviewComment[] = [];
  const unknown: ReviewComment[] = [];

  for (const comment of comments) {
    const { class: cls } = classifyComment(comment);
    switch (cls) {
      case "blocking":   blocking.push(comment);   break;
      case "objective":  objective.push(comment);  break;
      case "subjective": subjective.push(comment); break;
      case "unknown":    unknown.push(comment);    break;
    }
  }

  // Stable fingerprint of classification membership (not body content)
  const fp = makeFingerprint([
    ...blocking.map((c) => `b:${c.id}`),
    ...objective.map((c) => `o:${c.id}`),
    ...subjective.map((c) => `s:${c.id}`),
    ...unknown.map((c) => `u:${c.id}`),
  ]);

  return { total: comments.length, blocking, objective, subjective, unknown, batchFingerprint: fp };
}

// ---------------------------------------------------------------------------
// Policy helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a batch of comments is "actionable" — i.e. has at least
 * one blocking or objective item that should trigger a fix-push cycle.
 *
 * Used by the stuck-review SLA to decide when to escalate.
 */
export function hasActionableComments(judgment: CommentBatchJudgment): boolean {
  return judgment.blocking.length > 0 || judgment.objective.length > 0;
}

/**
 * Severity score for KPI / ordering.
 * Higher score = more severe batch.
 */
export function batchSeverityScore(judgment: CommentBatchJudgment): number {
  return (
    judgment.blocking.length * 10 +
    judgment.objective.length * 5 +
    judgment.subjective.length * 1 +
    judgment.unknown.length * 0.5
  );
}
