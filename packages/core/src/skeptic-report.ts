/**
 * Skeptic Report — Parser and Verdict Logic (bd-qw6)
 *
 * Parses the `specs/skeptic-report.json` output from a Skeptic Agent session,
 * computes overall verdicts, and builds feedback messages for injection into
 * the coding agent's next prompt when criteria fail.
 *
 * Design: docs/design/skeptic-agent-verifier.md
 */

/** Valid verdict values for a single criterion. */
export type CriterionVerdictValue = "PASS" | "FAIL" | "INSUFFICIENT" | "NOT_ATTEMPTED";

/** Valid overall verdict values for the full report. */
export type OverallVerdict = "PASS" | "FAIL" | "INSUFFICIENT";

const VALID_VERDICTS = new Set<string>(["PASS", "FAIL", "INSUFFICIENT", "NOT_ATTEMPTED"]);
const VALID_OVERALL_VERDICTS = new Set<string>(["PASS", "FAIL", "INSUFFICIENT"]);

/** A single criterion evaluation from the Skeptic. */
export interface CriterionVerdict {
  /** Verbatim criterion text from exit-criteria.md */
  criterion: string;
  /** Exact command the Skeptic ran, or null if not run */
  commandRun: string | null;
  /** Full output from the command, or null if not run */
  rawOutput: string | null;
  /** The Skeptic's verdict */
  verdict: CriterionVerdictValue;
  /** One-sentence explanation */
  reason: string;
}

/** The full Skeptic report written to specs/skeptic-report.json. */
export interface SkepticReport {
  criteria: CriterionVerdict[];
  overallVerdict: OverallVerdict;
  timestamp: string;
}

/**
 * Compute the overall verdict from a list of criterion verdicts.
 *
 * Rules:
 * - PASS: ALL criteria have verdict PASS
 * - FAIL: ANY criterion has verdict FAIL
 * - INSUFFICIENT: No FAIL, but at least one is INSUFFICIENT or NOT_ATTEMPTED
 * - Empty list → INSUFFICIENT (no evidence = insufficient)
 */
export function computeOverallVerdict(criteria: CriterionVerdict[]): OverallVerdict {
  if (criteria.length === 0) {
    return "INSUFFICIENT";
  }

  let hasFail = false;
  let hasInsufficient = false;

  for (const c of criteria) {
    if (c.verdict === "FAIL") {
      hasFail = true;
    }
    if (c.verdict === "INSUFFICIENT" || c.verdict === "NOT_ATTEMPTED") {
      hasInsufficient = true;
    }
  }

  if (hasFail) return "FAIL";
  if (hasInsufficient) return "INSUFFICIENT";
  return "PASS";
}

/**
 * Parse and validate a Skeptic report from JSON string.
 *
 * Validates:
 * - JSON syntax
 * - Required `criteria` array
 * - Each criterion has valid verdict value
 * - Each criterion has required fields
 */
export function parseSkepticReport(jsonString: string): SkepticReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    throw new Error(
      `Failed to parse skeptic report JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Skeptic report must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj["criteria"])) {
    throw new Error("Skeptic report missing required 'criteria' array");
  }

  const criteria: CriterionVerdict[] = [];
  for (const item of obj["criteria"] as unknown[]) {
    if (!item || typeof item !== "object") {
      throw new Error("Each criterion must be a JSON object");
    }
    const c = item as Record<string, unknown>;

    const verdict = String(c["verdict"] ?? "");
    if (!VALID_VERDICTS.has(verdict)) {
      throw new Error(
        `Invalid criterion verdict "${verdict}". Must be one of: ${[...VALID_VERDICTS].join(", ")}`,
      );
    }

    criteria.push({
      criterion: String(c["criterion"] ?? ""),
      commandRun: c["commandRun"] === null || c["commandRun"] === undefined
        ? null
        : String(c["commandRun"]),
      rawOutput: c["rawOutput"] === null || c["rawOutput"] === undefined
        ? null
        : String(c["rawOutput"]),
      verdict: verdict as CriterionVerdictValue,
      reason: String(c["reason"] ?? ""),
    });
  }

  const overallVerdict = String(obj["overallVerdict"] ?? "");
  if (!VALID_OVERALL_VERDICTS.has(overallVerdict)) {
    throw new Error(
      `Invalid overall verdict "${overallVerdict}". Must be one of: ${[...VALID_OVERALL_VERDICTS].join(", ")}`,
    );
  }

  return {
    criteria,
    overallVerdict: overallVerdict as OverallVerdict,
    timestamp: String(obj["timestamp"] ?? new Date().toISOString()),
  };
}

/**
 * Build a feedback message from a Skeptic report for injection into the
 * coding agent's next prompt.
 *
 * When the Skeptic finds gaps, the orchestrator injects this message so the
 * coder sees exactly what needs fixing. The coder CANNOT argue with the
 * Skeptic directly — this prevents rationalization.
 */
export function buildFeedbackMessage(report: SkepticReport): string {
  const sections: string[] = [];

  sections.push(`## Skeptic Agent Evaluation — ${report.overallVerdict}`);

  if (report.overallVerdict === "PASS") {
    sections.push("All exit criteria validated. The Skeptic Agent independently confirmed your work meets the requirements.");
    return sections.join("\n\n");
  }

  sections.push("The Skeptic Agent independently evaluated your work and found issues:");

  const failedCriteria = report.criteria.filter(
    (c) => c.verdict === "FAIL" || c.verdict === "INSUFFICIENT" || c.verdict === "NOT_ATTEMPTED",
  );

  for (const c of failedCriteria) {
    const lines: string[] = [];
    lines.push(`### ${c.verdict}: ${c.criterion}`);
    lines.push(`**Reason:** ${c.reason}`);
    if (c.commandRun) {
      lines.push(`**Command run:** \`${c.commandRun}\``);
    }
    if (c.rawOutput) {
      const truncated = c.rawOutput.length > 500
        ? c.rawOutput.slice(0, 500) + "\n... (truncated)"
        : c.rawOutput;
      lines.push(`**Output:**\n\`\`\`\n${truncated}\n\`\`\``);
    }
    sections.push(lines.join("\n"));
  }

  sections.push("Fix the issues above and signal READY_FOR_CHECK when done. The Skeptic will re-evaluate.");

  return sections.join("\n\n");
}
