/**
 * Skeptic Reviewer — AO reaction for worker-signals-completion (bd-skp2).
 *
 * When a worker session signals completion (READY_FOR_CHECK, task complete, PR created),
 * this module runs the skeptic evaluation against the worker's workspace WITHOUT spawning
 * a new worktree. Instead, it calls `ao skeptic verify --pr N --repo owner/repo` which:
 *
 * 1. Reads the worker's existing worktree (read-only access to specs/exit-criteria.md)
 * 2. Fetches the PR diff via GitHub API
 * 3. Runs skeptic evaluation using Codex CLI (codex --print) or Claude CLI fallback
 * 4. Posts VERDICT comment on the PR
 * 5. Writes specs/skeptic-report.json with per-criterion verdicts
 *
 * Design constraints:
 * - Skeptic does NOT spawn its own worktree — it evaluates EXISTING worker output
 * - Cross-model: if coding agent used Claude, skeptic uses Codex (or vice versa)
 * - Inverted incentive: "Your score is measured by gaps found. A false PASS is YOUR failure."
 */

import { exec, execFile } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Session } from "./types.js";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

/** Line-anchored VERDICT matcher — only accepts a single-line literal "VERDICT: PASS" or "VERDICT: FAIL". */
const VERDICT_LINE_RE = /^VERDICT:\s*(PASS|FAIL)\s*$/im;

export interface SkepticReviewResult {
  verdict: "PASS" | "FAIL" | "SKIPPED";
  details: string;
  modelUsed: string;
  commentId?: number;
  /** Whether specs/skeptic-report.json was written to the workspace */
  reportWritten?: boolean;
}

/**
 * Run the skeptic evaluation for a completed worker session.
 *
 * Uses `ao skeptic --pr N --repo owner/repo` which internally:
 * - Calls modelRunner (Codex primary, Claude fallback)
 * - Posts a VERDICT comment on the PR
 * - Writes specs/skeptic-report.json in the worker's workspace
 *
 * @param session - The worker session that signaled completion
 * @param options - Override options (model to use, whether to post comment)
 */
export async function runSkepticReview(
  session: Session,
  options: {
    /** Alternate model for skeptic evaluation */
    model?: "codex" | "claude" | "gemini";
    /** Whether to post the VERDICT comment on the PR (default: true) */
    postComment?: boolean;
  } = {},
): Promise<SkepticReviewResult> {
  const { model = "codex", postComment = true } = options;

  if (!session.pr) {
    return {
      verdict: "SKIPPED",
      details: "No PR associated with session — cannot run skeptic evaluation",
      modelUsed: model,
    };
  }

  // workspacePath is optional — the ao skeptic verify CLI only needs GitHub API access.
  // If not set, cwd falls back to process.cwd() or AO_REPO_ROOT.
  // The workspace is only used for writing specs/skeptic-report.json (non-critical).

  const prNumber = session.pr.number;
  const repo = `${session.pr.owner}/${session.pr.repo}`;

  // Fetch the current PR head SHA so the VERDICT comment can be matched by the
  // skeptic-gate workflow. This enables the workflow to bind verdicts to the
  // exact evaluation window and reject stale verdicts from cancelled runs.
  let triggerSha: string | undefined;
  try {
    const ghResult = await execAsync(
      "gh",
      ["api", `repos/${repo}/pulls/${prNumber}`, "--jq", ".head.sha"],
      { timeout: 10_000 },
    );
    triggerSha = (ghResult.stdout ?? ghResult.stderr ?? "").trim();
  } catch {
    // Non-fatal: triggerSha is best-effort; workflow still has timestamp filter
  }

  // Run `ao skeptic verify --pr N --repo owner/repo` — the CLI handles all GitHub
  // API calls, model invocation, and posting the VERDICT comment.
  // AO_CLI_PATH env var overrides the CLI binary (for testing or custom installs).
  // AO_REPO_ROOT env var overrides the working directory.
  const aoBinary = process.env["AO_CLI_PATH"] ?? "ao";
  const args: string[] = [
    "skeptic",
    "verify",
    "--pr",
    String(prNumber),
    "--repo",
    repo,
  ];
  if (!postComment) args.push("--dry-run");
  if (triggerSha) args.push("--trigger-sha", triggerSha);
  args.push("--model", model);

  let output: string;
  try {
    const result = await execFileAsync(aoBinary, args, {
      timeout: 120_000,
      cwd: session.workspacePath ?? process.env["AO_REPO_ROOT"] ?? process.cwd(),
    });
    output = result.stdout + (result.stderr || "");
  } catch (err: unknown) {
    if (err && typeof err === "object" && "stdout" in err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      output = (e.stdout ?? "") + (e.stderr ?? "");
      return {
        verdict: "FAIL",
        details: `Skeptic CLI exited with code ${e.code}: ${output.slice(0, 300)}`,
        modelUsed: model,
        reportWritten: false,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      verdict: "FAIL",
      details: `Skeptic CLI failed to run: ${msg}`,
      modelUsed: model,
    };
  }

  // Parse VERDICT from output — fail-closed: no VERDICT = FAIL
  const verdictMatch = output.match(VERDICT_LINE_RE);
  const verdict: "PASS" | "FAIL" = verdictMatch
    ? (verdictMatch[1].toUpperCase() as "PASS" | "FAIL")
    : "FAIL";

  // Write skeptic-report.json to the worker's workspace
  let reportWritten = false;
  try {
    if (!session.workspacePath) throw new Error("workspacePath not set");
    const reportDir = join(session.workspacePath, "specs");
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      join(reportDir, "skeptic-report.json"),
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          sessionId: session.id,
          prNumber,
          repo,
          verdict,
          details: output.slice(0, 2000),
          modelUsed: model,
          rawOutput: output,
        },
        null,
        2,
      ),
      "utf-8",
    );
    reportWritten = true;
  } catch {
    // Non-fatal — don't fail the reaction if report write fails
  }

  return {
    verdict,
    details: output.slice(0, 500),
    modelUsed: model,
    reportWritten,
  };
}
