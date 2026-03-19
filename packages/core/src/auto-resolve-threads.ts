export interface AutoResolveConfig {
  owner: string;
  repo: string;
  prNumber: number;
  changedFiles: string[];
  dryRun?: boolean;
}

export interface ResolvedThread {
  threadId: string;
  path: string;
  author: string;
}

export interface SkippedThread {
  threadId: string;
  path: string;
  reason: string;
}

export interface ThreadError {
  threadId: string;
  error: string;
}

export interface AutoResolveResult {
  resolved: ResolvedThread[];
  skipped: SkippedThread[];
  errors: ThreadError[];
}

export interface GraphQLExecutor {
  execute(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<unknown>;
}

interface GQLComment {
  author: { login: string } | null;
  body: string;
}

interface GQLThread {
  id: string;
  isResolved: boolean;
  path: string;
  comments: { nodes: GQLComment[]; pageInfo: { hasNextPage: boolean } };
}

interface GQLResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: GQLThread[];
      };
    };
  };
}

const BOT_AUTHORS = new Set([
  "coderabbitai",
  "coderabbitai[bot]",
  "github-actions",
  "github-actions[bot]",
  "copilot",
  "copilot-pull-request-reviewer",
  "copilot-pull-request-reviewer[bot]",
  "chatgpt-codex-connector[bot]",
]);

function isBotAuthor(login: string): boolean {
  if (BOT_AUTHORS.has(login)) return true;
  if (login.endsWith("[bot]")) return true;
  return false;
}

const FETCH_THREADS_QUERY = `
query GetUnresolvedThreads($owner: String!, $repo: String!, $prNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          path
          comments(first: 100) {
            pageInfo {
              hasNextPage
            }
            nodes {
              author {
                login
              }
              body
            }
          }
        }
      }
    }
  }
}`;

const RESOLVE_THREAD_MUTATION = `
mutation ResolveThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread {
      id
      isResolved
    }
  }
}`;

function isGQLResponse(data: unknown): data is GQLResponse {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  if (typeof d.repository !== "object" || d.repository === null) return false;
  const repo = d.repository as Record<string, unknown>;
  if (typeof repo.pullRequest !== "object" || repo.pullRequest === null)
    return false;
  const pr = repo.pullRequest as Record<string, unknown>;
  if (typeof pr.reviewThreads !== "object" || pr.reviewThreads === null)
    return false;
  const rt = pr.reviewThreads as Record<string, unknown>;
  return Array.isArray(rt.nodes);
}

function isBotThread(thread: GQLThread): boolean {
  if (thread.comments.nodes.length === 0) return false;
  return thread.comments.nodes.every((comment) => {
    if (!comment.author) return false;
    return isBotAuthor(comment.author.login);
  });
}

function getFirstAuthor(thread: GQLThread): string {
  const first = thread.comments.nodes[0];
  return first?.author?.login ?? "unknown";
}

export async function autoResolveThreads(
  config: AutoResolveConfig,
  executor: GraphQLExecutor,
): Promise<AutoResolveResult> {
  const resolved: ResolvedThread[] = [];
  const skipped: SkippedThread[] = [];
  const errors: ThreadError[] = [];

  const changedSet = new Set(config.changedFiles);

  const data = await executor.execute(FETCH_THREADS_QUERY, {
    owner: config.owner,
    repo: config.repo,
    prNumber: config.prNumber,
  });

  if (!isGQLResponse(data)) {
    errors.push({
      threadId: "N/A",
      error: "Unexpected GraphQL response shape — cannot process review threads",
    });
    return { resolved, skipped, errors };
  }

  const threads = data.repository.pullRequest.reviewThreads.nodes;

  for (const thread of threads) {
    if (thread.isResolved) {
      skipped.push({
        threadId: thread.id,
        path: thread.path,
        reason: "already resolved",
      });
      continue;
    }

    if (!changedSet.has(thread.path)) {
      skipped.push({
        threadId: thread.id,
        path: thread.path,
        reason: "file not in changeset",
      });
      continue;
    }

    if (thread.comments.pageInfo.hasNextPage) {
      skipped.push({
        threadId: thread.id,
        path: thread.path,
        reason: "truncated comment list — cannot verify bot-only",
      });
      continue;
    }

    if (!isBotThread(thread)) {
      skipped.push({
        threadId: thread.id,
        path: thread.path,
        reason: "human reviewer",
      });
      continue;
    }

    if (config.dryRun) {
      resolved.push({
        threadId: thread.id,
        path: thread.path,
        author: getFirstAuthor(thread),
      });
      continue;
    }

    try {
      await executor.execute(RESOLVE_THREAD_MUTATION, {
        threadId: thread.id,
      });
      resolved.push({
        threadId: thread.id,
        path: thread.path,
        author: getFirstAuthor(thread),
      });
    } catch (err) {
      errors.push({
        threadId: thread.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { resolved, skipped, errors };
}
