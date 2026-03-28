/**
 * Fork-specific reaction retry policy — extracted to minimize diff against upstream.
 *
 * bd-5nxx: send-to-agent is non-idempotent — cap retries at 3 by default to prevent
 * repeated delivery of the same message on every poll cycle for stable states.
 * Other action types remain uncapped (Infinity) by default.
 *
 * bd-sbr.periodic-cap: periodic invocations (e.g. agent-stuck nudge retry) pass
 * isPeriodic=true so this returns Infinity — periodic nudges are bounded by their
 * own cooldown timer (STUCK_RETRY_COOLDOWN_MS), not the transition cap.
 */

import type { ReactionConfig } from "./types.js";

/**
 * Resolve the effective maxRetries for a reaction.
 *
 * @param action - The resolved action type (e.g. "send-to-agent", "notify").
 * @param reactionConfig - The reaction configuration from agent-orchestrator.yaml.
 * @param isPeriodic - Whether this is a periodic/stable-cycle retry (e.g. agent-stuck
 *   nudge retry). Periodic retries are bounded by their own cooldown timer and are
 *   exempt from the send-to-agent cap.
 */
export function resolveReactionMaxRetries(
  action: string,
  reactionConfig: ReactionConfig,
  isPeriodic = false,
): number {
  // Periodic retries (agent-stuck nudge) are bounded by their own cooldown timer.
  if (isPeriodic) return Infinity;

  // Fork default: send-to-agent capped at 3, all others uncapped.
  const defaultRetries = action === "send-to-agent" ? 3 : Infinity;
  return reactionConfig.retries ?? defaultRetries;
}
