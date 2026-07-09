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
import { isConfigNotFoundError, type Session, type ReviewerConfig } from "./types.js";
import { type SkepticModel } from "./skeptic-model-schema.js";
import { resolveSkepticModel } from "./skeptic-models.js";
import { getGhBinaryPath } from "./paths.js";
import { loadConfig } from "./config.js";

const execFileAsync = promisify(execFile);

const REQUEST_ID_RE = /<!--\s*skeptic-request-id-([A-Za-z0-9_.:-]+)\s*-->/i;
const HEAD_SHA_MARKER_RE = (sha: string) =>
  new RegExp(`<!--\\s*skeptic-head-sha-${sha}\\s*-->`, "i");
const GATE_TRIGGER_LABEL_RE = /SKEPTIC_(?:GATE|CRON)_TRIGGER/i;
const GATE_TRIGGER_MARKER_RE = (sha: string) =>
  new RegExp(`<!--\\s*skeptic-(?:gate|cron)-trigger-${sha}\\s*-->`, "i");

interface GhComment {
  body?: string;
  user?: { login?: string };
}

/**
 * Extract the skeptic request-id from a PR's trigger comment.
 *
 * Scans PR comments from `github-actions[bot]` for a trigger comment
 * that contains both the head-sha marker (matching `triggerSha`) and a
 * `<!-- skeptic-request-id-{id} -->` marker. Returns the request-id
 * so it can be passed to `ao skeptic verify --request-id`.
 *
 * Uses `--paginate --slurp` to fetch all comment pages (not just page 1),
 * iterates in reverse order (newest-first) to pick the latest matching
 * trigger for the current gate run, and checks for the trigger-type
 * marker (`skeptic-gate-trigger-{sha}` or `skeptic-cron-trigger-{sha}`)
 * to avoid binding a stale or ambiguous request-id.
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
      getGhBinaryPath(),
      [
        "api",
        `repos/${owner}/${repo}/issues/${prNumber}/comments`,
        "--paginate",
        "--slurp",
      ],
      { timeout: 30_000 },
    );
    const pages: GhComment[][] = JSON.parse(result.stdout);
    const comments = pages.flat();
    const headShaRe = HEAD_SHA_MARKER_RE(triggerSha);
    const triggerMarkerRe = GATE_TRIGGER_MARKER_RE(triggerSha);
    let latestRequestId: string | undefined;
    for (const comment of comments) {
      if (comment.user?.login?.toLowerCase() !== "github-actions[bot]") continue;
      const body = comment.body ?? "";
      if (!headShaRe.test(body)) continue;
      if (!GATE_TRIGGER_LABEL_RE.test(body)) continue;
      if (!triggerMarkerRe.test(body)) continue;
      const match = body.match(REQUEST_ID_RE);
      if (match?.[1]) latestRequestId = match[1];
    }
    return latestRequestId;
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



// The nested skeptic CLI can spend up to 5 minutes per headless evaluator before
// posting. Keep this wrapper above two-tool fallback time so slow reviews still
// emit verdicts before the GitHub polling wrapper expires.
const SKEPTIC_VERIFY_TIMEOUT_MS = 30 * 60_000;

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
  model: SkepticModel,
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
 * Run a custom reviewer command using the shell harness.
 */
async function runCustomReviewer(
  session: Session,
  reviewer: ReviewerConfig,
  triggerSha: string | undefined,
  requestId: string | undefined,
  postComment: boolean,
): Promise<SkepticReviewResult> {
  if (reviewer.harness !== "shell") {
    throw new Error(`Unsupported reviewer harness: ${reviewer.harness}`);
  }

  const rawCmd = reviewer.cmd ?? [];
  if (rawCmd.length === 0) {
    throw new Error("Empty command for custom reviewer");
  }

  const prNumber = session.pr!.number;
  const repo = `${session.pr!.owner}/${session.pr!.repo}`;

  let cmdArgs = rawCmd.map((arg) => {
    let replaced = arg;
    replaced = replaced.replace(/\{pr_number\}/g, String(prNumber));
    replaced = replaced.replace(/\{repo\}/g, repo);
    if (triggerSha) {
      replaced = replaced.replace(/\{trigger_sha\}/g, triggerSha);
      replaced = replaced.replace(/\{head_sha\}/g, triggerSha);
    } else {
      replaced = replaced.replace(/\{trigger_sha\}/g, "");
      replaced = replaced.replace(/\{head_sha\}/g, "");
    }
    if (requestId) {
      replaced = replaced.replace(/\{request_id\}/g, requestId);
    } else {
      replaced = replaced.replace(/\{request_id\}/g, "");
    }
    replaced = replaced.replace(/\{dry_run\}/g, postComment ? "" : "--dry-run");
    return replaced;
  });

  // Filter out arguments resulting from empty optional placeholders
  cmdArgs = cmdArgs.filter((arg, index) => {
    const original = rawCmd[index];
    if (original === "{dry_run}" && arg === "") return false;
    if (original === "{trigger_sha}" && arg === "") return false;
    if (original === "{head_sha}" && arg === "") return false;
    if (original === "{request_id}" && arg === "") return false;
    return true;
  });

  // If dry-run, auto-append --dry-run for skeptic verify commands
  if (!postComment) {
    const runsSkepticVerify = cmdArgs.includes("skeptic") && cmdArgs.includes("verify");
    if (runsSkepticVerify && !cmdArgs.includes("--dry-run")) {
      cmdArgs.push("--dry-run");
    }
  }

  let binary = cmdArgs[0];
  const args = cmdArgs.slice(1);

  if (binary === "ao") {
    binary = process.env["AO_CLI_PATH"] ?? "ao";
  }

  const env = {
    ...process.env,
    ...(reviewer.env || {}),
  };

  const cwd = session.workspacePath ?? process.env["AO_REPO_ROOT"] ?? process.cwd();

  const modelName = `shell:${cmdArgs.slice(0, 3).join(" ")}`;

  let output: string;
  try {
    const execResult = await execFileAsync(binary, args, {
      timeout: SKEPTIC_VERIFY_TIMEOUT_MS,
      cwd,
      env,
    });
    output = execResult.stdout + (execResult.stderr || "");
  } catch (err: unknown) {
    if (hasVerdictInError(err)) {
      return extractVerdictFromError(err, modelName);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Reviewer command failed: ${msg}`, { cause: err });
  }

  const verdict: "PASS" | "FAIL" | "SKIPPED" = lastVerdictIn(output) ?? "FAIL";

  return {
    verdict,
    details: output.slice(0, 500),
    modelUsed: modelName,
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
    /** Model(s) for skeptic evaluation; a list defines an explicit ordered chain. */
    model?: SkepticModel | SkepticModel[];
    /** Whether to post the VERDICT comment on the PR (default: true) */
    postComment?: boolean;
    /** Glob patterns for files to exclude from skeptic evaluation */
    excludePaths?: string[];
  } = {},
): Promise<SkepticReviewResult> {
  const { model, postComment = true, excludePaths } = options;

  const { validatedModel, chain } = resolveSkepticModel(model);

  if (!session.pr) {
    return {
      verdict: "SKIPPED",
      details: "No PR associated with session — cannot run skeptic evaluation",
      modelUsed: (Array.isArray(validatedModel) ? validatedModel[0] : validatedModel) ?? "codex",
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
      getGhBinaryPath(),
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

  // Check if project has custom reviewers configured.
  let reviewers: ReviewerConfig[] | undefined;
  try {
    const config = loadConfig();
    const project = config.projects[session.projectId];
    if (project?.reviewers && project.reviewers.length > 0) {
      reviewers = project.reviewers;
    }
  } catch (err: unknown) {
    if (!isConfigNotFoundError(err)) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Skeptic custom reviewer configuration error: ${errorMsg}`);

      const result: SkepticReviewResult = {
        verdict: "FAIL",
        details: `Configuration loading error: ${errorMsg}`,
        modelUsed: "config:loadConfig",
      };

      let reportWritten = false;
      try {
        if (!session.workspacePath) throw new Error("workspacePath not set", { cause: err });
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
            },
            null,
            2,
          ),
          "utf-8",
        );
        reportWritten = true;
      } catch {
        // Non-fatal
      }

      return { ...result, reportWritten };
    }
  }

  if (reviewers && reviewers.length > 0) {
    const reviewerResults: SkepticReviewResult[] = [];
    const reviewerErrors: string[] = [];

    for (const reviewer of reviewers) {
      try {
        const res = await runCustomReviewer(session, reviewer, triggerSha, requestId, postComment);
        reviewerResults.push(res);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        reviewerErrors.push(msg);
        reviewerResults.push({
          verdict: "FAIL",
          details: `Infrastructure error: ${msg}`,
          modelUsed: reviewer.harness,
        });
      }
    }

    const hasFail = reviewerResults.some((r) => r.verdict === "FAIL") || reviewerErrors.length > 0;
    const hasSkipped = reviewerResults.some((r) => r.verdict === "SKIPPED");
    const overallVerdict = hasFail ? "FAIL" : hasSkipped ? "SKIPPED" : "PASS";

    const overallDetails = reviewerResults
      .map((r, i) => `Reviewer ${i + 1} (${r.modelUsed}): ${r.verdict} — ${r.details.slice(0, 150)}`)
      .join("\n\n");
    const overallModelUsed = reviewerResults.map((r) => r.modelUsed).join(", ");

    const result: SkepticReviewResult = {
      verdict: overallVerdict,
      details: overallDetails,
      modelUsed: overallModelUsed,
    };

    // Write report
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
            reviewerResults,
            reviewerErrors,
          },
          null,
          2,
        ),
        "utf-8",
      );
      reportWritten = true;
    } catch {
      // Non-fatal
    }

    return { ...result, reportWritten };
  }

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
