/**
 * Unit tests for detectAndTriggerSkepticComment.
 *
 * The trigger detection is intentionally narrow: this function only
 * CONSUMES the structured `isSkepticTrigger` flag set by the SCM plugin
 * and does NOT re-parse comment bodies. Heuristic keyword routing
 * violates the ZFC coding guideline and is the SCM provider's
 * responsibility (see packages/plugins/scm-github/src/index.ts
 * listPRComments for the keyword/regex detector).
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

function makeMockSCM(
  comments: Array<{ id: number; user: { login: string }; body: string; isSkepticTrigger?: boolean }> = [],
) {
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
  let failedCommentIds: Map<string, Set<number>>;
  let lastSkepticSha: Map<string, string>;
  let config: OrchestratorConfig;
  let registry: PluginRegistry;

  beforeEach(() => {
    mockTrigger = vi.fn().mockResolvedValue(true);
    processedCommentIds = new Map();
    failedCommentIds = new Map();
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
    const scm = makeMockSCM([{ id: 1, user: { login: "jleechan2015" }, body: "/skeptic", isSkepticTrigger: true }]);
    registry = {
      get: vi.fn().mockReturnValue(scm),
    } as unknown as PluginRegistry;

    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      failedCommentIds,
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
    const scm = makeMockSCM([{ id: 1, user: { login: "jleechan2015" }, body: "/skeptic", isSkepticTrigger: true }]);
    registry = {
      get: vi.fn().mockReturnValue(scm),
    } as unknown as PluginRegistry;

    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      failedCommentIds,
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
      failedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );

    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("falls back to default 'github' SCM when project.scm is not defined", async () => {
    config.projects["my-app"] = {
      name: "my-app",
      repo: "org/repo",
      path: "/tmp/repo",
      defaultBranch: "main",
      sessionPrefix: "app",
    };

    const session = makeSession({ id: "sess-1", pr: makePR() });
    const scm = makeMockSCM([
      { id: 1, user: { login: "jleechan2015" }, body: "/skeptic", isSkepticTrigger: true },
    ]);

    registry = {
      get: vi.fn().mockImplementation((type, name) => {
        if (type === "scm" && name === "github") {
          return scm;
        }
        return null;
      }),
    } as unknown as PluginRegistry;

    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      failedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );

    expect(registry.get).toHaveBeenCalledWith("scm", "github");
    expect(mockTrigger).toHaveBeenCalledTimes(1);
  });

  it("skips bot-authored comments even when isSkepticTrigger is set", async () => {
    // SCM plugin should NOT have set isSkepticTrigger for a bot /skeptic,
    // but the app code still defensively skips bot authors. This guards
    // against an SCM plugin mis-classifying a bot comment as a trigger.
    const session = makeSession({ pr: makePR() });
    const scm = makeMockSCM([
      { id: 1, user: { login: "github-actions[bot]" }, body: "/skeptic", isSkepticTrigger: true },
    ]);
    registry = {
      get: vi.fn().mockReturnValue(scm),
    } as unknown as PluginRegistry;

    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      failedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );

    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("skips comments whose isSkepticTrigger is not set (ZFC contract)", async () => {
    // Body contains /skeptic but the structured flag is false. App code
    // must not match on the body — the SCM plugin is the single source of
    // truth for trigger detection.
    const session = makeSession({ pr: makePR() });
    const scm = makeMockSCM([
      { id: 1, user: { login: "jleechan2015" }, body: "/skeptic", isSkepticTrigger: false },
    ]);
    registry = {
      get: vi.fn().mockReturnValue(scm),
    } as unknown as PluginRegistry;

    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      failedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );

    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("fires triggerSkepticReaction when a human comment has isSkepticTrigger=true", async () => {
    const session = makeSession({ id: "sess-1", pr: makePR() });
    const scm = makeMockSCM([
      { id: 1, user: { login: "jleechan2015" }, body: "/skeptic", isSkepticTrigger: true },
    ]);
    registry = {
      get: vi.fn().mockReturnValue(scm),
    } as unknown as PluginRegistry;

    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      failedCommentIds,
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
      { id: 99, user: { login: "jleechan2015" }, body: "/skeptic", isSkepticTrigger: true },
    ]);
    registry = {
      get: vi.fn().mockReturnValue(scm),
    } as unknown as PluginRegistry;

    // First call — should fire
    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      failedCommentIds,
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
      failedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );

    expect(mockTrigger).toHaveBeenCalledTimes(1);
  });

  it("processes only the first trigger comment when multiple are present in one cycle", async () => {
    const session = makeSession({ id: "sess-1", pr: makePR() });
    const scm = makeMockSCM([
      { id: 10, user: { login: "alice" }, body: "/skeptic", isSkepticTrigger: true },
      { id: 11, user: { login: "bob" }, body: "/skeptic", isSkepticTrigger: true },
    ]);
    registry = {
      get: vi.fn().mockReturnValue(scm),
    } as unknown as PluginRegistry;

    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      failedCommentIds,
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
        failedCommentIds,
        lastSkepticSha,
        "test-corr",
        config,
        registry,
        mockTrigger,
      ),
    ).resolves.not.toThrow();

    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("marks comment processed only after trigger returns true", async () => {
    const session = makeSession({ id: "sess-1", pr: makePR() });
    const scm = makeMockSCM([
      { id: 99, user: { login: "jleechan2015" }, body: "/skeptic", isSkepticTrigger: true },
    ]);
    registry = {
      get: vi.fn().mockReturnValue(scm),
    } as unknown as PluginRegistry;

    // First call — trigger returns false, comment is recorded as permanently failed
    mockTrigger.mockResolvedValueOnce(false);
    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      failedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );
    expect(mockTrigger).toHaveBeenCalledTimes(1);

    // Second call — permanently failed comment is skipped
    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      failedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );
    expect(mockTrigger).toHaveBeenCalledTimes(1);
  });

  it("permanently skips failed comment across poll cycles", async () => {
    const session = makeSession({ id: "sess-1", pr: makePR() });
    const scm = makeMockSCM([
      { id: 99, user: { login: "jleechan2015" }, body: "/skeptic", isSkepticTrigger: true },
    ]);
    registry = {
      get: vi.fn().mockReturnValue(scm),
    } as unknown as PluginRegistry;

    // Simulate a real poll cycle: first call fails, permanent failure recorded
    mockTrigger.mockResolvedValueOnce(false);
    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      failedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );

    // Next poll cycle — same comment must NOT be re-processed
    await detectAndTriggerSkepticComment(
      session,
      processedCommentIds,
      failedCommentIds,
      lastSkepticSha,
      "test-corr",
      config,
      registry,
      mockTrigger,
    );

    // Trigger was only called once despite multiple poll cycles
    expect(mockTrigger).toHaveBeenCalledTimes(1);
  });
});
