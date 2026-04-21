/**
 * Skeptic Agent — Independent Exit Criteria Verifier (bd-qw6)
 *
 * CLI: ao skeptic --pr <number> [--repo owner/repo] [--dry-run]
 *
 * Fetches PR state (CI, CR review, comments), runs a skeptical LLM evaluation,
 * and posts a VERDICT comment back on the PR.
 *
 * The skeptic verdict is idempotent — re-running updates the same comment.
 * The bot author is configured via GH_SKEPTIC_BOT_AUTHOR env var
 * (default: github-actions[bot]).
 */

import chalk from "chalk";
import { minimatch } from "minimatch";
import ora from "ora";
import type { Command } from "commander";
import { exec } from "../lib/shell.js";
import { fetchPRMeta, fetchReviews, fetchDiff, fetchIssueComments, fetchDesignDoc } from "./skeptic/gh-client.js";
import { fetchMergeGateState } from "./skeptic/mergeGate.js";
import { buildSkepticPrompt } from "./skeptic/prompt.js";
import { runSkepticEvaluation } from "./skeptic/modelRunner.js";
import { postVerdict, type SkepticVerdictBinding } from "./skeptic/posting.js";
import { verifySkepticClaim, formatClaimVerification } from "./skeptic/claim-verifier.js";
import { bindVerdictOutput, VERDICT_LINE_RE } from "./skeptic/verdict-utils.js";
export { VERDICT_LINE_RE };

// bd-lg7i: Default to github-actions[bot] — CI workflow poller filters by this
// author, and CLI posts via gh api authenticated as the local user. Override via
// GH_SKEPTIC_BOT_AUTHOR env var if posting identity changes.
const SKEPTIC_BOT_AUTHOR =
  process.env["GH_SKEPTIC_BOT_AUTHOR"] ?? "github-actions[bot]";

/** Extract file paths from a unified diff string.
 *
 * Handles three unified diff formats:
 * - Standard:   --- a/foo.js and +++ b/foo.js
 * - git diff:    diff --git a/foo.js b/foo.js  (shown by git for binary/renamed files)
 * - git status: rename/copy without content diffs (no header lines)
 */
function extractFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    // Standard unified diff header: --- a/foo.js or +++ b/foo.js
    const m1 = line.match(/^[+-]{3}[ \t][ab]\/(.+)$/);
    if (m1) {
      files.add(m1[1]);
      continue;
    }
    // git diff --git header: diff --git a/foo.js b/foo.js
    const m2 = line.match(/^diff --git [ab]\/(.+?) [ab]\/(.+)$/);
    if (m2) {
      files.add(m2[2]);
      continue;
    }
    // Binary file indicator: Binary files a/foo and b/foo differ
    const m3 = line.match(/^Binary files [ab]\/(.+) and [ab]\/(.+) differ$/);
    if (m3) {
      files.add(m3[2]);
    }
  }
  return Array.from(files);
}

/**
 * Returns true if ALL files in the diff match at least one glob pattern.
 * Empty diff or empty patterns always returns false (never skip).
 */
function allFilesExcluded(diff: string, excludePatterns: string[]): boolean {
  if (excludePatterns.length === 0) return false;
  const files = extractFilesFromDiff(diff);
  if (files.length === 0) return false;
  return files.every((file) =>
    excludePatterns.some((pattern) => minimatch(file, pattern, { dot: true })),
  );
}

async function resolveRepo(options: { repo?: string }): Promise<[string, string]> {
  if (options.repo) {
    const parts = String(options.repo).split("/");
    if (parts.length !== 2) {
      console.error(chalk.red("Repo must be in format: owner/repo"));
      process.exit(1);
    }
    return parts as [string, string];
  }
  try {
    const result = await exec("gh", ["repo", "view", "--json", "owner,name"]);
    const repoInfo = JSON.parse(result.stdout) as { owner: { login: string }; name: string };
    return [repoInfo.owner.login, repoInfo.name];
  } catch {
    console.error(chalk.red("Could not determine repo. Use --repo owner/repo"));
    process.exit(1);
  }
}

async function findExistingVerdict(
  owner: string,
  repo: string,
  prNumber: number,
  triggerSha?: string,
  requestId?: string,
): Promise<{ verdict: "PASS" | "FAIL" | "SKIPPED"; commentId: number } | null> {
  // Normalize triggerSha: trim whitespace and treat empty/invalid as unset
  const normalizedSha = triggerSha?.trim();
  const validSha = normalizedSha && /^[0-9a-f]{7,40}$/i.test(normalizedSha) ? normalizedSha : undefined;

  const comments = await fetchIssueComments(owner, repo, prNumber);
  for (const c of comments) {
    // Must be from the skeptic bot author — cursor[bot] comments can contain
    // `<!-- skeptic-agent-verdict -->` as literal text in a bug description,
    // which would otherwise false-match here.
    // Only reuse a comment if it was posted for the same trigger SHA —
    // otherwise editing it leaves the old updated_at and the skeptical gate
    // workflow rejects it (it filters by updated_at >= TRIGGER_UPDATED).
    if (/<!-- skeptic-agent-verdict -->/i.test(c.body)) {
      const escapedSha = validSha?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const shaMarker = escapedSha
        ? new RegExp(`<!-- skeptic-(?:gate|cron)-trigger-${escapedSha} -->`)
        : null;
      if (!shaMarker || shaMarker.test(c.body)) {
        // If requestId was provided, also match by it to avoid races on same SHA
        if (requestId) {
          const escapedRid = requestId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const ridMarker = new RegExp(`<!-- skeptic-request-id-${escapedRid} -->`, "i");
          if (!ridMarker.test(c.body)) continue;
        }
        const m = c.body.match(VERDICT_LINE_RE);
        if (m) {
          return { verdict: m[1].toUpperCase() as "PASS" | "FAIL" | "SKIPPED", commentId: c.id };
        }
      }
    }
  }
  return null;
}

export function registerSkeptic(program: Command): Command {
  const skepticCmd = program
    .command("skeptic")
    .description("Skeptic agent commands — run verification and manage CI installation (bd-qw6, bd-8tpa)");

  skepticCmd
    .command("verify")
    .description("Run skeptic agent verification on a PR and post VERDICT comment (bd-qw6)")
    .requiredOption("-n, --pr <number>", "PR number")
    .option("-r, --repo <owner/repo>", "Repository (defaults to current repo)")
    .option(
      "--dry-run",
      "Run the skeptical evaluation and print the verdict to stdout (skip posting to GitHub)",
    )
    .option("-m, --model <model>", "Model to use for evaluation (codex, claude, gemini)")
    .option(
      "--trigger-sha <sha>",
      "PR head SHA at dispatch time — embedded in the VERDICT comment body so the skeptic-gate workflow can match by SHA marker",
    )
    .option(
      "--prompt <text>",
      "Custom evaluation prompt — prepended to the default skeptic context. Use for bootstrap PRs (e.g., 'Only verify 6-green gates 1-5, skip gate 7').",
    )
    .option(
      "--exclude-paths <patterns>",
      "Pipe-separated glob patterns (pipe | cannot appear in globs). If ALL changed files match, post VERDICT: SKIPPED without running LLM evaluation. E.g. '**/*.md|docs/**'",
    )
    .option(
      "--request-id <id>",
      "Request ID from the skeptic-gate or skeptic-cron trigger comment — included in the VERDICT comment body for SHA + request-id matching (bd-qw6)",
    )
    .action(async (options) => {
      const prNumber = parseInt(String(options.pr), 10);
      if (isNaN(prNumber) || prNumber <= 0) {
        console.error(chalk.red("Invalid PR number: " + options.pr));
        process.exit(1);
      }

      // Normalize triggerSha once — used in findExistingVerdict and postVerdict calls
      const triggerSha = options.triggerSha?.trim();
      const [owner, repo] = await resolveRepo(options);
      const spinner = ora(`Fetching PR #${prNumber} state…`).start();

      // Fetch PR meta + diff + reviews in parallel; design doc needs PR head ref so fetch after.
      // Skip findExistingVerdict during dry-run since no comment will be posted.
      const [pr, diff, reviews, existing] = await Promise.all([
        fetchPRMeta(owner, repo, prNumber).catch((err) => {
          spinner.fail(chalk.red("Failed to fetch PR: " + err));
          process.exit(1);
          return null as never;
        }),
        fetchDiff(owner, repo, prNumber),
        fetchReviews(owner, repo, prNumber).catch(() => []),
        options.dryRun
          ? Promise.resolve(null)
          : findExistingVerdict(owner, repo, prNumber, triggerSha, options.requestId).catch(() => null),
      ]);
      // Design doc fetch uses GitHub API with the PR's head ref so it works regardless of cwd.
      const designDoc = await fetchDesignDoc(owner, repo, prNumber, pr.headRefOid).catch(() => null);

      spinner.succeed(chalk.green(`Fetched PR #${prNumber}: "${pr.title}"`));

      const spinner2 = ora("Fetching merge gate state (aligned with checkMergeGate)…").start();
      const state = await fetchMergeGateState(owner, repo, prNumber, SKEPTIC_BOT_AUTHOR).catch(
        (err) => {
          spinner2.fail(chalk.red("Failed to fetch merge gate state: " + err));
          process.exit(1);
          return null as never;
        },
      );
      spinner2.succeed(chalk.green("Merge gate state fetched"));

      // Early SKIP: if all diff files match exclude patterns, post VERDICT: SKIPPED immediately.
      const excludePatterns = options.excludePaths
        ? String(options.excludePaths).split("|").map((p) => p.trim()).filter(Boolean)
        : [];
      if (excludePatterns.length > 0 && allFilesExcluded(diff, excludePatterns)) {
        const skipVerdict = "VERDICT: SKIPPED — all changed files match exclude-paths (docs-only PR)";
        spinner.stop();
        console.log(chalk.yellow("\n=== SKIP — excluded files ===\n"));
        console.log(chalk.yellow(skipVerdict));

        if (options.dryRun) {
          return;
        }

        const spinner4 = ora("Posting skip verdict to PR…" + prNumber + "…").start();
        try {
          await postVerdict(
            owner,
            repo,
            prNumber,
            skipVerdict,
            existing?.commentId ?? null,
            SKEPTIC_BOT_AUTHOR,
            triggerSha,
            skipVerdict,
            { headSha: triggerSha, requestId: options.requestId } as SkepticVerdictBinding,
          );
          spinner4.succeed(chalk.green("Done! Skeptic verdict posted."));
        } catch (err) {
          spinner4.fail(chalk.red("Failed to post verdict: " + err));
          process.exit(1);
        }
        return;
      }

      // Build and run evaluation
      const spinner3 = ora("Running skeptic evaluation…").start();
      let prompt = buildSkepticPrompt(pr, state, diff, reviews, designDoc);
      // Custom prompt: prepend user instructions before the default skeptic context
      if (options.prompt) {
        prompt = `CUSTOM EVALUATION INSTRUCTIONS:\n${options.prompt}\n\n---\n\n${prompt}`;
      }
      const verdict = await runSkepticEvaluation(prompt, {
        model: options.model as "codex" | "claude" | "gemini" | undefined,
      });
      spinner3.succeed(chalk.green("Skeptic evaluation complete"));

      // Dry-run: print verdict without posting — fail-closed on malformed output
      if (options.dryRun) {
        console.log(chalk.yellow("\n=== DRY RUN — Verdict ===\n"));
        const bound = bindVerdictOutput({
          llmOutput: verdict,
          headSha: triggerSha,
          requestId: options.requestId,
        });
        if (bound.verdictType === null) {
          console.warn(chalk.red("Could not parse VERDICT from LLM output."));
          console.log(chalk.yellow("\n=== Full LLM output ===\n"));
          console.log(bound.llmOutput);
          process.exit(1);
        }
        console.log(chalk[bound.verdictType === "PASS" ? "green" : "red"](bound.verdictLine));
        console.log(chalk.yellow("\n=== Full LLM output ===\n"));
        console.log(bound.llmOutput);
        if (bound.verdictType === "FAIL" || bound.verdictType === "SKIPPED" || bound.verdictType === null) {
          process.exit(1);
        }
        return;
      }

      // Parse verdict from LLM output — bindVerdictOutput handles fail-closed downgrade
      // when gate markers are incomplete.
      const bound = bindVerdictOutput({
        llmOutput: verdict,
        headSha: triggerSha,
        requestId: options.requestId,
      });

      if (bound.verdictType === null) {
        console.warn(chalk.yellow("Could not parse VERDICT from LLM output. Posting raw output."));
      }

      const spinner4 = ora("Posting verdict to PR #" + prNumber + "…").start();
      let commentBody: string;
      try {
        await postVerdict(
          owner,
          repo,
          prNumber,
          bound.verdictLine,
          existing?.commentId ?? null,
          SKEPTIC_BOT_AUTHOR,
          triggerSha,
          bound.llmOutput,
          { headSha: triggerSha, requestId: options.requestId } as SkepticVerdictBinding,
        );
        spinner4.succeed(chalk.green("Done! Skeptic verdict posted."));

        // bd-upxh: the comment we just posted is the comment-level evidence.
        // Use the same body we posted (contains the HTML marker + verdict).
        commentBody = [
          "<!-- skeptic-agent-verdict -->",
          bound.verdictLine,
        ].join("\n");

        // Verify both run-level (LLM output) and comment-level (GitHub comment).
        // This surfaces INSUFFICIENT when evidence is missing or inconsistent — fail-closed.
        const spinner5 = ora("Verifying claim (run-level + comment-level)…").start();
        const claimResult = verifySkepticClaim(verdict, commentBody);
        spinner5.stop();
        console.log(formatClaimVerification(claimResult));

        if (claimResult.blocksWorking) {
          console.warn(
            chalk.yellow(
              `⚠  Claim verification: ${claimResult.outcome} — agent 'working' status is NOT permitted until resolved.`,
            ),
          );
        }
      } catch (err) {
        spinner4.fail(chalk.red("Failed to post verdict: " + err));
        process.exit(1);
      }
    });

  return skepticCmd;
}
