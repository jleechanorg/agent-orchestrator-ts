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
 * GitHub API is tried first (when owner+repo provided) so this works regardless
 * of cwd — lifecycle-manager and CI runners invoke `ao` from a different repo root.
 * On 404 the doc doesn't exist yet — returns null.  Other API errors are re-thrown
 * so the caller decides whether to skip or abort (no silent local-checkout fallback
 * when owner/repo are provided, which would return stale content from the wrong repo).
 * The local-filesystem fallback is only used when owner/repo are null (unit tests).
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
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string };
      const combined = (error.stdout ?? "") + (error.stderr ?? "");
      // 404 → file doesn't exist yet (design doc not written yet for this PR)
      if (combined.includes('"status": "404"') || combined.includes("HTTP 404")) {
        return null;
      }
      // Re-throw other errors (auth, network, rate-limit) — do not silently fall back
      // to local checkout, which would reintroduce cwd-dependence and could return
      // content from the wrong repo when the lifecycle-worker runs from AO repo root.
      throw err;
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
  /**
   * The commit OID this review is attached to. Populated from the
   * GraphQL `commit { oid }` field on the review node. Used to filter
   * stale CR reviews that were submitted on an older head SHA and that
   * GitHub's UI-level `reviewDecision` still reflects.
   */
  commitId?: string | null;
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
    // `commit { oid }` is required so callers can filter stale reviews
    // against the current head SHA. GitHub's UI-level `reviewDecision`
    // returns the worst state across ALL reviews (including ones on
    // superseded head SHAs) which causes false-FAIL verdicts.
    "        nodes { author { login } state body submittedAt commit { oid } }",
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
    commitId: (n as any).commit?.oid,
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

/**
 * Fetch the content of test files changed in a PR.
 * Extracts test file paths from the unified diff and fetches each via GitHub API.
 * Only returns content for files that appear to be tests (match common test patterns).
 * Falls back to gh pr diff --name-only to enumerate changed files when direct diff parsing
 * is insufficient.
 *
 * @param owner     GitHub owner
 * @param repo      GitHub repo
 * @param prNumber  PR number
 * @param diff      The full unified diff string (used to extract file paths)
 * @param ref       Git ref (branch name or SHA) to read from; defaults to PR head
 * @returns Map of filename → file content, for test files only
 */
export async function fetchTestFileContents(
  owner: string,
  repo: string,
  prNumber: number,
  diff: string,
  ref?: string,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  // Extract file paths from diff
  const filePaths = new Set<string>();
  for (const line of diff.split("\n")) {
    // Standard unified diff: --- a/foo.test.ts and +++ b/foo.test.ts
    const m1 = line.match(/^[+-]{3}[ \t][ab]\/(.+)$/);
    if (m1) {
      filePaths.add(m1[1]);
    }
    // git diff --git header: diff --git a/foo.test.ts b/foo.test.ts
    const m2 = line.match(/^diff --git [ab]\/(.+?) [ab]\/(.+)$/);
    if (m2) {
      filePaths.add(m2[2]);
    }
    // Binary file indicator: Binary files a/foo and b/foo differ
    const m3 = line.match(/^Binary files [ab]\/(.+) and [ab]\/(.+) differ$/);
    if (m3) {
      filePaths.add(m3[2]);
    }
  }

  // Filter to test files only
  const TEST_PATTERNS = [
    /\.test\./,
    /\.spec\./,
    /\/tests?\//,
    /__tests?__/,
    /\/test\//,
  ];
  const isTestFile = (path: string) => TEST_PATTERNS.some((re) => re.test(path));
  let testPaths = Array.from(filePaths).filter(isTestFile);

  // Fallback: if diff parsing yielded no test files, use gh pr diff --name-only
  if (testPaths.length === 0) {
    try {
      const listResult = await exec("gh", [
        "pr", "diff", "--name-only",
        "--repo", `${owner}/${repo}`,
        String(prNumber),
      ]);
      testPaths = listResult.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .filter(isTestFile);
    } catch {
      // gh unavailable or network error — degrade gracefully
    }
  }

  if (testPaths.length === 0) return results;

  // Fetch each test file via GitHub API — collect settled results first to ensure
  // deterministic insertion order (Promise.allSettled resolves in creation order, but we
  // insert after all settle to be explicit about testPaths ordering).
  const refSuffix = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const settledResults = await Promise.allSettled(
    testPaths.map(async (filePath): Promise<[string, string] | null> => {
      try {
        const endpoint = `repos/${owner}/${repo}/contents/${filePath}${refSuffix}`;
        const data = (await ghJson(endpoint)) as {
          content?: string;
          encoding?: string;
        } | null;
        if (data?.content && data?.encoding === "base64") {
          const content = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
          return [filePath, content];
        }
      } catch {
        // Individual file fetch failure is non-fatal — skip this file
      }
      return null;
    }),
  );

  // Insert into Map in testPaths order for deterministic output
  for (const result of settledResults) {
    if (result.status === "fulfilled" && result.value !== null) {
      results.set(result.value[0], result.value[1]);
    }
  }

  return results;
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
): Promise<string> {
  await exec("gh", [
    "api",
    "repos/" + owner + "/" + repo + "/issues/" + prNumber + "/comments",
    "--field", "body=" + body,
  ]);
  return body;
}
