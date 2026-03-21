/**
 * poller-github-pr plugin — scans open GitHub PRs and spawns fix sessions.
 *
 * This poller focuses on PRs where CodeRabbit has CHANGES_REQUESTED.
 * Poller-manager handles duplicate prevention (active sessions) and respawn caps.
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
} from "@jleechanorg/ao-core";

const execFileAsync = promisify(execFile);

interface GitHubReview {
  author?: { login?: string | null } | null;
  state?: string | null;
  submittedAt?: string | null;
}

interface GitHubPR {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  statusCheckRollup: Array<{ state: string; conclusion: string | null }> | null;
  mergeable: string;
  latestReviews?: GitHubReview[] | null;
}

async function ghExec(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    ...(cwd ? { cwd } : {}),
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Rate Limit Handling — mirrors scm-github pattern
// ---------------------------------------------------------------------------

const RATE_LIMIT_ERROR_PATTERNS = [
  "rate limit",
  "API rate limit",
  "GraphQL rate limit",
  "Too Many Requests",
];

function isRateLimitError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return RATE_LIMIT_ERROR_PATTERNS.some((p) => msg.toLowerCase().includes(p.toLowerCase()));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse `--repo owner/repo` from args.
 */
function extractRepo(args: string[]): string | null {
  const idx = args.indexOf("--repo");
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

/**
 * Convert REST PR response to the same shape as `gh pr list --json` output.
 */
function mapRestPrToGhPrListShape(rest: Record<string, unknown>): Record<string, unknown> {
  const head = rest.head as Record<string, unknown> | undefined;
  const base = rest.base as Record<string, unknown> | undefined;
  return {
    number: rest.number,
    title: rest.title,
    url: rest.html_url,
    isDraft: Boolean(rest.draft),
    headRefName: head?.ref ?? "",
    baseRefName: base?.ref ?? "",
    mergeable: rest.mergeable === true ? "MERGEABLE" : rest.mergeable === false ? "CONFLICTING" : "UNKNOWN",
    // REST /pulls does not include statusCheckRollup or latestReviews — leave null
    // so downstream logic treats them conservatively.
    statusCheckRollup: null,
    latestReviews: null,
  };
}

/**
 * REST fallback for `gh pr list --json ...` — calls GET /repos/{owner}/{repo}/pulls.
 */
async function prListRestFallback(repo: string): Promise<string> {
  const raw = await ghExec(["api", `repos/${repo}/pulls?state=open&per_page=100`]);
  const restPrs = JSON.parse(raw) as Array<Record<string, unknown>>;
  return JSON.stringify(restPrs.map(mapRestPrToGhPrListShape));
}

/**
 * Execute `gh pr list` with rate-limit retry and REST fallback.
 */
async function ghPrListWithRetry(args: string[], cwd?: string, maxRetries = 3): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await ghExec(args, cwd);
    } catch (err) {
      lastError = err;
      if (isRateLimitError(err)) {
        if (attempt < maxRetries - 1) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30000);
          console.warn(`[poller-github-pr] Rate limit detected, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})`);
          await sleep(backoffMs);
        }
      } else {
        throw err;
      }
    }
  }

  // All retries exhausted — try REST fallback for `gh pr list`
  if (args[0] === "pr" && args[1] === "list") {
    const repo = extractRepo(args);
    if (repo) {
      console.warn("[poller-github-pr] Rate limit retries exhausted, falling back to REST API for pr list");
      try {
        return await prListRestFallback(repo);
      } catch {
        // REST fallback failed too — rethrow original
      }
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error(String(lastError));
}

function isCIPassing(pr: GitHubPR): boolean {
  const checks = pr.statusCheckRollup;
  if (!checks || checks.length === 0) return true;
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

function getLatestCodeRabbitState(pr: GitHubPR): "CHANGES_REQUESTED" | "APPROVED" | null {
  const decisive = (pr.latestReviews ?? [])
    .filter((r) => (r.author?.login ?? "").toLowerCase() === "coderabbitai[bot]")
    .filter((r) => {
      const state = (r.state ?? "").toUpperCase();
      return state === "APPROVED" || state === "CHANGES_REQUESTED";
    })
    .sort(
      (a, b) =>
        new Date(b.submittedAt ?? 0).getTime() -
        new Date(a.submittedAt ?? 0).getTime(),
    );

  const latest = decisive[0];
  if (!latest?.state) return null;
  const state = latest.state.toUpperCase();
  if (state === "APPROVED" || state === "CHANGES_REQUESTED") return state;
  return null;
}

export const manifest = {
  name: "github-pr",
  slot: "poller" as const,
  description: "Poller plugin: scans GitHub PRs and routes CodeRabbit CHANGES_REQUESTED to agents",
  version: "0.1.0",
  displayName: "GitHub PR Poller",
};

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
        "number,title,url,isDraft,headRefName,baseRefName,statusCheckRollup,mergeable,latestReviews",
        "--limit",
        "50",
      ];

      if (repo) {
        args.push("--repo", repo);
      }

      let raw: string;
      try {
        raw = await ghPrListWithRetry(args);
      } catch (err) {
        const message = `[poller-github-pr] Failed to list PRs for project ${projectId}: ${(err as Error).message}`;
        throw err instanceof Error ? new Error(message, { cause: err }) : new Error(message);
      }

      let prs: GitHubPR[];
      try {
        prs = JSON.parse(raw) as GitHubPR[];
      } catch {
        throw new Error(`[poller-github-pr] Failed to parse gh pr list output: ${raw}`);
      }

      const workItems: PollerWorkItem[] = [];

      for (const pr of prs) {
        if (pr.isDraft) continue;

        const codeRabbitState = getLatestCodeRabbitState(pr);
        if (codeRabbitState !== "CHANGES_REQUESTED") {
          continue;
        }

        const ciPassing = isCIPassing(pr);
        const reasons = ["changes-requested"];
        if (!ciPassing) {
          reasons.push("ci-failing");
        }

        workItems.push({
          id: `pr-${pr.number}`,
          type: "open-pr",
          title: pr.title,
          url: pr.url,
          priority: !ciPassing ? 1 : 2,
          metadata: {
            prNumber: pr.number,
            branch: pr.headRefName,
            baseBranch: pr.baseRefName,
            reasons,
            ciPassing,
            mergeable: pr.mergeable,
            codeRabbitState,
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

      const prContext = [
        `Fix PR #${prNumber ?? workItem.id}: ${workItem.title}`,
        `URL: ${workItem.url}`,
        reasons.length > 0 ? `Issues: ${reasons.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const prompt = config.prompt ? `${config.prompt}\n\n${prContext}` : prContext;

      return sessionManager.spawn({
        ...config,
        projectId,
        prompt,
      });
    },
  };
}

export default { manifest, create } satisfies PluginModule<Poller>;
