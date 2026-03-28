import { describe, it, expect, vi, beforeEach } from "vitest";
import { runSkepticReviewReaction } from "../fork-skeptic-extension.js";
import type { Session, ReactionConfig, SkepticReviewResult } from "../types.js";

function makePR(overrides: Partial<import("../types.js").PRInfo> = {}) {
  return {
    number: 42,
    url: "https://github.com/acme/app/pull/42",
    title: "feat: add widget",
    owner: "acme",
    repo: "app",
    branch: "feat/widget",
    baseBranch: "main",
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: makePR(),
    workspacePath: "/tmp/ws",
    runtimeHandle: { id: "rt-1", runtimeName: "mock", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeReactionConfig(overrides: Partial<ReactionConfig> = {}): ReactionConfig {
  return {
    action: "skeptic-review",
    ...overrides,
  } as ReactionConfig;
}

vi.mock("../skeptic-reviewer.js", () => ({
  runSkepticReview: vi.fn<
    [Session, { model?: string; postComment?: boolean }],
    Promise<SkepticReviewResult>
  >(),
}));

import { runSkepticReview } from "../skeptic-reviewer.js";
const mockedRunSkepticReview = runSkepticReview as ReturnType<typeof vi.fn>;

describe("runSkepticReviewReaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps PASS verdict to success=true", async () => {
    mockedRunSkepticReview.mockResolvedValueOnce({
      verdict: "PASS",
      details: "All exit criteria satisfied.",
      modelUsed: "codex",
    });

    const session = makeSession();
    const config = makeReactionConfig({ skepticModel: "codex", skepticPostComment: true });

    const result = await runSkepticReviewReaction({
      reactionKey: "skeptic-review",
      reactionConfig: config,
      session,
    });

    expect(result.success).toBe(true);
    expect(result.reactionType).toBe("skeptic-review");
    expect(result.action).toBe("skeptic-review");
    expect(result.escalated).toBe(false);
    expect(result.message).toContain("PASS");
  });

  it("maps SKIPPED verdict to success=true", async () => {
    mockedRunSkepticReview.mockResolvedValueOnce({
      verdict: "SKIPPED",
      details: "No PR associated with session.",
      modelUsed: "codex",
    });

    const session = makeSession({ pr: undefined });
    const config = makeReactionConfig({ skepticModel: undefined, skepticPostComment: true });

    const result = await runSkepticReviewReaction({
      reactionKey: "skeptic-review",
      reactionConfig: config,
      session,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("SKIPPED");
  });

  it("maps FAIL verdict to success=false", async () => {
    mockedRunSkepticReview.mockResolvedValueOnce({
      verdict: "FAIL",
      details: "Exit criterion B not met: tests missing.",
      modelUsed: "claude",
    });

    const session = makeSession();
    const config = makeReactionConfig({ skepticModel: "claude", skepticPostComment: false });

    const result = await runSkepticReviewReaction({
      reactionKey: "worker-signals-completion",
      reactionConfig: config,
      session,
    });

    expect(result.success).toBe(false);
    expect(result.reactionType).toBe("worker-signals-completion");
    expect(result.message).toContain("FAIL");
  });

  it("truncates message.details to 200 characters", async () => {
    mockedRunSkepticReview.mockResolvedValueOnce({
      verdict: "PASS",
      details: "x".repeat(500),
      modelUsed: "codex",
    });

    const session = makeSession();
    const config = makeReactionConfig({ skepticModel: undefined, skepticPostComment: true });

    const result = await runSkepticReviewReaction({
      reactionKey: "skeptic-review",
      reactionConfig: config,
      session,
    });

    // message = "Skeptic {verdict}: {details.slice(0,200)}"
    // The details portion should be at most 200 chars
    const colonIdx = result.message.indexOf(":");
    const detailsStr = result.message.slice(colonIdx + 1).trim();
    expect(detailsStr.length).toBeLessThanOrEqual(200);
    expect(result.message.length).toBeLessThanOrEqual(200 + "Skeptic PASS: ".length);
  });

  it("calls runSkepticReview with codex model", async () => {
    mockedRunSkepticReview.mockResolvedValueOnce({
      verdict: "PASS",
      details: "ok",
      modelUsed: "codex",
    });

    const session = makeSession();
    const config = makeReactionConfig({ skepticModel: "codex" });

    await runSkepticReviewReaction({
      reactionKey: "skeptic-review",
      reactionConfig: config,
      session,
    });

    expect(mockedRunSkepticReview).toHaveBeenCalledOnce();
    expect(mockedRunSkepticReview).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ model: "codex" }),
    );
  });

  it("calls runSkepticReview with claude model", async () => {
    mockedRunSkepticReview.mockResolvedValueOnce({
      verdict: "PASS",
      details: "ok",
      modelUsed: "claude",
    });

    const session = makeSession();
    const config = makeReactionConfig({ skepticModel: "claude" });

    await runSkepticReviewReaction({
      reactionKey: "skeptic-review",
      reactionConfig: config,
      session,
    });

    expect(mockedRunSkepticReview).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ model: "claude" }),
    );
  });

  it("calls runSkepticReview with gemini model", async () => {
    mockedRunSkepticReview.mockResolvedValueOnce({
      verdict: "PASS",
      details: "ok",
      modelUsed: "gemini",
    });

    const session = makeSession();
    const config = makeReactionConfig({ skepticModel: "gemini" });

    await runSkepticReviewReaction({
      reactionKey: "skeptic-review",
      reactionConfig: config,
      session,
    });

    expect(mockedRunSkepticReview).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ model: "gemini" }),
    );
  });

  it("calls runSkepticReview with undefined model when skepticModel is absent", async () => {
    mockedRunSkepticReview.mockResolvedValueOnce({
      verdict: "PASS",
      details: "ok",
      modelUsed: "codex",
    });

    const session = makeSession();
    const config = makeReactionConfig(); // no skepticModel set

    await runSkepticReviewReaction({
      reactionKey: "skeptic-review",
      reactionConfig: config,
      session,
    });

    expect(mockedRunSkepticReview).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ model: undefined }),
    );
  });

  it("defaults skepticPostComment to true when not set", async () => {
    mockedRunSkepticReview.mockResolvedValueOnce({
      verdict: "PASS",
      details: "ok",
      modelUsed: "codex",
    });

    const session = makeSession();
    const config = makeReactionConfig(); // no skepticPostComment set

    await runSkepticReviewReaction({
      reactionKey: "skeptic-review",
      reactionConfig: config,
      session,
    });

    expect(mockedRunSkepticReview).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ postComment: true }),
    );
  });

  it("passes skepticPostComment=false when configured", async () => {
    mockedRunSkepticReview.mockResolvedValueOnce({
      verdict: "PASS",
      details: "ok",
      modelUsed: "codex",
    });

    const session = makeSession();
    const config = makeReactionConfig({ skepticPostComment: false });

    await runSkepticReviewReaction({
      reactionKey: "skeptic-review",
      reactionConfig: config,
      session,
    });

    expect(mockedRunSkepticReview).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ postComment: false }),
    );
  });

  it("ignores invalid skepticModel values and falls back to undefined", async () => {
    mockedRunSkepticReview.mockResolvedValueOnce({
      verdict: "PASS",
      details: "ok",
      modelUsed: "codex",
    });

    const session = makeSession();
    const config = makeReactionConfig({ skepticModel: "gpt4" as any }); // invalid model

    await runSkepticReviewReaction({
      reactionKey: "skeptic-review",
      reactionConfig: config,
      session,
    });

    expect(mockedRunSkepticReview).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ model: undefined }),
    );
  });

  it("calls runSkepticReview when session has no workspacePath (backfill session)", async () => {
    // Backfill sessions spawned by lifecycle-manager may have no workspacePath.
    // runSkepticReview still succeeds because ao skeptic verify only needs GitHub API access.
    mockedRunSkepticReview.mockResolvedValueOnce({
      verdict: "PASS",
      details: "ok",
      modelUsed: "codex",
    });

    const session = makeSession({ workspacePath: null });
    const config = makeReactionConfig();

    const result = await runSkepticReviewReaction({
      reactionKey: "skeptic-review",
      reactionConfig: config,
      session,
    });

    expect(mockedRunSkepticReview).toHaveBeenCalledOnce();
    expect(mockedRunSkepticReview).toHaveBeenCalledWith(session, expect.any(Object));
    expect(result.success).toBe(true);
  });
});
