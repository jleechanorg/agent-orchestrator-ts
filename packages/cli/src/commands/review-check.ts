import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig, DeferredGraphQLExecutor, isGhRateLimitError } from "@jleechanorg/ao-core";
import { exec } from "../lib/shell.js";
import { getSessionManager } from "../lib/create-session-manager.js";

interface ReviewInfo {
  sessionId: string;
  projectId: string;
  prNumber: string;
  pendingComments: number;
  reviewDecision: string | null;
}

const DEFAULT_REVIEW_FIX_PROMPT =
  "There are review comments on your PR. Check with `gh pr view --comments` and `gh api` for inline comments. Address each one, push fixes, and reply.";

// ---------------------------------------------------------------------------
// Review-check GraphQL executor with retry + deferral (bd-fy7)
//
// Rate-limit errors → retry with exponential backoff (1s → 2s → 4s, cap 30s)
// Non-rate-limit errors → fail immediately
// All retries exhausted → DEFER, return null so the caller can report the stall
// ---------------------------------------------------------------------------

const REVIEW_QUERY = `
  query($owner:String!,$name:String!,$pr:Int!) {
    repository(owner:$owner,name:$name) {
      pullRequest(number:$pr) {
        reviewDecision
        reviewThreads(first:100) {
          pageInfo { hasNextPage }
          nodes { isResolved }
        }
      }
    }
  }
`;

function makeReviewExecutor(): DeferredGraphQLExecutor {
  return new DeferredGraphQLExecutor({
    async execute(query: string, variables: Record<string, unknown>): Promise<unknown> {
      const [owner, name] = [String(variables["owner"]), String(variables["name"])];
      const prNum = Number(variables["pr"]);
      // Use the throwing exec() so that non-zero gh exits (including rate-limit
      // responses) propagate as real errors with stderr — isGhRateLimitError can
      // then match the rate-limit message instead of receiving a null return.
      let stdout: string;
      try {
        const result = await exec("gh", [
          "api",
          "graphql",
          "-f",
          `query=${query}`,
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
          "-F",
          `pr=${prNum}`,
        ]);
        stdout = result.stdout;
      } catch (err) {
        const stderr = (err as { stderr?: string }).stderr ?? "";
        const base = err instanceof Error ? err.message : String(err);
        throw new Error(stderr ? `${base}: ${stderr}` : base);
      }
      if (!stdout) throw new Error("gh graphql returned no output");
      const parsed = JSON.parse(stdout) as {
        data?: { repository?: { pullRequest?: unknown } };
        errors?: Array<{ message: string }>;
      };
      // Surface GraphQL-level errors as thrown errors
      if (parsed.errors?.length) {
        throw new Error(parsed.errors.map((e) => e.message).join("; "));
      }
      return parsed.data?.repository?.pullRequest ?? null;
    },
  });
}

async function checkPRReviews(
  repo: string,
  prNumber: string,
  executor: DeferredGraphQLExecutor,
): Promise<{ pendingComments: number; reviewDecision: string | null; wasDeferred: boolean }> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    return { pendingComments: 0, reviewDecision: null, wasDeferred: false };
  }

  const label = `review-check:${repo}:${prNumber}`;
  const { data, wasDeferred } = await executor.executeWithLabel(label, REVIEW_QUERY, {
    owner,
    name,
    pr: Number(prNumber),
  });

  if (wasDeferred) {
    // Exhausted retries — caller logs the deferred state
    return { pendingComments: 0, reviewDecision: null, wasDeferred: true };
  }

  const pr = data as {
    reviewDecision?: string | null;
    reviewThreads?: {
      pageInfo?: { hasNextPage: boolean };
      nodes?: Array<{ isResolved: boolean }>;
    };
  } | null;

  if (!pr) {
    return { pendingComments: 0, reviewDecision: null, wasDeferred: false };
  }

  // Fail-closed: if more threads exist beyond the first 100, report at least 1
  // pending so the agent is prompted to investigate rather than silently skip.
  if (pr.reviewThreads?.pageInfo?.hasNextPage) {
    return {
      pendingComments: 1,
      reviewDecision: pr.reviewDecision || null,
      wasDeferred: false,
    };
  }

  const unresolvedCount = Array.isArray(pr.reviewThreads?.nodes)
    ? pr.reviewThreads.nodes.filter((t) => !t.isResolved).length
    : 0;

  return {
    pendingComments: unresolvedCount,
    reviewDecision: pr.reviewDecision || null,
    wasDeferred: false,
  };
}

export function registerReviewCheck(program: Command): void {
  program
    .command("review-check")
    .description("Check PRs for review comments and trigger agents to address them")
    .argument("[project]", "Project ID (checks all if omitted)")
    .option("--dry-run", "Show what would be done without sending messages")
    .action(async (projectId: string | undefined, opts: { dryRun?: boolean }) => {
      const config = loadConfig();

      if (projectId && !config.projects[projectId]) {
        console.error(chalk.red(`Unknown project: ${projectId}`));
        process.exit(1);
      }

      const sm = await getSessionManager(config);
      const sessions = await sm.list(projectId);

      const spinner = ora("Checking PRs for review comments...").start();
      const results: ReviewInfo[] = [];
      const executor = makeReviewExecutor();

      for (const session of sessions) {
        const prUrl = session.metadata["pr"];
        if (!prUrl) continue;

        const project = config.projects[session.projectId];
        if (!project?.repo) continue;

        const prNum = prUrl.match(/(\d+)\s*$/)?.[1];
        if (!prNum) continue;

        try {
          const { pendingComments, reviewDecision, wasDeferred } = await checkPRReviews(
            project.repo,
            prNum,
            executor,
          );
          if (wasDeferred) {
            continue; // skip processing this session until GraphQL recovers
          }
          if (pendingComments > 0 || reviewDecision === "CHANGES_REQUESTED") {
            results.push({
              sessionId: session.id,
              projectId: session.projectId,
              prNumber: prNum,
              pendingComments,
              reviewDecision,
            });
          }
        } catch (err) {
          // Non-rate-limit / access error — skip this PR
          if (!isGhRateLimitError(err)) {
            const msg = err instanceof Error ? err.message : String(err);
            spinner.warn(`Skipping PR #${prNum}: ${msg}`);
          }
        }
      }

      spinner.stop();

      // Report any deferred review checks clearly
      if (executor.hasDeferred) {
        const deferred = [...executor.deferredItems.values()];
        console.log(
          chalk.yellow(
            `⚠  ${deferred.length} review check${deferred.length > 1 ? "s" : ""} deferred ` +
              `due to GitHub GraphQL rate-limiting. Will retry on next run.\n` +
              deferred.map((d) => `   ${d.label} — last error: ${d.lastError}`).join("\n"),
          ),
        );
        console.log();
      }

      if (results.length === 0) {
        if (executor.hasDeferred) {
          console.log(chalk.yellow("No actionable reviews found this run (GraphQL deferred)."));
        } else {
          console.log(chalk.green("No pending review comments found."));
        }
        return;
      }

      console.log(
        chalk.bold(
          `\nFound ${results.length} session${results.length > 1 ? "s" : ""} with pending reviews:\n`,
        ),
      );

      for (const result of results) {
        console.log(`  ${chalk.green(result.sessionId)}  PR #${result.prNumber}`);
        if (result.reviewDecision) {
          console.log(`    Decision: ${chalk.yellow(result.reviewDecision)}`);
        }
        if (result.pendingComments > 0) {
          console.log(`    Comments: ${chalk.yellow(String(result.pendingComments))}`);
        }

        if (!opts.dryRun) {
          try {
            // Resolve prompt per-session: project-level reaction overrides
            // take precedence over global config, matching lifecycle worker behavior.
            const projectReaction =
              config.projects[result.projectId]?.reactions?.["changes-requested"];
            const globalReaction = config.reactions["changes-requested"];
            const reviewFixPrompt =
              projectReaction?.message ?? globalReaction?.message ?? DEFAULT_REVIEW_FIX_PROMPT;
            await sm.send(result.sessionId, reviewFixPrompt);
            console.log(chalk.green(`    -> Fix prompt sent`));
          } catch (err) {
            console.error(chalk.red(`    -> Failed to send: ${err}`));
          }
        } else {
          console.log(chalk.dim(`    (dry run — would send fix prompt)`));
        }
      }
      console.log();
    });
}
