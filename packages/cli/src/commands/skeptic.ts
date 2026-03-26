/**
 * Skeptic Agent — Independent Exit Criteria Verifier (bd-qw6)
 *
 * CLI: ao skeptic --pr <number> [--repo owner/repo]
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

const SKEPTIC_BOT_AUTHOR =
  process.env["GH_SKEPTIC_BOT_AUTHOR"] ?? "jleechan-agent[bot]";

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

async function ghJson(endpoint: string, args: string[] = []): Promise<unknown> {
  const result = await exec("gh", ["api", endpoint, ...args]);
  return JSON.parse(result.stdout);
}

interface PRInfo {
  number: number;
  title: string;
  body: string;
  state: string;
  headRefOid: string;
  baseRefName: string;
  isDraft: boolean;
}

interface ReviewInfo {
  author: { login: string };
  state: string;
  body: string | null;
  submittedAt: string;
}

interface IssueComment {
  id: number;
  body: string;
  user: { login: string };
  createdAt: string;
  isMinimized?: boolean;
}

interface ReviewThreadComment {
  body: string | null;
  author?: { login: string } | null;
  isMinimized?: boolean;
}

interface MergeGateState {
  ciPassing: boolean;
  crApproved: boolean;
  crState: string;
  bugbotErrors: number;
  unresolvedComments: number;
  skepticVerdict: "PASS" | "FAIL" | "SKIPPED" | null;
  skepticCommentId: number | null;
}

// ---------------------------------------------------------------------------
// Fetch PR merge gate state
// ---------------------------------------------------------------------------

async function fetchMergeGateState(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<MergeGateState> {
  // 1. CI checks via GraphQL
  let ciPassing: boolean;
  try {
    const query = [
      "{",
      '  repository(owner:"' + owner + '", name:"' + repo + '") {',
      "    pullRequest(number:" + prNumber + ") {",
      "      commits(last:1) {",
      "        nodes { commit { statusCheckRollup { state } } }",
      "      }",
      "    }",
      "  }",
      "}",
    ].join("\n");
    const ciData = await ghJson("graphql", ["-f", "query=" + query]);
    const d = ciData as { data?: { repository?: { pullRequest?: { commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { state: string } } }> } } } } };
    const state = d?.data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
    ciPassing = state === "SUCCESS";
  } catch {
    ciPassing = false;
  }

  // 2. CR review + review threads via GraphQL
  let crApproved = false;
  let crState = "none";
  let unresolvedComments = 0;
  let bugbotErrors = 0;

  try {
    const reviewQuery = [
      "{",
      '  repository(owner:"' + owner + '", name:"' + repo + '") {',
      "    pullRequest(number:" + prNumber + ") {",
      "      reviewDecision",
      "      reviews(last:10) {",
      "        nodes { author { login } state body submittedAt }",
      "      }",
      "      reviewThreads(first:50) {",
      "        nodes {",
      "          isResolved",
      "          comments(first:1) { nodes { body author { login } isMinimized } }",
      "        }",
      "      }",
      "    }",
      "  }",
      "}",
    ].join("\n");
    const reviewData = await ghJson("graphql", ["-f", "query=" + reviewQuery]);
    const r = reviewData as {
      data?: {
        repository?: {
          pullRequest?: {
            reviewDecision?: string;
            reviews?: { nodes?: ReviewInfo[] };
            reviewThreads?: {
              nodes?: Array<{
                isResolved?: boolean;
                comments?: { nodes?: ReviewThreadComment[] };
              }>;
            };
          };
        };
      };
    };
    const pr = r?.data?.repository?.pullRequest;

    crState = pr?.reviewDecision ?? "none";
    crApproved = crState === "APPROVED";

    const reviews = pr?.reviews?.nodes ?? [];
    for (const rev of reviews) {
      if (rev.author?.login === "coderabbitai[bot]" && rev.state === "CHANGES_REQUESTED") {
        crApproved = false;
        crState = "CHANGES_REQUESTED";
      }
      if (rev.author?.login === "coderabbitai[bot]" && rev.state === "APPROVED") {
        crApproved = true;
        crState = "APPROVED";
      }
    }

    const threads = pr?.reviewThreads?.nodes ?? [];
    for (const t of threads) {
      if (!t.isResolved) unresolvedComments++;
      const firstComment = t.comments?.nodes?.[0];
      if (
        firstComment?.body &&
        /cursor\[bot]/i.test(firstComment.author?.login ?? "") &&
        /error/i.test(firstComment.body) &&
        !firstComment.isMinimized
      ) {
        bugbotErrors++;
      }
    }
  } catch {
    // non-fatal
  }

  // 3. Find existing skeptic verdict comment
  let skepticVerdict: "PASS" | "FAIL" | "SKIPPED" | null = null;
  let skepticCommentId: number | null = null;
  try {
    const comments = (await ghJson(
      "repos/" + owner + "/" + repo + "/issues/" + prNumber + "/comments?per_page=100",
    )) as IssueComment[];
    for (const c of comments) {
      if (c.user?.login === SKEPTIC_BOT_AUTHOR) {
        if (/VERDICT:\s*PASS/i.test(c.body)) {
          skepticVerdict = "PASS";
          skepticCommentId = c.id;
          break;
        } else if (/VERDICT:\s*FAIL/i.test(c.body)) {
          skepticVerdict = "FAIL";
          skepticCommentId = c.id;
          break;
        }
      }
    }
  } catch {
    // non-fatal
  }

  return { ciPassing, crApproved, crState, bugbotErrors, unresolvedComments, skepticVerdict, skepticCommentId };
}

// ---------------------------------------------------------------------------
// Build skeptic evaluation prompt
// ---------------------------------------------------------------------------

function buildSkepticPrompt(
  pr: PRInfo,
  state: MergeGateState,
  diff: string,
  reviews: ReviewInfo[],
): string {
  const summary = [
    "PR #" + pr.number + ": " + pr.title,
    "State: " + pr.state + " | Draft: " + pr.isDraft,
    "Base: " + pr.baseRefName,
    "",
    "--- 6-GREEN STATUS ---",
    "1. CI green:       " + (state.ciPassing ? "PASS" : "FAIL"),
    "2. CR approved:    " + (state.crApproved ? "PASS" : "FAIL") + " (state: " + state.crState + ")",
    "3. Bugbot clean:   " + (state.bugbotErrors === 0 ? "PASS" : "FAIL") + " (errors: " + state.bugbotErrors + ")",
    "4. Unresolved comments: " + (state.unresolvedComments === 0 ? "PASS" : "FAIL") + " (count: " + state.unresolvedComments + ")",
    "",
    "--- RECENT REVIEWS ---",
    ...reviews.slice(0, 5).map(
      (r) => "[" + r.state + "] " + r.author?.login + ": " + (r.body ?? "").slice(0, 200),
    ),
    "",
    "--- DIFF (first 200 lines) ---",
    diff.slice(0, 8000),
  ].join("\n");

  return "You are a Skeptic QA Agent. Your job is to FIND GAPS in this PR.\n\n" +
    "INVERTED INCENTIVE: You are rewarded for finding missing evidence.\n" +
    "A false PASS is YOUR failure. A thorough FAIL report is success.\n\n" +
    "RULES:\n" +
    "1. Verify each of the 6-green conditions independently.\n" +
    "2. Unit tests do NOT satisfy E2E criteria.\n" +
    "3. Code compiles does NOT mean feature works.\n" +
    "4. If CI is pending or not yet run, that is a gap.\n" +
    "5. If CR is COMMENTED but not APPROVED, that is NOT approval.\n" +
    "6. Bugbot errors always block merge.\n" +
    "7. Unresolved Major/Critical inline comments always block merge.\n\n" +
    "OUTPUT FORMAT:\n" +
    "VERDICT: PASS — All 7-green conditions genuinely satisfied\n" +
    "OR\n" +
    "VERDICT: FAIL — Missing: [specific list of gaps]\n\n" +
    "Be specific. 'The code looks fine' is NOT a valid PASS.\n" +
    "Find at least one concrete gap before declaring FAIL.\n\n" +
    "--- PR CONTEXT ---\n" +
    summary;
}

// ---------------------------------------------------------------------------
// Run skeptical LLM evaluation (via Claude CLI)
// ---------------------------------------------------------------------------

async function runSkepticEvaluation(prompt: string): Promise<string> {
  try {
    // Use claude CLI if available
    const { execSync } = await import("node:child_process");
    const result = execSync(
      "claude --print --no-input 2>/dev/null",
      {
        input: prompt,
        encoding: "utf-8",
        timeout: 60_000,
      },
    );
    return result.trim();
  } catch {
    return "VERDICT: FAIL — Claude CLI not available or evaluation failed (install claude to enable LLM skeptic)";
  }
}

// ---------------------------------------------------------------------------
// Post or update VERDICT comment on PR
// ---------------------------------------------------------------------------

async function postVerdict(
  owner: string,
  repo: string,
  prNumber: number,
  verdict: string,
  existingCommentId: number | null,
): Promise<void> {
  const body = [
    "<!-- skeptic-agent-verdict -->",
    "**🤖 Skeptic Agent Verdict (bd-qw6)**",
    "",
    verdict,
    "",
    "_Posted by " + SKEPTIC_BOT_AUTHOR + " · " + new Date().toISOString() + "_",
  ].join("\n");

  if (existingCommentId) {
    await exec("gh", [
      "api",
      "--method", "PATCH",
      "repos/" + owner + "/" + repo + "/issues/comments/" + existingCommentId,
      "--field", "body=" + body,
    ]);
  } else {
    await exec("gh", [
      "api",
      "repos/" + owner + "/" + repo + "/issues/" + prNumber + "/comments",
      "--field", "body=" + body,
    ]);
  }
}

// ---------------------------------------------------------------------------
// CLI registration
// ---------------------------------------------------------------------------

export function registerSkeptic(program: Command): void {
  program
    .command("skeptic")
    .description("Run skeptic agent verification on a PR and post VERDICT comment (bd-qw6)")
    .requiredOption("-n, --pr <number>", "PR number")
    .option("-r, --repo <owner/repo>", "Repository (defaults to current repo)")
    .option("--dry-run", "Fetch state and print verdict without posting to GitHub")
    .action(async (options) => {
      const prNumber = parseInt(String(options.pr), 10);
      if (isNaN(prNumber) || prNumber <= 0) {
        console.error(chalk.red("Invalid PR number: " + options.pr));
        process.exit(1);
      }

      // Resolve repo
      let owner: string;
      let repo: string;
      if (options.repo) {
        const parts = String(options.repo).split("/");
        if (parts.length !== 2) {
          console.error(chalk.red("Repo must be in format: owner/repo"));
          process.exit(1);
        }
        [owner, repo] = parts;
      } else {
        try {
          const result = await exec("gh", ["repo", "view", "--json", "owner,name"]);
          const repoInfo = JSON.parse(result.stdout) as { owner: { login: string }; name: string };
          owner = repoInfo.owner.login;
          repo = repoInfo.name;
        } catch {
          console.error(chalk.red("Could not determine repo. Use --repo owner/repo"));
          process.exit(1);
        }
      }

      const spinner = ora("Fetching PR #" + prNumber + " state…").start();

      // Fetch PR metadata
      let pr: PRInfo;
      try {
        const prQuery = [
          "{",
          '  repository(owner:"' + owner + '", name:"' + repo + '") {',
          "    pullRequest(number:" + prNumber + ") {",
          "      number title body state headRefOid baseRefName isDraft",
          "    }",
          "  }",
          "}",
        ].join("\n");
        const data = await ghJson("graphql", ["-f", "query=" + prQuery]);
        const d = data as { data?: { repository?: { pullRequest?: PRInfo } } };
        pr = d?.data?.repository?.pullRequest as unknown as PRInfo;
        if (!pr) throw new Error("PR not found");
      } catch (err) {
        spinner.fail(chalk.red("Failed to fetch PR: " + err));
        process.exit(1);
      }

      // Fetch diff
      let diff: string;
      try {
        const result = await exec("gh", [
          "pr", "diff",
          "--repo", owner + "/" + repo,
          String(prNumber),
        ]);
        diff = result.stdout;
      } catch {
        diff = "(diff unavailable)";
      }

      // Fetch reviews
      let reviews: ReviewInfo[] = [];
      try {
        const reviewQuery = [
          "{",
          '  repository(owner:"' + owner + '", name:"' + repo + '") {',
          "    pullRequest(number:" + prNumber + ") {",
          "      reviews(last:10) {",
          "        nodes { author { login } state body submittedAt }",
          "      }",
          "    }",
          "  }",
          "}",
        ].join("\n");
        const reviewData = await ghJson("graphql", ["-f", "query=" + reviewQuery]);
        const r = reviewData as { data?: { repository?: { pullRequest?: { reviews?: { nodes?: ReviewInfo[] } } } } };
        reviews = (r?.data?.repository?.pullRequest?.reviews?.nodes ?? []) as ReviewInfo[];
      } catch {
        // non-fatal
      }

      // Fetch merge gate state
      let state: MergeGateState;
      try {
        state = await fetchMergeGateState(owner, repo, prNumber);
      } catch (err) {
        spinner.fail(chalk.red("Failed to fetch merge gate state: " + err));
        process.exit(1);
      }

      spinner.succeed(chalk.green("Fetched PR #" + prNumber + " state"));

      // Build skeptic prompt and run evaluation
      const spinner2 = ora("Running skeptic evaluation…").start();
      const prompt = buildSkepticPrompt(pr, state, diff, reviews);

      if (options.dryRun) {
        spinner2.stop();
        console.log(chalk.yellow("DRY RUN — skeptic prompt:\n"));
        console.log(prompt);
        return;
      }

      const verdict = await runSkepticEvaluation(prompt);
      spinner2.succeed(chalk.green("Skeptic evaluation complete"));

      // Extract VERDICT line
      const verdictMatch = verdict.match(/VERDICT:\s*(PASS|FAIL)/i);
      if (!verdictMatch) {
        console.warn(chalk.yellow("Could not parse VERDICT from LLM output. Posting raw output."));
        console.log(verdict);
      }

      // Post verdict comment
      const spinner3 = ora("Posting verdict to PR #" + prNumber + "…").start();
      try {
        await postVerdict(owner, repo, prNumber, verdict, state.skepticCommentId);
        spinner3.succeed(chalk.green("Done! Skeptic verdict posted."));
      } catch (err) {
        spinner3.fail(chalk.red("Failed to post verdict: " + err));
        process.exit(1);
      }
    });
}
