/**
 * tracker-github plugin — GitHub Issues as an issue tracker.
 *
 * Uses the `gh` CLI for all GitHub API interactions.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@jleechanorg/ao-core";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ghExec(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
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
 * Map REST issue JSON to the same shape as `gh issue view --json` / `gh issue list --json`.
 */
function mapRestIssueToGhShape(rest: Record<string, unknown>): Record<string, unknown> {
  const labels = Array.isArray(rest.labels)
    ? (rest.labels as Array<Record<string, unknown>>).map((l) => ({ name: l.name }))
    : [];
  const assignees = Array.isArray(rest.assignees)
    ? (rest.assignees as Array<Record<string, unknown>>).map((a) => ({ login: a.login }))
    : [];
  return {
    number: rest.number,
    title: rest.title,
    body: rest.body ?? "",
    url: rest.html_url,
    state: typeof rest.state === "string" ? rest.state.toUpperCase() : "OPEN",
    stateReason: rest.state_reason ?? null,
    labels,
    assignees,
  };
}

/**
 * REST fallback for `gh issue view` — calls GET /repos/{owner}/{repo}/issues/{number}.
 */
async function issueViewRestFallback(repo: string, issueNumber: string): Promise<string> {
  const raw = await ghExec(["api", `repos/${repo}/issues/${issueNumber}`]);
  const restObj = JSON.parse(raw) as Record<string, unknown>;
  return JSON.stringify(mapRestIssueToGhShape(restObj));
}

/**
 * REST fallback for `gh issue list` — calls GET /repos/{owner}/{repo}/issues.
 */
async function issueListRestFallback(repo: string, state: string, limit: number, labels?: string, assignee?: string): Promise<string> {
  const params = new URLSearchParams();
  params.set("state", state === "ALL" ? "all" : state.toLowerCase());
  params.set("per_page", String(Math.min(limit, 100)));
  if (labels) params.set("labels", labels);
  if (assignee) params.set("assignee", assignee);
  const raw = await ghExec(["api", `repos/${repo}/issues?${params.toString()}`]);
  const restIssues = JSON.parse(raw) as Array<Record<string, unknown>>;
  // REST /issues also returns PRs — filter them out (PRs have pull_request key)
  const issuesOnly = restIssues.filter((i) => !i.pull_request);
  return JSON.stringify(issuesOnly.map(mapRestIssueToGhShape));
}

/**
 * Execute gh CLI with rate limit retry and REST fallback.
 */
async function gh(args: string[], maxRetries = 3): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await ghExec(args);
    } catch (err) {
      lastError = err;
      if (isRateLimitError(err)) {
        if (attempt < maxRetries - 1) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30000);
          console.warn(`[tracker-github] Rate limit detected, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})`);
          await sleep(backoffMs);
        }
      } else {
        throw err;
      }
    }
  }

  // All retries exhausted — try REST fallback for read operations
  if (args[0] === "issue" && args[1] === "view") {
    const repoIdx = args.indexOf("--repo");
    const repo = repoIdx !== -1 ? args[repoIdx + 1] : null;
    const identifier = args[2];
    if (repo && identifier) {
      console.warn("[tracker-github] Rate limit retries exhausted, falling back to REST API for issue view");
      try {
        return await issueViewRestFallback(repo, identifier);
      } catch {
        // REST fallback failed — rethrow original
      }
    }
  }

  if (args[0] === "issue" && args[1] === "list") {
    const repoIdx = args.indexOf("--repo");
    const repo = repoIdx !== -1 ? args[repoIdx + 1] : null;
    const stateIdx = args.indexOf("--state");
    const state = stateIdx !== -1 ? (args[stateIdx + 1] ?? "open") : "open";
    const limitIdx = args.indexOf("--limit");
    const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1] ?? "30", 10) : 30;
    const labelIdx = args.indexOf("--label");
    const labels = labelIdx !== -1 ? args[labelIdx + 1] : undefined;
    const assigneeIdx = args.indexOf("--assignee");
    const assignee = assigneeIdx !== -1 ? args[assigneeIdx + 1] : undefined;
    if (repo) {
      console.warn("[tracker-github] Rate limit retries exhausted, falling back to REST API for issue list");
      try {
        return await issueListRestFallback(repo, state, limit, labels, assignee);
      } catch {
        // REST fallback failed — rethrow original
      }
    }
  }

  // Write operations (close, reopen, edit, comment, create) cannot easily be mapped
  // to REST without the gh auth token dance, and they are low-frequency. For these,
  // just rethrow the original error so the caller can retry later.

  if (lastError instanceof Error) throw lastError;
  throw new Error(String(lastError));
}

function getErrorText(err: unknown): string {
  if (!(err instanceof Error)) return "";

  const details: string[] = [err.message];
  const withIo = err as Error & { stderr?: string; stdout?: string; cause?: unknown };
  if (typeof withIo.stderr === "string") details.push(withIo.stderr);
  if (typeof withIo.stdout === "string") details.push(withIo.stdout);
  if (withIo.cause instanceof Error) details.push(getErrorText(withIo.cause));

  return details.join("\n").toLowerCase();
}

function isUnknownJsonFieldError(err: unknown, fieldName: string): boolean {
  const text = getErrorText(err);
  if (!text) return false;

  const unknownFieldSignals =
    text.includes("unknown json field") ||
    text.includes("unknown field") ||
    text.includes("invalid field");

  return unknownFieldSignals && text.includes(fieldName.toLowerCase());
}

async function ghIssueViewJson(identifier: string, project: ProjectConfig): Promise<string> {
  const fieldsWithStateReason = "number,title,body,url,state,stateReason,labels,assignees";
  try {
    return await gh([
      "issue",
      "view",
      identifier,
      "--repo",
      project.repo,
      "--json",
      fieldsWithStateReason,
    ]);
  } catch (err) {
    if (!isUnknownJsonFieldError(err, "stateReason")) throw err;
    return gh([
      "issue",
      "view",
      identifier,
      "--repo",
      project.repo,
      "--json",
      "number,title,body,url,state,labels,assignees",
    ]);
  }
}

async function ghIssueListJson(args: string[]): Promise<string> {
  const withStateReason = [
    ...args,
    "--json",
    "number,title,body,url,state,stateReason,labels,assignees",
  ];
  try {
    return await gh(withStateReason);
  } catch (err) {
    if (!isUnknownJsonFieldError(err, "stateReason")) throw err;
    return gh([...args, "--json", "number,title,body,url,state,labels,assignees"]);
  }
}

function mapState(ghState: string, stateReason?: string | null): Issue["state"] {
  const s = ghState.toUpperCase();
  if (s === "CLOSED") {
    if (stateReason?.toUpperCase() === "NOT_PLANNED") return "cancelled";
    return "closed";
  }
  return "open";
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createGitHubTracker(): Tracker {
  return {
    name: "github",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const raw = await ghIssueViewJson(identifier, project);

      const data: {
        number: number;
        title: string;
        body: string;
        url: string;
        state: string;
        stateReason?: string | null;
        labels: Array<{ name: string }>;
        assignees: Array<{ login: string }>;
      } = JSON.parse(raw);

      return {
        id: String(data.number),
        title: data.title,
        description: data.body ?? "",
        url: data.url,
        state: mapState(data.state, data.stateReason),
        labels: data.labels.map((l) => l.name),
        assignee: data.assignees[0]?.login,
      };
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const raw = await gh([
        "issue",
        "view",
        identifier,
        "--repo",
        project.repo,
        "--json",
        "state",
      ]);
      const data: { state: string } = JSON.parse(raw);
      return data.state.toUpperCase() === "CLOSED";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const num = identifier.replace(/^#/, "");
      return `https://github.com/${project.repo}/issues/${num}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract issue number from GitHub URL
      // Example: https://github.com/owner/repo/issues/42 → "#42"
      const match = url.match(/\/issues\/(\d+)/);
      if (match) {
        return `#${match[1]}`;
      }
      // Fallback: return the last segment of the URL
      const parts = url.split("/");
      const lastPart = parts[parts.length - 1];
      return lastPart ? `#${lastPart}` : url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      const num = identifier.replace(/^#/, "");
      return `feat/issue-${num}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on GitHub issue #${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }

      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this issue. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const args = [
        "issue",
        "list",
        "--repo",
        project.repo,
        "--limit",
        String(filters.limit ?? 30),
      ];

      if (filters.state === "closed") {
        args.push("--state", "closed");
      } else if (filters.state === "all") {
        args.push("--state", "all");
      } else {
        args.push("--state", "open");
      }

      if (filters.labels && filters.labels.length > 0) {
        args.push("--label", filters.labels.join(","));
      }

      if (filters.assignee) {
        args.push("--assignee", filters.assignee);
      }

      const raw = await ghIssueListJson(args);
      const issues: Array<{
        number: number;
        title: string;
        body: string;
        url: string;
        state: string;
        stateReason?: string | null;
        labels: Array<{ name: string }>;
        assignees: Array<{ login: string }>;
      }> = JSON.parse(raw);

      return issues.map((data) => ({
        id: String(data.number),
        title: data.title,
        description: data.body ?? "",
        url: data.url,
        state: mapState(data.state, data.stateReason),
        labels: data.labels.map((l) => l.name),
        assignee: data.assignees[0]?.login,
      }));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      // Handle state change — GitHub Issues only supports open/closed.
      // "in_progress" is not a GitHub state, so it is intentionally a no-op.
      if (update.state === "closed") {
        await gh(["issue", "close", identifier, "--repo", project.repo]);
      } else if (update.state === "open") {
        await gh(["issue", "reopen", identifier, "--repo", project.repo]);
      }

      // Handle label removal
      if (update.removeLabels && update.removeLabels.length > 0) {
        await gh([
          "issue",
          "edit",
          identifier,
          "--repo",
          project.repo,
          "--remove-label",
          update.removeLabels.join(","),
        ]);
      }

      // Handle label changes
      if (update.labels && update.labels.length > 0) {
        await gh([
          "issue",
          "edit",
          identifier,
          "--repo",
          project.repo,
          "--add-label",
          update.labels.join(","),
        ]);
      }

      // Handle assignee changes
      if (update.assignee) {
        await gh([
          "issue",
          "edit",
          identifier,
          "--repo",
          project.repo,
          "--add-assignee",
          update.assignee,
        ]);
      }

      // Handle comment
      if (update.comment) {
        await gh([
          "issue",
          "comment",
          identifier,
          "--repo",
          project.repo,
          "--body",
          update.comment,
        ]);
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const args = [
        "issue",
        "create",
        "--repo",
        project.repo,
        "--title",
        input.title,
        "--body",
        input.description ?? "",
      ];

      if (input.labels && input.labels.length > 0) {
        args.push("--label", input.labels.join(","));
      }

      if (input.assignee) {
        args.push("--assignee", input.assignee);
      }

      // gh issue create outputs the URL of the new issue
      const url = await gh(args);

      // Extract issue number from URL and fetch full details
      const match = url.match(/\/issues\/(\d+)/);
      if (!match) {
        throw new Error(`Failed to parse issue URL from gh output: ${url}`);
      }
      const number = match[1];

      return this.getIssue(number, project);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "github",
  slot: "tracker" as const,
  description: "Tracker plugin: GitHub Issues",
  version: "0.1.0",
};

export function create(): Tracker {
  return createGitHubTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
