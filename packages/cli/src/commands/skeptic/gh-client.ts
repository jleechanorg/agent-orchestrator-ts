/**
 * GitHub API client — thin wrapper around `gh` CLI for skeptic CLI.
 * All GitHub IO lives here so it can be unit-tested in isolation.
 */

import { exec } from "../../lib/shell.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Read the design doc for a PR from the local checkout.
 * Works both in CI (file is checked out) and locally (agent has repo).
 * Returns null if the design doc does not exist yet.
 *
 * Uses `git rev-parse --show-toplevel` to resolve the repo root explicitly,
 * so this works even when the CLI is invoked from a subdirectory or with
 * a `--repo` flag that doesn't match the current working directory.
 * Only ENOENT is treated as "doc not found" — all other errors are re-thrown.
 */
export async function fetchDesignDoc(prNumber: number): Promise<string | null> {
  try {
    // Resolve the repo root so we always find docs/design/pr-designs/
    // regardless of the current working directory.
    const { stdout: repoRoot } = await exec("git", ["rev-parse", "--show-toplevel"]);
    const root = repoRoot.trim();
    const designDocPath = join(root, "docs", "design", "pr-designs", `pr-${prNumber}.md`);
    const content = readFileSync(designDocPath, "utf8");
    return content;
  } catch (err: unknown) {
    // Only swallow "file not found" — re-throw any other error (permissions, invalid cwd, etc.)
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      // Design doc does not exist yet — this is a gap the skeptic should flag
      return null;
    }
    throw err;
  }
}

export async function ghJson(endpoint: string, args: string[] = []): Promise<unknown> {
  const result = await exec("gh", ["api", endpoint, ...args]);
  return JSON.parse(result.stdout);
}

/** Like ghJson but uses --paginate to fetch all pages automatically (REST only). */
export async function ghJsonPaginate(endpoint: string, args: string[] = []): Promise<unknown> {
  const result = await exec("gh", ["api", "--paginate", endpoint, ...args]);
  return JSON.parse(result.stdout);
}

export interface PRInfo {
  number: number;
  title: string;
  body: string;
  state: string;
  headRefOid: string;
  baseRefName: string;
  isDraft: boolean;
}

export interface ReviewInfo {
  author: { login: string };
  state: "approved" | "changes_requested" | "commented" | "dismissed" | "pending";
  body: string | null;
  submittedAt: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string };
  createdAt: string;
  isMinimized?: boolean;
}

export async function fetchPRMeta(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PRInfo> {
  const query = [
    "{",
    `  repository(owner:"${owner}", name:"${repo}") {`,
    `    pullRequest(number:${prNumber}) {`,
    "      number title body state headRefOid baseRefName isDraft",
    "    }",
    "  }",
    "}",
  ].join("\n");
  const data = await ghJson("graphql", ["-f", "query=" + query]);
  const d = data as { data?: { repository?: { pullRequest?: PRInfo } } };
  const pr = d?.data?.repository?.pullRequest;
  if (!pr) throw new Error("PR not found");
  return pr;
}

export async function fetchReviews(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ReviewInfo[]> {
  const query = [
    "{",
    `  repository(owner:"${owner}", name:"${repo}") {`,
    `    pullRequest(number:${prNumber}) {`,
    "      reviewDecision",
    "      reviews(last:20) {",
    "        nodes { author { login } state body submittedAt }",
    "      }",
    "    }",
    "  }",
    "}",
  ].join("\n");
  const data = await ghJson("graphql", ["-f", "query=" + query]);
  const r = data as {
    data?: {
      repository?: {
        pullRequest?: {
          reviewDecision?: string;
          reviews?: { nodes?: ReviewInfo[] };
        };
      };
    };
  };
  return (r?.data?.repository?.pullRequest?.reviews?.nodes ?? []).map((n) => ({
    ...n,
    // Normalize GitHub GraphQL uppercase enum to lowercase to match the Review type
    state: (n.state as string).toLowerCase() as ReviewInfo["state"],
  })) as ReviewInfo[];
}

export async function fetchDiff(owner: string, repo: string, prNumber: number): Promise<string> {
  try {
    const result = await exec("gh", ["pr", "diff", "--repo", owner + "/" + repo, String(prNumber)]);
    return result.stdout;
  } catch {
    return "(diff unavailable)";
  }
}

export async function fetchIssueComments(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<IssueComment[]> {
  return (await ghJson(
    "repos/" + owner + "/" + repo + "/issues/" + prNumber + "/comments?per_page=100",
  )) as IssueComment[];
}

export async function patchComment(
  owner: string,
  repo: string,
  commentId: number,
  body: string,
): Promise<void> {
  await exec("gh", [
    "api",
    "--method", "PATCH",
    "repos/" + owner + "/" + repo + "/issues/comments/" + commentId,
    "--field", "body=" + body,
  ]);
}

export async function createComment(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  await exec("gh", [
    "api",
    "repos/" + owner + "/" + repo + "/issues/" + prNumber + "/comments",
    "--field", "body=" + body,
  ]);
}
