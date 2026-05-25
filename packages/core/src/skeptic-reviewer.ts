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

import { execFile } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Session } from "./types.js";

const execFileAsync = promisify(execFile);

const REQUEST_ID_RE = /<!--\s*skeptic-request-id-([A-Za-z0-9_.:-]+)\s*-->/i;
const HEAD_SHA_MARKER_RE = (sha: string) =>
  new RegExp(`<!--\\s*skeptic-head-sha-${sha}\\s*-->`, "i");
const GATE_TRIGGER_LABEL_RE = /SKEPTIC_(?:GATE|CRON)_TRIGGER/i;

/**
 * Extract the skeptic request-id from a PR's trigger comment.
 *
 * Scans PR comments from `github-actions[bot]` for a trigger comment
 * that contains both the head-sha marker (matching `triggerSha`) and a
 * `<!-- skeptic-request-id-{id} -->` marker. Returns the request-id
 * so it can be passed to `ao skeptic verify --request-id`.
 *
 * This bridges the gap between the CI skeptic-gate workflow (which posts
 * a trigger with request-id) and the lifecycle-worker (which runs the
 * actual skeptic evaluation). Without it, the VERDICT comment lacks the
 * request-id marker and CI always times out.
 */
async function findRequestIdFromComments(
  owner: string,
  repo: string,
  prNumber: number,
  triggerSha: string,
): Promise<string | undefined> {
  try {
    const result = await execFileAsync(
      "gh",
      [
        "api",
        `repos/${owner}/${repo}/issues/${prNumber}/comments`,
        "--jq",
        "[.[] | select(.user.login == \"github-actions[bot]\") | .body]",
      ],
      { timeout: 10_000 },
    );
    const bodies: string[] = JSON.parse(result.stdout.trim() || "[]");
    const headShaRe = HEAD_SHA_MARKER_RE(triggerSha);
    for (const body of bodies) {
      if (!headShaRe.test(body)) continue;
      if (!GATE_TRIGGER_LABEL_RE.test(body)) continue;
      const match = body.match(REQUEST_ID_RE);
      if (match?.[1]) return match[1];
    }
  } catch {
    // Non-fatal: requestId is best-effort
  }
  return undefined;
}

/** Line-anchored VERDICT matcher — accepts VERDICT: PASS, VERDICT: FAIL, or VERDICT: SKIPPED. */
const VERDICT_LINE_RE = /^VERDICT:\s*(PASS|FAIL|SKIPPED)\b/im;

/**
 * Extract the LAST verdict from a string of CLI output.
 *
 * Using the last match instead of the first prevents an early "VERDICT: PASS"
 * line (e.g. from an echoed prompt template) from overriding the actual terminal
 * verdict that the model emits at the end of its output.
 */
function lastVerdictIn(text: string): "PASS" | "FAIL" | "SKIPPED" | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(VERDICT_LINE_RE);
    if (m) return m[1].toUpperCase() as "PASS" | "FAIL" | "SKIPPED";
  }
  return null;
}

export interface SkepticReviewResult {
  verdict: "PASS" | "FAIL" | "SKIPPED";
  details: string;
  modelUsed: string;
  commentId?: number;
  /** Whether specs/skeptic-report.json was written to the workspace */
  reportWritten?: boolean;
}

/** Ordered fallback chain for skeptic LLM evaluation (bd-skp3). */
const FALLBACK_CHAIN: Array<"codex" | "claude" | "gemini" | "cursor"> = ["codex", "claude", "gemini", "cursor"];

// The nested skeptic CLI can spend up to 5 minutes per headless evaluator before
// posting. Keep this wrapper above two-tool fallback time so slow reviews still
// emit verdicts before the GitHub polling wrapper expires.
const SKEPTIC_VERIFY_TIMEOUT_MS = 15 * 60_000;

/**
 * Determine whether a CLI error is an infrastructure failure (ENOBUFS, spawn errors)
 * that warrants fallback to the next model, vs. a legitimate verdict-bearing exit.
 *
 * Returns true if the error produced a VERDICT line in the LAST 20 lines of stdout
 * only (not combined stdout+stderr). Restricting to stdout tail prevents false matches
 * when the CLI echoes prompt templates that contain "VERDICT: PASS" boilerplate.
 * Infrastructure crashes never produce a clean terminal VERDICT line.
 */
function hasVerdictInError(err: unknown): boolean {
  if (err && typeof err === "object" && "stdout" in err) {
    const e = err as { stdout?: string };
    const stdout = e.stdout ?? "";
    // Check only the last 20 lines of stdout. This prevents prompt templates
    // echoed at the START of output from being misread as real verdicts.
    // Infrastructure crashes never produce a clean terminal VERDICT line.
    const tail = stdout.split("\n").slice(-20).join("\n");
    return lastVerdictIn(tail) !== null;
  }
  return false;
}

/**
 * Extract verdict result from a CLI error that has a VERDICT in its output.
 * Only called when hasVerdictInError() returns true.
 *
 * Uses last-20-lines of stdout + lastVerdictIn for consistency with
 * hasVerdictInError: restricts to tail to skip prompt echo, then takes the
 * last matching verdict within the tail to handle multiple verdict lines.
 */
function extractVerdictFromError(
  err: unknown,
  model: string,
): SkepticReviewResult {
  const e = err as { stdout?: string; stderr?: string; code?: number };
  const stdout = e.stdout ?? "";
  const tail = stdout.split("\n").slice(-20).join("\n");
  const verdict: "PASS" | "FAIL" | "SKIPPED" = lastVerdictIn(tail) ?? "FAIL";
  return {
    verdict,
    details: `CLI exited with code ${e.code} but produced verdict: ${stdout.slice(0, 300)}`,
    modelUsed: model,
    reportWritten: false,
  };
}

/**
 * Run a single skeptic evaluation attempt with one specific model.
 *
 * Returns {result, infraFailure} where:
 * - result is the SkepticReviewResult if a verdict was obtained (even from a crashing CLI)
 * - infraFailure is the error message if the model completely failed (no verdict produced)
 *
 * This separation enables the caller to decide whether to fallback to the next model.
 *
 * @param triggerSha - The PR head SHA frozen at the start of this review run. Passing
 *   the same SHA for all attempts ensures all fallbacks evaluate the same commit even
 *   if the PR is force-pushed mid-chain.
 * @param requestId - The request-id from the CI trigger comment. When present,
 *   passed to `ao skeptic verify --request-id` so the VERDICT comment includes
 *   the marker that skeptic-gate.yml polls for.
 */
async function tryModel(
  session: Session,
  model: "codex" | "claude" | "gemini" | "cursor",
  postComment: boolean,
  triggerSha: string | undefined,
  requestId: string | undefined,
  excludePaths?: string[],
): Promise<
  | { result: SkepticReviewResult; infraFailure?: undefined }
  | { result?: undefined; infraFailure: string }
> {
  const prNumber = session.pr!.number;
  const repo = `${session.pr!.owner}/${session.pr!.repo}`;

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
  if (triggerSha) {
    args.push("--trigger-sha", triggerSha);
  }
  if (requestId) {
    args.push("--request-id", requestId);
  }
  if (excludePaths && excludePaths.length > 0) {
    for (const p of excludePaths) {
      args.push("--exclude-paths", p);
    }
  }
  args.push("--model", model);

  let output: string;
  try {
    const execResult = await execFileAsync(aoBinary, args, {
      timeout: SKEPTIC_VERIFY_TIMEOUT_MS,
      cwd: session.workspacePath ?? process.env["AO_REPO_ROOT"] ?? process.cwd(),
    });
    output = execResult.stdout + (execResult.stderr || "");
  } catch (err: unknown) {
    // CLI crashed — check if it still managed to produce a verdict
    if (hasVerdictInError(err)) {
      return { result: extractVerdictFromError(err, model) };
    }
    // No verdict in output → infrastructure failure, eligible for fallback
    const msg = err instanceof Error ? err.message : String(err);
    return { infraFailure: `[${model}] ${msg}` };
  }

  // Parse VERDICT from output — use last occurrence (fail-closed: no VERDICT = FAIL).
  // Last-match ensures the model's terminal verdict wins over any earlier noise lines.
  const verdict: "PASS" | "FAIL" | "SKIPPED" = lastVerdictIn(output) ?? "FAIL";

  return {
    result: {
      verdict,
      details: output.slice(0, 500),
      modelUsed: model,
    },
  };
}

/**
 * Run the skeptic evaluation for a completed worker session.
 *
 * Uses `ao skeptic --pr N --repo owner/repo` with a fallback chain (bd-skp3):
 *   codex → claude → gemini → SKIPPED
 *
 * Each model is tried in order. If a model produces a VERDICT (even FAIL), that
 * verdict is accepted immediately. Only infrastructure failures (ENOBUFS, spawn
 * errors, missing binaries) trigger fallback to the next model.
 *
 * When ALL models fail with infrastructure errors, returns VERDICT: SKIPPED
 * (not FAIL) so the gate doesn't permanently block the PR.
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
    /** Glob patterns for files to exclude from skeptic evaluation */
    excludePaths?: string[];
  } = {},
): Promise<SkepticReviewResult> {
  const { model, postComment = true, excludePaths } = options;

  if (!session.pr) {
    return {
      verdict: "SKIPPED",
      details: "No PR associated with session — cannot run skeptic evaluation",
      modelUsed: model ?? "codex",
    };
  }

  // Freeze the PR head SHA once — all fallback attempts must evaluate the same
  // commit. Re-fetching inside tryModel could return a different SHA if the PR
  // is force-pushed while earlier models are failing over.
  const prNumber = session.pr.number;
  const repo = `${session.pr.owner}/${session.pr.repo}`;
  let triggerSha: string | undefined;
  try {
    const ghResult = await execFileAsync(
      "gh",
      ["api", `repos/${repo}/pulls/${prNumber}`, "--jq", ".head.sha"],
      { timeout: 10_000 },
    );
    const candidate = (ghResult.stdout ?? "").trim();
    if (/^[0-9a-f]{40}$/i.test(candidate)) {
      triggerSha = candidate;
    }
  } catch {
    // Non-fatal: triggerSha is best-effort
  }

  // Resolve the request-id from the CI trigger comment so the VERDICT
  // comment carries the marker that skeptic-gate.yml polls for.
  let requestId: string | undefined;
  if (triggerSha) {
    requestId = await findRequestIdFromComments(
      session.pr.owner,
      session.pr.repo,
      prNumber,
      triggerSha,
    );
  }

  // Build the model chain: if a specific model is requested, start from that
  // model's position in the chain. Default starts from codex (index 0).
  const startIdx = model ? FALLBACK_CHAIN.indexOf(model) : 0;
  const chain = FALLBACK_CHAIN.slice(startIdx >= 0 ? startIdx : 0);

  const infraErrors: string[] = [];

  for (const currentModel of chain) {
    const attempt = await tryModel(session, currentModel, postComment, triggerSha, requestId, excludePaths);

    if (attempt.result) {
      // Got a verdict — write report and return
      const result = attempt.result;
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
              prNumber: session.pr.number,
              repo: `${session.pr.owner}/${session.pr.repo}`,
              verdict: result.verdict,
              details: result.details,
              modelUsed: result.modelUsed,
              fallbacksAttempted: infraErrors.length,
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

      return { ...result, reportWritten };
    }

    // Infrastructure failure — log and try next model
    infraErrors.push(attempt.infraFailure);
  }

  // All models in the chain failed with infra errors → SKIPPED (not FAIL)
  return {
    verdict: "SKIPPED",
    details: `All models failed with infrastructure errors: ${infraErrors.join("; ").slice(0, 400)}`,
    modelUsed: chain.join(","),
  };
}
