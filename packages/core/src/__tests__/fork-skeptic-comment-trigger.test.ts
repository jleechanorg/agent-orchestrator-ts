/**
 * Unit tests for detectAndTriggerSkepticComment.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { detectAndTriggerSkepticComment } from "../fork-skeptic-comment-trigger.js";
import type { Session, OrchestratorConfig, PluginRegistry, SCM } from "../types.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    projectId: "my-app",
    status: "pr_open",
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    worktree: "/tmp/wt",
    branch: "feat/test",
    ...overrides,
  };
}

function makePR(): Session["pr"] {
  return {
    number: 42,
    url: "https://github.com/org/repo/pull/42",
  };
}

function makeMockSCM(comments: Array<{ id: number; user: { login: string }; body: string }> = []) {
  return {
    name: "mock-scm",
    detectPR: vi.fn(),
    getPRState: vi.fn(),
    mergePR: vi.fn(),
    closePR: vi.fn(),
    getCIChecks: vi.fn(),
    getCISummary: vi.fn(),
    getReviews: vi.fn(),
    getReviewDecision: vi.fn(),
    getPendingComments: vi.fn(),
    getAutomatedComments: vi.fn(),
    listPRComments: vi.fn().mockResolvedValue(comments),
  } as unknown as SCM;
}

describe("detectAndTriggerSkepticComment", () => {
  let mockTrigger: ReturnType<typeof vi.fn>;
  let processedCommentIds: Map<string, Set<number>>;
  let lastSkepticSha: Map<string, string>;
  let config: OrchestratorConfig;
  let registry: PluginRegistry;

  beforeEach(() => {
    mockTrigger = vi.fn().mockResolvedValue(true);
    processedCommentIds = new Map();
    lastSkepticSha = new Map();
    config = {
      defaults: {},
      plugins: {},
      reactions: {},
      projects: {
        "my-app": {
          name: "my-app",
          scm: {},
        },
      },
    };
  });

  it("returns early when session has no pr", async () => {
    const session = makeSession({ pr: undefined });
    const scm = makeMockSCM([{ id: 1, user: { login: "jleechan2015" }, body: "/skeptic" }]);
    registry = {
      get: vi.fn().mockReturnValue(scm),
    } as unknown as PluginRegistry;

    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );

    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("returns early when project is not in config", async () => {
    const session = makeSession({ projectId: "unknown-app", pr: makePR() });
    const scm = makeMockSCM([{ id: 1, user: { login: "jleechan2015" }, body: "/skeptic" }]);
    registry = {
      get: vi.fn().mockReturnValue(scm),
    } as unknown as PluginRegistry;

    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );

    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("returns early when scm plugin is not available", async () => {
    const session = makeSession({ pr: makePR() });
    registry = {
      get: vi.fn().mockReturnValue(null),
    } as unknown as PluginRegistry;

    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );

    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("skips bot-authored comments", async () => {
    const session = makeSession({ pr: makePR() });
    const scm = makeMockSCM([
      { id: 1, user: { login: "github-actions[bot]" }, body: "/skeptic" },
    ]);
    registry = {
      get: vi.fn().mockReturnValue(scm),
    } as unknown as PluginRegistry;

    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );

    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("skips non-/skeptic comments", async () => {
    const session = makeSession({ pr: makePR() });
    const scm = makeMockSCM([
      { id: 1, user: { login: "jleechan2015" }, body: "looks good!" },
    ]);
    registry = {
      get: vi.fn().mockReturnValue(scm),
    } as unknown as PluginRegistry;

    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );

    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("fires triggerSkepticReaction when a human posts /skeptic", async () => {
    const session = makeSession({ id: "sess-1", pr: makePR() });
    const scm = makeMockSCM([
      { id: 1, user: { login: "jleechan2015" }, body: "/skeptic" },
    ]);
    registry = {
      get: vi.fn().mockReturnValue(scm),
    } as unknown as PluginRegistry;

    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );

    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledWith(session, lastSkepticSha, "test-corr");
  });

  it("deduplicates: same comment ID does not fire trigger twice", async () => {
    const session = makeSession({ id: "sess-1", pr: makePR() });
    const scm = makeMockSCM([
      { id: 99, user: { login: "jleechan2015" }, body: "/skeptic" },
    ]);
    registry = {
      get: vi.fn().mockReturnValue(scm),
    } as unknown as PluginRegistry;

    // First call — should fire
    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );

    // Second call with same comment ID — should skip (already processed)
    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );

    expect(mockTrigger).toHaveBeenCalledTimes(1);
  });

  it("processes only the first /skeptic comment when multiple are present in one cycle", async () => {
    const session = makeSession({ id: "sess-1", pr: makePR() });
    const scm = makeMockSCM([
      { id: 10, user: { login: "alice" }, body: "/skeptic" },
      { id: 11, user: { login: "bob" }, body: "/skeptic" },
    ]);
    registry = {
      get: vi.fn().mockReturnValue(scm),
    } as unknown as PluginRegistry;

    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );

    // Only the first comment triggers; second is never reached (break after first)
    expect(mockTrigger).toHaveBeenCalledTimes(1);
  });

  it("handles scm.listPRComments throwing gracefully", async () => {
    const session = makeSession({ pr: makePR() });
    const scm = {
      ...makeMockSCM([]),
      listPRComments: vi.fn().mockRejectedValue(new Error("network error")),
    };
    registry = {
      get: vi.fn().mockReturnValue(scm),
    } as unknown as PluginRegistry;

    await expect(
      detectAndTriggerSkepticComment(
        session,
        processedCommentIds,
        lastSkepticSha,
        "test-corr",
        config,
        registry,
        mockTrigger,
      ),
    ).resolves.not.toThrow();

    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("trims body and still detects /skeptic", async () => {
    const session = makeSession({ id: "sess-1", pr: makePR() });
    const scm = makeMockSCM([
      { id: 1, user: { login: "jleechan2015" }, body: "/skeptic" },
    ]);
    registry = {
      get: vi.fn().mockReturnValue(scm),
    } as unknown as PluginRegistry;

    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );

    expect(mockTrigger).toHaveBeenCalledTimes(1);
  });

  it("does not fire trigger when /skeptic has trailing content on same line", async () => {
    const session = makeSession({ id: "sess-1", pr: makePR() });
    const scm = makeMockSCM([
      { id: 1, user: { login: "jleechan2015" }, body: "please run /skeptic on this" },
    ]);
    registry = {
      get: vi.fn().mockReturnValue(scm),
    } as unknown as PluginRegistry;

    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );

    // /skeptic embedded in a sentence does not trigger — requires line-start match
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("marks comment processed only after trigger returns true", async () => {
    const session = makeSession({ id: "sess-1", pr: makePR() });
    const scm = makeMockSCM([
      { id: 99, user: { login: "jleechan2015" }, body: "/skeptic" },
    ]);
    registry = {
      get: vi.fn().mockReturnValue(scm),
    } as unknown as PluginRegistry;

    // First call — trigger returns false, comment should NOT be marked processed
    mockTrigger.mockResolvedValueOnce(false);
    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );
    expect(mockTrigger).toHaveBeenCalledTimes(1);

    // Trigger returns true on second call — now it should fire again since first failed to mark processed
    mockTrigger.mockResolvedValueOnce(true);
    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );
    // Second call DOES fire because first didn't mark it processed
    expect(mockTrigger).toHaveBeenCalledTimes(2);

    // Third call — now it should be skipped (marked processed on second)
    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );
    expect(mockTrigger).toHaveBeenCalledTimes(2);
  });
});
