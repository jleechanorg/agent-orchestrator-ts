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
 */
export async function fetchDesignDoc(prNumber: number): Promise<string | null> {
  // Design docs live at docs/design/pr-designs/pr-{N}.md in the repo
  // The CLI is always run from the repo root (checked out by the workflow or agent)
  try {
    const designDocPath = join(process.cwd(), "docs", "design", "pr-designs", `pr-${prNumber}.md`);
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
