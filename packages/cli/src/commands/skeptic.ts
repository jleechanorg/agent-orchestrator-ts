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
 * (default: jleechan-agent[bot]).
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { exec } from "../lib/shell.js";
import { fetchPRMeta, fetchReviews, fetchDiff, fetchIssueComments } from "./skeptic/gh-client.js";
import { fetchMergeGateState } from "./skeptic/mergeGate.js";
import { buildSkepticPrompt } from "./skeptic/prompt.js";
import { runSkepticEvaluation } from "./skeptic/modelRunner.js";
import { postVerdict } from "./skeptic/posting.js";

const SKEPTIC_BOT_AUTHOR =
  process.env["GH_SKEPTIC_BOT_AUTHOR"] ?? "jleechan-agent[bot]";

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
): Promise<{ verdict: "PASS" | "FAIL" | "SKIPPED"; commentId: number } | null> {
  const comments = await fetchIssueComments(owner, repo, prNumber);
  for (const c of comments) {
    // Find by HTML marker first (most robust), then by bot author
    if (/<!-- skeptic-agent-verdict -->/i.test(c.body)) {
      if (/VERDICT:\s*PASS/i.test(c.body)) return { verdict: "PASS", commentId: c.id };
      if (/VERDICT:\s*FAIL/i.test(c.body)) return { verdict: "FAIL", commentId: c.id };
    }
  }
  return null;
}

export function registerSkeptic(program: Command): void {
  program
    .command("skeptic")
    .description("Run skeptic agent verification on a PR and post VERDICT comment (bd-qw6)")
    .requiredOption("-n, --pr <number>", "PR number")
    .option("-r, --repo <owner/repo>", "Repository (defaults to current repo)")
    .option(
      "--dry-run",
      "Run the skeptical evaluation and print the verdict to stdout (skip posting to GitHub)",
    )
    .action(async (options) => {
      const prNumber = parseInt(String(options.pr), 10);
      if (isNaN(prNumber) || prNumber <= 0) {
        console.error(chalk.red("Invalid PR number: " + options.pr));
        process.exit(1);
      }

      const [owner, repo] = await resolveRepo(options);
      const spinner = ora(`Fetching PR #${prNumber} state…`).start();

      // Fetch all needed data in parallel
      const [pr, diff, reviews, existing] = await Promise.all([
        fetchPRMeta(owner, repo, prNumber).catch((err) => {
          spinner.fail(chalk.red("Failed to fetch PR: " + err));
          process.exit(1);
          return null as never;
        }),
        fetchDiff(owner, repo, prNumber),
        fetchReviews(owner, repo, prNumber).catch(() => []),
        findExistingVerdict(owner, repo, prNumber).catch(() => null),
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
      const prompt = buildSkepticPrompt(pr, state, diff, reviews);
      const verdict = await runSkepticEvaluation(prompt);
      spinner3.succeed(chalk.green("Skeptic evaluation complete"));

      // Dry-run: print verdict without posting
      if (options.dryRun) {
        console.log(chalk.yellow("\n=== DRY RUN — Verdict ===\n"));
        const verdictMatch = verdict.match(/VERDICT:\s*(PASS|FAIL)/i);
        if (verdictMatch) {
          console.log(chalk[verdictMatch[1].toLowerCase() === "pass" ? "green" : "red"](verdictMatch[0]));
        } else {
          console.log(verdict);
        }
        console.log(chalk.yellow("\n=== Full LLM output ===\n"));
        console.log(verdict);
        return;
      }

      // Parse verdict from LLM output
      const verdictMatch = verdict.match(/VERDICT:\s*(PASS|FAIL)/i);
      if (!verdictMatch) {
        console.warn(chalk.yellow("Could not parse VERDICT from LLM output. Posting raw output."));
      }

      const verdictLine = verdictMatch
        ? verdictMatch[0]
        : "VERDICT: FAIL — could not parse LLM output";

      const spinner4 = ora("Posting verdict to PR #" + prNumber + "…").start();
      try {
        await postVerdict(
          owner,
          repo,
          prNumber,
          verdictLine,
          existing?.commentId ?? null,
          SKEPTIC_BOT_AUTHOR,
        );
        spinner4.succeed(chalk.green("Done! Skeptic verdict posted."));
      } catch (err) {
        spinner4.fail(chalk.red("Failed to post verdict: " + err));
        process.exit(1);
      }
    });
}
