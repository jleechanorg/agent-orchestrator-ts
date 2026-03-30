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
 * (default: jleechan2015).
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { exec } from "../lib/shell.js";
import { fetchPRMeta, fetchReviews, fetchDiff, fetchIssueComments, fetchDesignDoc } from "./skeptic/gh-client.js";
import { fetchMergeGateState } from "./skeptic/mergeGate.js";
import { buildSkepticPrompt } from "./skeptic/prompt.js";
import { runSkepticEvaluation } from "./skeptic/modelRunner.js";
import { postVerdict } from "./skeptic/posting.js";
import { verifySkepticClaim, formatClaimVerification } from "./skeptic/claim-verifier.js";
import { VERDICT_LINE_RE, applyGate3Override } from "./skeptic/verdict-utils.js";

// bd-lg7i: Default to jleechan2015 — ao skeptic verify posts via `gh api`
// authenticated as the local user, not the GitHub App bot. Override via
// GH_SKEPTIC_BOT_AUTHOR env var if posting identity changes.
const SKEPTIC_BOT_AUTHOR =
  process.env["GH_SKEPTIC_BOT_AUTHOR"] ?? "jleechan2015";

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
): Promise<{ verdict: "PASS" | "FAIL" | "SKIPPED"; commentId: number } | null> {
  // Normalize triggerSha: trim whitespace and treat empty/invalid as unset
  const normalizedSha = triggerSha?.trim();
  const validSha = normalizedSha && /^[0-9a-f]{7,40}$/i.test(normalizedSha) ? normalizedSha : undefined;

  const comments = await fetchIssueComments(owner, repo, prNumber);
  for (const c of comments) {
    // Find by HTML marker AND trigger SHA match.
    // Only reuse a comment if it was posted for the SAME trigger SHA —
    // otherwise editing it leaves the old updated_at and the skeptical gate
    // workflow rejects it (it filters by updated_at >= TRIGGER_UPDATED).
    if (/<!-- skeptic-agent-verdict -->/i.test(c.body)) {
      const shaMarker = validSha ? new RegExp(`<!-- skeptic-gate-trigger-${validSha.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} -->`) : null;
      if (!shaMarker || shaMarker.test(c.body)) {
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
    .action(async (options) => {
      const prNumber = parseInt(String(options.pr), 10);
      if (isNaN(prNumber) || prNumber <= 0) {
        console.error(chalk.red("Invalid PR number: " + options.pr));
        process.exit(1);
      }

      const [owner, repo] = await resolveRepo(options);
      const spinner = ora(`Fetching PR #${prNumber} state…`).start();

      // Fetch all needed data in parallel (including design doc from local checkout)
      const [pr, diff, reviews, existing, designDoc] = await Promise.all([
        fetchPRMeta(owner, repo, prNumber).catch((err) => {
          spinner.fail(chalk.red("Failed to fetch PR: " + err));
          process.exit(1);
          return null as never;
        }),
        fetchDiff(owner, repo, prNumber),
        fetchReviews(owner, repo, prNumber).catch(() => []),
        findExistingVerdict(owner, repo, prNumber, options.triggerSha).catch(() => null),
        fetchDesignDoc(prNumber).catch(() => null),
      ]);

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

      // bd-kvvx: fail-closed gate 3 enforcement.
      // The LLM prompt instructs gate 3 (CR APPROVED) but the model can still issue
      // PASS when CR has only COMMENTED or CHANGES_REQUESTED. Enforce it at code level:
      // if CR has not approved, only FAIL is acceptable — PASS or SKIPPED are overridden.
      const { finalVerdict: rawFinal, wasOverridden } = applyGate3Override({
        llmVerdict: verdict,
        crApproved: state.crApproved,
        crState: state.crState,
        crDismissedWithoutApproval: state.crDismissedWithoutApproval,
      });
      if (wasOverridden) {
        const parsed = verdict.match(VERDICT_LINE_RE);
        const raw = parsed?.[1]?.toUpperCase();
        const crDetail = state.crDismissedWithoutApproval
          ? `${state.crState} + DISMISSED_WITHOUT_APPROVAL`
          : state.crState;
        console.warn(
          chalk.yellow(
            `⚠  Gate 3 override: CR state=${crDetail} — LLM returned VERDICT: ${raw ?? "UNPARSED"}; ` +
              `overriding to VERDICT: FAIL (fail-closed, bd-kvvx)`,
          ),
        );
      }
      const finalVerdict = rawFinal;

      // Dry-run: print verdict without posting
      if (options.dryRun) {
        console.log(chalk.yellow("\n=== DRY RUN — Verdict ===\n"));
        const verdictMatch = finalVerdict.match(VERDICT_LINE_RE);
        if (verdictMatch) {
          console.log(chalk[verdictMatch[1].toLowerCase() === "pass" ? "green" : "red"](verdictMatch[0]));
        } else {
          console.log(finalVerdict);
        }
        console.log(chalk.yellow("\n=== Full LLM output ===\n"));
        console.log(finalVerdict);
        // Exit non-zero only for VERDICT: FAIL from LLM evaluation.
        // Infrastructure failures (Codex/Claude unavailable) emit VERDICT: SKIPPED and exit 0
        // so the cron step continues — gate 7 treats SKIPPED as a pass condition.
        if (verdictMatch?.[1]?.toUpperCase() === "FAIL") {
          process.exit(1);
        }
        return;
      }

      // Parse verdict from LLM output
      const verdictMatch = finalVerdict.match(VERDICT_LINE_RE);
      if (!verdictMatch) {
        console.warn(chalk.yellow("Could not parse VERDICT from LLM output. Posting raw output."));
      }

      const verdictLine = verdictMatch
        ? verdictMatch[0]
        : "VERDICT: FAIL — could not parse LLM output (expected VERDICT: PASS/FAIL/SKIPPED)";

      const spinner4 = ora("Posting verdict to PR #" + prNumber + "…").start();
      let commentBody: string;
      try {
        await postVerdict(
          owner,
          repo,
          prNumber,
          verdictLine,
          existing?.commentId ?? null,
          SKEPTIC_BOT_AUTHOR,
          options.triggerSha,
          finalVerdict, // always pass final (possibly overridden) verdict so bodies carry context
        );
        spinner4.succeed(chalk.green("Done! Skeptic verdict posted."));

        // bd-upxh: the comment we just posted is the comment-level evidence.
        // Use the same body we posted (contains the HTML marker + verdict).
        commentBody = [
          "<!-- skeptic-agent-verdict -->",
          verdictLine,
        ].join("\n");

        // Verify both run-level (LLM output) and comment-level (GitHub comment).
        // This surfaces INSUFFICIENT when evidence is missing or inconsistent — fail-closed.
        const spinner5 = ora("Verifying claim (run-level + comment-level)…").start();
        const claimResult = verifySkepticClaim(finalVerdict, commentBody);
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
