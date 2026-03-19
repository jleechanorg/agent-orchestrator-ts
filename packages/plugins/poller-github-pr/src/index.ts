/**
 * poller-github-pr plugin — scans open GitHub PRs and spawns fix sessions for non-green PRs.
 *
 * Uses the `gh` CLI to query GitHub for open PRs and check CI/review state.
 * Non-green PRs (failing CI, changes requested, pending reviews) are returned
 * as PollerWorkItems for the poller-manager to spawn sessions for.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  Poller,
  PollerWorkItem,
  Session,
  SessionSpawnConfig,
  SessionManager,
  PluginModule,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);

// -----------------------------------------------------------------------
// GitHub PR shape returned by `gh pr list --json`
// -----------------------------------------------------------------------

interface GitHubPR {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  statusCheckRollup: Array<{ state: string; conclusion: string | null }> | null;
  reviewDecision: string | null;
  mergeable: string;
}

// -----------------------------------------------------------------------
// Helper: run gh CLI
// -----------------------------------------------------------------------

async function ghExec(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    ...(cwd ? { cwd } : {}),
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout.trim();
}

// -----------------------------------------------------------------------
// Helper: determine if CI is passing for a PR
// -----------------------------------------------------------------------

function isCIPassing(pr: GitHubPR): boolean {
  const checks = pr.statusCheckRollup;
  if (!checks || checks.length === 0) return true; // No CI configured — treat as passing
  return checks.every((c) => {
    const state = c.state?.toUpperCase();
    const conclusion = c.conclusion?.toLowerCase();
    return (
      state === "SUCCESS" ||
      conclusion === "success" ||
      conclusion === "skipped" ||
      conclusion === "neutral"
    );
  });
}

// -----------------------------------------------------------------------
// Helper: determine if a PR has been approved
// -----------------------------------------------------------------------

function isApproved(pr: GitHubPR): boolean {
  return pr.reviewDecision === "APPROVED" || pr.reviewDecision === null || pr.reviewDecision === "";
}

// -----------------------------------------------------------------------
// Helper: determine if a PR is "green" (no action needed)
// A PR is green when:
//   1. CI is passing (or no CI configured)
//   2. Review decision is APPROVED (or no review required)
//   3. No merge conflicts
// Draft PRs are skipped (not our responsibility to fix).
// -----------------------------------------------------------------------

function isPRGreen(pr: GitHubPR): boolean {
  if (pr.isDraft) return true; // Skip drafts — treat as green to avoid spawning sessions
  if (pr.mergeable === "CONFLICTING") return false;
  return isCIPassing(pr) && isApproved(pr);
}

// -----------------------------------------------------------------------
// Helper: collect reasons why a PR is not green
// -----------------------------------------------------------------------

function getNonGreenReasons(pr: GitHubPR): string[] {
  const reasons: string[] = [];
  if (!isCIPassing(pr)) reasons.push("ci-failing");
  if (pr.reviewDecision === "CHANGES_REQUESTED") reasons.push("changes-requested");
  if (pr.reviewDecision === "REVIEW_REQUIRED") reasons.push("review-required");
  if (pr.mergeable === "CONFLICTING") reasons.push("merge-conflicts");
  return reasons;
}

// -----------------------------------------------------------------------
// Plugin manifest
// -----------------------------------------------------------------------

export const manifest = {
  name: "github-pr",
  slot: "poller" as const,
  description: "Poller plugin: GitHub PR scanner — spawns fix sessions for non-green PRs",
  version: "0.1.0",
  displayName: "GitHub PR Poller",
};

// -----------------------------------------------------------------------
// Plugin factory
// -----------------------------------------------------------------------

export function create(config?: Record<string, unknown>): Poller & { setSessionManager(sm: SessionManager): void } {
  const repo = config?.repo as string | undefined;
  let sessionManager = config?.sessionManager as SessionManager | undefined;

  return {
    name: "github-pr",

    setSessionManager(sm: SessionManager): void {
      sessionManager = sm;
    },

    async poll(projectId: string): Promise<PollerWorkItem[]> {
      const args = [
        "pr",
        "list",
        "--state",
        "open",
        "--json",
        "number,title,url,isDraft,headRefName,baseRefName,statusCheckRollup,reviewDecision,mergeable",
        "--limit",
        "50",
      ];

      if (repo) {
        args.push("--repo", repo);
      }

      let raw: string;
      try {
        raw = await ghExec(args);
      } catch (err) {
        throw new Error(
          `[poller-github-pr] Failed to list PRs for project ${projectId}: ${(err as Error).message}`,
        );
      }

      let prs: GitHubPR[];
      try {
        prs = JSON.parse(raw) as GitHubPR[];
      } catch {
        throw new Error(`[poller-github-pr] Failed to parse gh pr list output: ${raw}`);
      }

      const workItems: PollerWorkItem[] = [];

      for (const pr of prs) {
        // Skip draft PRs
        if (pr.isDraft) continue;

        // Skip green PRs
        if (isPRGreen(pr)) continue;

        const reasons = getNonGreenReasons(pr);

        workItems.push({
          id: `pr-${pr.number}`,
          type: "open-pr",
          title: pr.title,
          url: pr.url,
          priority: reasons.includes("ci-failing") ? 1 : 2,
          metadata: {
            prNumber: pr.number,
            branch: pr.headRefName,
            baseBranch: pr.baseRefName,
            reasons,
            ciPassing: isCIPassing(pr),
            approved: isApproved(pr),
            mergeable: pr.mergeable,
          },
        });
      }

      return workItems;
    },

    async spawnSession(
      workItem: PollerWorkItem,
      projectId: string,
      config: SessionSpawnConfig,
    ): Promise<Session | null> {
      if (!sessionManager) {
        console.warn(
          `[poller-github-pr] No sessionManager configured — cannot spawn session for work item ${workItem.id}`,
        );
        return null;
      }

      const reasons = (workItem.metadata?.reasons as string[]) ?? [];
      const prNumber = workItem.metadata?.prNumber as number | undefined;

      // Build PR-specific context that enriches any upstream prompt
      const prContext = [
        `Fix PR #${prNumber ?? workItem.id}: ${workItem.title}`,
        `URL: ${workItem.url}`,
        reasons.length > 0 ? `Issues: ${reasons.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      // If an upstream prompt was provided (e.g., from poller-manager template),
      // append PR-specific reasons so they are not lost.
      const prompt = config.prompt
        ? `${config.prompt}\n\n${prContext}`
        : prContext;

      return sessionManager.spawn({
        ...config,
        projectId,
        prompt,
      });
    },
  };
}

export default { manifest, create } satisfies PluginModule<Poller>;
