/**
 * Skeptic extension — bd-skp2 skeptic-review reaction implementation.
 *
 * Extracted from lifecycle-manager.ts to keep that module thin.
 * The skeptic-review reaction case lives here; lifecycle-manager.ts
 * imports and delegates to it.
 *
 * The completion trigger (fires on pr_open transition) lives in
 * lifecycle-manager.ts because it requires access to transition variables
 * (oldStatus, newStatus) not easily passed through a hook API.
 */

import type { Session, ReactionConfig, ReactionResult } from "./types.js";
import { runSkepticReview } from "./skeptic-reviewer.js";

const VALID_SKEPTIC_MODELS = ["codex", "claude", "gemini"] as const;
type SkepticModel = (typeof VALID_SKEPTIC_MODELS)[number];

function isValidSkepticModel(model: string | undefined): model is SkepticModel {
  return model === undefined || (VALID_SKEPTIC_MODELS as readonly string[]).includes(model);
}

// =============================================================================
// Skeptic-review reaction — core implementation
// =============================================================================

/**
 * Core skeptic evaluation — called from lifecycle-manager.ts's
 * skeptic-review case in executeReaction.
 *
 * Takes only primitive-compatible types so lifecycle-manager doesn't need
 * to pass closure dependencies through the interface.
 */
export async function runSkepticReviewReaction(params: {
  reactionKey: string;
  reactionConfig: ReactionConfig;
  session: Session;
}): Promise<ReactionResult> {
  const { session, reactionConfig, reactionKey } = params;

  const rawModel = reactionConfig.skepticModel;
  const skepticModel = isValidSkepticModel(rawModel) ? rawModel : undefined;
  const skepticPostComment = reactionConfig.skepticPostComment ?? true;

  const result = await runSkepticReview(session, {
    model: skepticModel,
    postComment: skepticPostComment,
  });

  // SKIPPED (all-infra-fail) must not be treated as PASS — it is a non-success
  // state that the orchestrator should surface and retry. Only PASS is success.
  return {
    reactionType: reactionKey,
    success: result.verdict === "PASS",
    action: "skeptic-review",
    message: `Skeptic ${result.verdict}: ${result.details.slice(0, 200)}`,
    escalated: false,
  };
}
