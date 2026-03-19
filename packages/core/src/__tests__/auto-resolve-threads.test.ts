import { describe, it, expect, vi } from "vitest";
import { autoResolveThreads } from "../auto-resolve-threads.js";
import type {
  AutoResolveConfig,
  GraphQLExecutor,
} from "../auto-resolve-threads.js";

function makeGQLResponse(
  threads: Array<{
    id: string;
    isResolved: boolean;
    path: string;
    authors: string[];
  }>,
): unknown {
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: threads.map((t) => ({
            id: t.id,
            isResolved: t.isResolved,
            path: t.path,
            comments: {
              nodes: t.authors.map((login) => ({
                author: { login },
                body: "comment",
              })),
            },
          })),
        },
      },
    },
  };
}

function makeExecutor(
  queryResponse: unknown,
  mutationResponse?: unknown,
): GraphQLExecutor {
  return {
    execute: vi
      .fn()
      .mockResolvedValueOnce(queryResponse)
      .mockResolvedValue(
        mutationResponse ?? {
          resolveReviewThread: { thread: { id: "t1", isResolved: true } },
        },
      ),
  };
}

const baseConfig: AutoResolveConfig = {
  owner: "test-owner",
  repo: "test-repo",
  prNumber: 42,
  changedFiles: ["src/foo.ts"],
};

describe("autoResolveThreads", () => {
  it("returns empty result when no unresolved threads", async () => {
    const executor = makeExecutor(makeGQLResponse([]));
    const result = await autoResolveThreads(baseConfig, executor);
    expect(result).toEqual({ resolved: [], skipped: [], errors: [] });
  });

  it("resolves thread on changed file from bot", async () => {
    const executor = makeExecutor(
      makeGQLResponse([
        {
          id: "t1",
          isResolved: false,
          path: "src/foo.ts",
          authors: ["coderabbitai"],
        },
      ]),
    );

    const result = await autoResolveThreads(baseConfig, executor);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]).toEqual({
      threadId: "t1",
      path: "src/foo.ts",
      author: "coderabbitai",
    });
    expect(executor.execute).toHaveBeenCalledTimes(2); // query + mutation
  });

  it("skips thread on unchanged file", async () => {
    const executor = makeExecutor(
      makeGQLResponse([
        {
          id: "t1",
          isResolved: false,
          path: "src/bar.ts",
          authors: ["coderabbitai"],
        },
      ]),
    );

    const result = await autoResolveThreads(baseConfig, executor);

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toEqual({
      threadId: "t1",
      path: "src/bar.ts",
      reason: "file not in changeset",
    });
    expect(result.resolved).toHaveLength(0);
  });

  it("skips thread from human reviewer", async () => {
    const executor = makeExecutor(
      makeGQLResponse([
        {
          id: "t1",
          isResolved: false,
          path: "src/foo.ts",
          authors: ["johndoe"],
        },
      ]),
    );

    const result = await autoResolveThreads(baseConfig, executor);

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toEqual({
      threadId: "t1",
      path: "src/foo.ts",
      reason: "human reviewer",
    });
  });

  it("handles multiple threads with mixed results", async () => {
    const config: AutoResolveConfig = {
      ...baseConfig,
      changedFiles: ["src/a.ts", "src/b.ts"],
    };
    const executor = makeExecutor(
      makeGQLResponse([
        {
          id: "t1",
          isResolved: false,
          path: "src/a.ts",
          authors: ["coderabbitai"],
        },
        {
          id: "t2",
          isResolved: false,
          path: "src/b.ts",
          authors: ["alice"],
        },
        {
          id: "t3",
          isResolved: false,
          path: "src/c.ts",
          authors: ["github-actions[bot]"],
        },
      ]),
    );

    const result = await autoResolveThreads(config, executor);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]!.threadId).toBe("t1");
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.find((s) => s.threadId === "t2")!.reason).toBe(
      "human reviewer",
    );
    expect(result.skipped.find((s) => s.threadId === "t3")!.reason).toBe(
      "file not in changeset",
    );
  });

  it("captures GraphQL error during mutation in errors array", async () => {
    const executor: GraphQLExecutor = {
      execute: vi
        .fn()
        .mockResolvedValueOnce(
          makeGQLResponse([
            {
              id: "t1",
              isResolved: false,
              path: "src/foo.ts",
              authors: ["coderabbitai"],
            },
          ]),
        )
        .mockRejectedValueOnce(new Error("GraphQL mutation failed")),
    };

    const result = await autoResolveThreads(baseConfig, executor);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual({
      threadId: "t1",
      error: "GraphQL mutation failed",
    });
    expect(result.resolved).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it("does not call mutation in dryRun mode", async () => {
    const config: AutoResolveConfig = { ...baseConfig, dryRun: true };
    const executor = makeExecutor(
      makeGQLResponse([
        {
          id: "t1",
          isResolved: false,
          path: "src/foo.ts",
          authors: ["coderabbitai"],
        },
      ]),
    );

    const result = await autoResolveThreads(config, executor);

    expect(result.resolved).toHaveLength(1);
    expect(executor.execute).toHaveBeenCalledTimes(1); // query only
  });

  it("recognizes all known bot authors", async () => {
    const config: AutoResolveConfig = {
      ...baseConfig,
      changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
      dryRun: true,
    };
    const executor = makeExecutor(
      makeGQLResponse([
        {
          id: "t1",
          isResolved: false,
          path: "src/a.ts",
          authors: ["coderabbitai"],
        },
        {
          id: "t2",
          isResolved: false,
          path: "src/b.ts",
          authors: ["github-actions[bot]"],
        },
        {
          id: "t3",
          isResolved: false,
          path: "src/c.ts",
          authors: ["copilot-pull-request-reviewer"],
        },
      ]),
    );

    const result = await autoResolveThreads(config, executor);

    expect(result.resolved).toHaveLength(3);
  });

  it("skips already resolved threads", async () => {
    const executor = makeExecutor(
      makeGQLResponse([
        {
          id: "t1",
          isResolved: true,
          path: "src/foo.ts",
          authors: ["coderabbitai"],
        },
      ]),
    );

    const result = await autoResolveThreads(baseConfig, executor);

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toEqual({
      threadId: "t1",
      path: "src/foo.ts",
      reason: "already resolved",
    });
    expect(executor.execute).toHaveBeenCalledTimes(1); // query only
  });
});
