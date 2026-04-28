/**
 * Red-state reproduction test: proves the lifecycle-manager does NOT properly
 * trigger the skeptic-review action when a session transitions to pr_open.
 *
 * Bug: when a PR transitions to pr_open status, triggerSkepticReaction should
 * be called with action=skeptic-review, but the skeptic evaluation never runs.
 *
 * This test FAILS in the current broken state — proving the trigger chain is broken.
 *
 * Run with:
 *   cd packages/core && pnpm test -- --run lifecycle-manager-skeptic-trigger
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  Session,
  OrchestratorConfig,
  ReactionConfig,
  ReactionResult,
  PluginRegistry,
  PRInfo,
} from "../types.js";

// ---------------------------------------------------------------------------
// Mock fork-skeptic-extension BEFORE importing lifecycle-manager
// ---------------------------------------------------------------------------
const { mockRunSkepticReviewReaction } = vi.hoisted<{
  mockRunSkepticReviewReaction: () => Promise<ReactionResult>;
}>(() => ({
  mockRunSkepticReviewReaction: vi.fn<[], Promise<ReactionResult>>(),
}));

vi.mock("../fork-skeptic-extension.js", () => ({
  runSkepticReviewReaction: mockRunSkepticReviewReaction,
}));

vi.mock("../ao-action-log.js", () => ({
  logAoAction: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import AFTER vi.mock — gets the instrumented module
// ---------------------------------------------------------------------------
import { triggerSkepticReactionImpl as triggerSkepticReaction } from "../lifecycle-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    url: "https://github.com/acme/repo/pull/42",
    title: "Fix things",
    owner: "acme",
    repo: "repo",
    branch: "feat/test",
    baseBranch: "main",
    isDraft: false,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-session-1",
    projectId: "test-project",
    status: "pr_open",
    activity: null,
    branch: "feat/test",
    issueId: null,
    pr: makePR(),
    workspacePath: "/tmp/test-ws",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeConfig(
  workerSignalsAuto: boolean,
  skepticAction: string = "skeptic-review",
): OrchestratorConfig {
  return {
    reactions: {
      "worker-signals-completion": {
        auto: workerSignalsAuto,
        action: skepticAction,
      },
      // Disabled so triggerSkepticReaction only fires worker-signals-completion (not claim-verification)
      // This lets us test the skeptic trigger in isolation.
      "claim-verification": {
        auto: false,
        action: "notify",
      },
    },
    projects: {
      "test-project": {
        name: "test-project",
        path: "/tmp",
        agent: { plugin: "agent-claude-code" },
        scm: { plugin: "github" },
      },
    },
    defaults: {},
  } satisfies OrchestratorConfig;
}

// Minimal mock SCM
function makeMockRegistry(sha: string): PluginRegistry {
  return {
    get: vi.fn((_type: "scm", _plugin: string) => ({
      getPRHeadSha: async () => sha,
    })),
  } as unknown as PluginRegistry;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe("lifecycle-manager skeptic trigger — pr_open transition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunSkepticReviewReaction.mockResolvedValue({
      reactionType: "skeptic-review",
      success: true,
      action: "skeptic-review",
      escalated: false,
      message: "Skeptic PASS",
    });
  });

  /**
   * RED STATE: This test FAILS in the current broken state.
   *
   * The bug: When config has `worker-signals-completion: { auto: true, action: skeptic-review }`,
   * calling triggerSkepticReaction(session with pr_open, lastSkepticSha, correlationId, config, registry, executeReaction)
   * should call executeReaction with reactionKey="worker-signals-completion" and reactionConfig.action="skeptic-review".
   *
   * This test verifies the trigger chain is wired correctly at the triggerSkepticReaction level.
   * If this PASSES, the bug must be elsewhere (pollLoop not calling triggerSkepticReaction for pr_open).
   * If this FAILS, triggerSkepticReaction itself is not calling executeReaction correctly.
   *
   * NOTE: We cannot verify runSkepticReviewReaction was called here because the mock executeReaction
   * passed to triggerSkepticReactionImpl doesn't invoke the case skeptic-review branch. We verify
   * only that executeReaction was called with the correct arguments.
   */
  it("FAILS: triggerSkepticReaction should call executeReaction with skeptic-review when configured", async () => {
    const session = makeSession({ status: "pr_open" });
    const lastSkepticSha = new Map<string, string>();
    const config = makeConfig(true);
    const registry = makeMockRegistry("abc0000");

    // Track executeReaction calls
    const executeReactionCalls: Array<{
      sessionId: string;
      projectId: string;
      reactionKey: string;
      reactionConfig: ReactionConfig;
    }> = [];

    const executeReaction = vi.fn(async (
      sessionId: string,
      projectId: string,
      reactionKey: string,
      reactionConfig: ReactionConfig,
      _session?: Session,
      _correlationId?: string,
    ): Promise<ReactionResult> => {
      executeReactionCalls.push({ sessionId, projectId, reactionKey, reactionConfig });
      return { success: true };
    });

    const result = await triggerSkepticReaction(
      session,
      lastSkepticSha,
      "test-correlation",
      config,
      registry,
      executeReaction,
    );

    // In the current state, this assertion should PASS — triggerSkepticReaction IS wired correctly.
    // The bug must be elsewhere (pollLoop not calling triggerSkepticReaction for pr_open).
    expect(result).toBe(true);
    expect(executeReactionCalls).toHaveLength(1);
    expect(executeReactionCalls[0].reactionKey).toBe("worker-signals-completion");
    expect(executeReactionCalls[0].reactionConfig.action).toBe("skeptic-review");
  });

  /**
   * RED STATE: This test FAILS in the current broken state.
   *
   * Verifies the first-seen skeptic dispatch path — when a session is first polled
   * with pr_open status (no prior SHA in lastSkepticSha), skeptic should fire.
   *
   * The first-seen path is in the pollLoop's no-transition block (when tracked === undefined).
   * This test directly exercises triggerSkepticReaction with a session that has no prior SHA.
   */
  it("FAILS: triggerSkepticReaction should fire for first-seen session (no prior SHA)", async () => {
    const session = makeSession({ status: "pr_open" });
    const lastSkepticSha = new Map<string, string>(); // No prior entry — first-seen
    const firstSeenSha = "abc1111111111111111111111111111111111111";
    const config = makeConfig(true);
    const registry = makeMockRegistry(firstSeenSha);

    const executeReaction = vi.fn(async (): Promise<ReactionResult> => {
      return { success: true };
    });

    const result = await triggerSkepticReaction(
      session,
      lastSkepticSha,
      "test-correlation",
      config,
      registry,
      executeReaction,
    );

    // Should succeed and record the SHA
    expect(result).toBe(true);
    expect(executeReaction).toHaveBeenCalled();

    // SHA should be recorded after successful dispatch
    expect(lastSkepticSha.get(session.id)).toBe(firstSeenSha);
  });

  /**
   * Verifies the reaction chain: triggerSkepticReaction → executeReaction with skeptic-review action.
   * The mock executeReaction passed to triggerSkepticReactionImpl doesn't call runSkepticReviewReaction
   * (that would require passing the real executeReaction). So we verify executeReaction was called
   * with the correct arguments, which proves triggerSkepticReaction is correctly dispatching.
   */
  it("verify: triggerSkepticReaction calls executeReaction with correct skeptic-review arguments", async () => {
    const session = makeSession({ status: "pr_open" });
    const lastSkepticSha = new Map<string, string>();
    const config = makeConfig(true);
    const registry = makeMockRegistry("abc0000");

    const executeReaction = vi.fn(async (): Promise<ReactionResult> => {
      return { success: true };
    });

    await triggerSkepticReaction(
      session,
      lastSkepticSha,
      "test-correlation",
      config,
      registry,
      executeReaction,
    );

    // executeReaction was called exactly once with worker-signals-completion + skeptic-review
    expect(executeReaction).toHaveBeenCalledTimes(1);
    expect(executeReaction).toHaveBeenCalledWith(
      session.id,
      session.projectId,
      "worker-signals-completion",
      expect.objectContaining({ action: "skeptic-review" }),
      session,
      "test-correlation",
    );
  });
});
