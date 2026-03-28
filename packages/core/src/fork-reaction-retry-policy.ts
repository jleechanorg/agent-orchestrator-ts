/**
 * Fork-specific reaction retry policy.
 *
 * send-to-agent is non-idempotent — each invocation delivers a message to the
 * agent's tmux session. Cap retries at 3 by default to bound duplicate deliveries
 * from edge cases (handler crash, process restart replays same poll cycle).
 * Other action types remain uncapped (Infinity) by default.
 *
 * This module exists to keep fork-specific policy isolated from upstream lifecycle
 * code, minimizing the upstream diff surface.
 */

/** Reaction config shape needed by the policy — kept minimal to avoid importing the full config type. */
export interface ReactionRetryConfig {
  retries?: number;
}

/**
 * Resolve the effective maxRetries for a reaction.
 *
 * @param action  - The resolved action type (e.g. "send-to-agent", "notify")
 * @param reactionConfig - The per-reaction config (may override retries)
 * @param isPeriodic - Whether this is a periodic/stable-cycle retry (e.g. agent-stuck
 *                    nudge re-entry on a stuck session). Periodic invocations are
 *                    bounded by their own cooldown logic and should NOT consume the
 *                    transition cap. Default: false.
 */
export function resolveReactionMaxRetries(
  action: string,
  reactionConfig: ReactionRetryConfig,
  isPeriodic = false,
): number {
  // Periodic invocations (e.g., agent-stuck nudge retries) are bounded by their
  // own cooldown timer (STUCK_RETRY_COOLDOWN_MS). They should not consume the
  // transition-only cap. Leave them uncapped so the agent gets unlimited recovery
  // attempts at the configured interval.
  if (isPeriodic) return Infinity;
  const defaultRetries = action === "send-to-agent" ? 3 : Infinity;
  return reactionConfig.retries ?? defaultRetries;
}