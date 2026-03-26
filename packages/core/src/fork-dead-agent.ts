/**
 * fork-dead-agent — bd-5o1 companion module.
 *
 * When the agent is dead and the triggered reaction requires a live agent
 * (action === "send-to-agent"), override the session to "killed" so it
 * receives terminal cleanup rather than being polled forever in a
 * non-terminal state.
 *
 * SCM-only reactions (auto-merge, notify, request-merge) proceed normally
 * since they don't require a live agent.
 *
 * The `auto !== false` guard mirrors the reaction engine's own enablement
 * condition: reactions explicitly set to `auto: false` are manual-only and
 * the agent being dead doesn't make them actionable for override.
 */

import { TERMINAL_STATUSES, type Session, type SessionStatus, type ReactionConfig, type EventType } from "./types.js";

export interface DeadAgentOverrideDeps {
  statusToEventType: (from: SessionStatus, to: SessionStatus) => EventType | null;
  eventToReactionKey: (event: EventType) => string | null;
  getReactionConfigForSession: (
    session: Session,
    key: string,
  ) => ReactionConfig | null | Promise<ReactionConfig | null>;
}

/**
 * Override `effectiveStatus` and `newStatus` to "killed" when:
 * - The agent is dead
 * - A non-terminal status transition is pending
 * - The triggered reaction requires a live agent (action === "send-to-agent")
 * - The reaction is auto-enabled (auto !== false)
 *
 * Returns `{ effectiveStatus, newStatus }` — either the overridden values
 * (both "killed") or the original values unchanged.
 */
export async function applyDeadAgentOverride(
  agentDead: boolean,
  effectiveStatus: SessionStatus,
  oldStatus: SessionStatus,
  newStatus: SessionStatus,
  session: Session,
  deps: DeadAgentOverrideDeps,
): Promise<{ effectiveStatus: SessionStatus; newStatus: SessionStatus }> {
  if (!agentDead || effectiveStatus === oldStatus || TERMINAL_STATUSES.has(effectiveStatus)) {
    return { effectiveStatus, newStatus };
  }

  const preReactionEvent = deps.statusToEventType(oldStatus, effectiveStatus);
  if (!preReactionEvent) return { effectiveStatus, newStatus };

  const preReactionKey = deps.eventToReactionKey(preReactionEvent);
  if (!preReactionKey) return { effectiveStatus, newStatus };

  const preReactionCfg = await deps.getReactionConfigForSession(session, preReactionKey);
  if (preReactionCfg?.action !== "send-to-agent") return { effectiveStatus, newStatus };
  if (preReactionCfg.auto === false) return { effectiveStatus, newStatus };

  // Override both so downstream checks (checkSession event/reaction/notifications)
  // see consistent terminal state.
  return { effectiveStatus: "killed" as SessionStatus, newStatus: "killed" as SessionStatus };
}
