/**
 * GitHub API client — thin wrapper around `gh` CLI for skeptic CLI.
 * All GitHub IO lives here so it can be unit-tested in isolation.
 */

import { exec } from "../../lib/shell.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Fetch the design doc for a PR via GitHub API, falling back to local filesystem.
 *
 * GitHub API is tried first so this works regardless of the current working
 * directory — the lifecycle-manager and CI runners may invoke `ao` from a
 * different repo root than the target repo.  The local-filesystem fallback
 * remains for backward compatibility (e.g. unit tests without owner/repo).
 *
 * @param owner     GitHub owner (e.g. "jleechanorg"); null falls through to filesystem
 * @param repo      GitHub repo  (e.g. "worldarchitect.ai"); null falls through to filesystem
 * @param prNumber  PR number used to construct the doc path
 * @param ref       Git ref (branch name or SHA) to read from; defaults to repo default branch
 */
export async function fetchDesignDoc(
  owner: string | null,
  repo: string | null,
  prNumber: number,
  ref?: string,
): Promise<string | null> {
  const docPath = `docs/design/pr-designs/pr-${prNumber}.md`;

  // Primary: GitHub API (cwd-agnostic; works from any repo or CI runner)
  if (owner && repo) {
    try {
      const refSuffix = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      const endpoint = `repos/${owner}/${repo}/contents/${docPath}${refSuffix}`;
      const data = (await ghJson(endpoint)) as {
        content?: string;
        encoding?: string;
      } | null;
      if (data?.content && data?.encoding === "base64") {
        return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
      }
      return null;
    } catch {
      // API call failed with owner/repo provided — do not fall back to local checkout.
      // Local checkout is cwd-dependent and would reintroduce the problem we're fixing.
      return null;
    }
  }

  // Fallback: local checkout (only reached when owner/repo are null)
  try {
    const { stdout: repoRoot } = await exec("git", ["rev-parse", "--show-toplevel"]);
    const root = repoRoot.trim();
    const designDocPath = join(root, docPath);
    return readFileSync(designDocPath, "utf8");
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

export async function ghJson(endpoint: string, args: string[] = []): Promise<unknown> {
  const result = await exec("gh", ["api", endpoint, ...args]);
  return JSON.parse(result.stdout);
}

/** Like ghJson but uses --paginate to fetch all pages automatically (REST only). */
export async function ghJsonPaginate(endpoint: string, args: string[] = []): Promise<unknown> {
  const result = await exec("gh", ["api", "--paginate", "--slurp", endpoint, ...args]);
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
  // ghJsonPaginate uses --paginate --slurp: each page is a separate array element.
  // Flatten to a single array so all pages of comments are returned and iterated.
  const pages = (await ghJsonPaginate(
    "repos/" + owner + "/" + repo + "/issues/" + prNumber + "/comments",
  )) as Array<IssueComment[]>;
  return (pages ?? []).flat();
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
