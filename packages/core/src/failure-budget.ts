/**
 * FailureBudgetTracker — tracks retry failures per session+reaction
 * and routes exhausted budgets to escalation, disable, notify, or route-to.
 */

import { parseDuration } from "./lifecycle-manager.js";
import type { EventPriority, ReactionConfig, ReactionResult } from "./types.js";

interface BudgetEntry {
  count: number;
  windowStart: Date;
}

export class FailureBudgetTracker {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly entries: Map<string, BudgetEntry> = new Map();

  constructor(config: { max: number; window?: string }) {
    this.max = config.max;
    this.windowMs = config.window ? parseDuration(config.window) : 0;
  }

  private key(sessionId: string, reactionType: string): string {
    return `${sessionId}:${reactionType}`;
  }

  private isExpired(entry: BudgetEntry): boolean {
    if (this.windowMs <= 0) return false;
    return Date.now() - entry.windowStart.getTime() > this.windowMs;
  }

  recordFailure(sessionId: string, reactionType: string): void {
    const k = this.key(sessionId, reactionType);
    const entry = this.entries.get(k);
    if (entry && !this.isExpired(entry)) {
      entry.count++;
    } else {
      this.entries.set(k, { count: 1, windowStart: new Date() });
    }
  }

  getCount(sessionId: string, reactionType: string): number {
    const entry = this.entries.get(this.key(sessionId, reactionType));
    if (!entry) return 0;
    if (this.isExpired(entry)) {
      this.entries.delete(this.key(sessionId, reactionType));
      return 0;
    }
    return entry.count;
  }

  isExhausted(sessionId: string, reactionType: string): boolean {
    return this.getCount(sessionId, reactionType) >= this.max;
  }

  reset(sessionId: string, reactionType: string): void {
    this.entries.delete(this.key(sessionId, reactionType));
  }

  resetExpiredWindows(): void {
    if (this.windowMs <= 0) return;
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.windowStart.getTime() > this.windowMs) {
        this.entries.delete(key);
      }
    }
  }
}

export interface BudgetExhaustedDeps {
  notify: (event: {
    priority: EventPriority;
    message: string;
    sessionId: string;
    projectId: string;
  }) => Promise<void>;
  projectId: string;
  spawnSession: (agentName: string) => Promise<void>;
}

export async function routeExhaustedBudget(
  config: ReactionConfig,
  sessionId: string,
  reactionType: string,
  deps: BudgetExhaustedDeps,
): Promise<ReactionResult> {
  switch (config.onBudgetExhausted) {
    case "escalate":
      await deps.notify({
        priority: "urgent",
        message: `Failure budget exhausted for ${reactionType} on session ${sessionId}. Escalating to human.`,
        sessionId,
        projectId: deps.projectId,
      });
      return {
        reactionType,
        success: true,
        action: "escalate",
        escalated: true,
        message: "Budget exhausted — escalated to human",
      };

    case "disable":
      return {
        reactionType,
        success: true,
        action: "disable",
        escalated: false,
        message: "Reaction disabled after budget exhaustion",
      };

    case "notify":
      await deps.notify({
        priority: "warning",
        message: `Failure budget exhausted for ${reactionType} on session ${sessionId}.`,
        sessionId,
        projectId: deps.projectId,
      });
      return {
        reactionType,
        success: true,
        action: "notify",
        escalated: false,
        message: "Budget exhausted — notification sent",
      };

    case "route-to":
      if (config.routeToAgent) {
        await deps.spawnSession(config.routeToAgent);
        return {
          reactionType,
          success: true,
          action: "route-to",
          escalated: false,
          message: `Routed to agent ${config.routeToAgent}`,
        };
      }
      // Fall through to escalate when no routeToAgent configured
      await deps.notify({
        priority: "urgent",
        message: `Failure budget exhausted for ${reactionType} on session ${sessionId}. No routeToAgent configured — escalating to human.`,
        sessionId,
        projectId: deps.projectId,
      });
      return {
        reactionType,
        success: true,
        action: "escalate",
        escalated: true,
        message: "Budget exhausted — no routeToAgent, escalated to human",
      };

    default:
      return {
        reactionType,
        success: false,
        action: "none",
        escalated: false,
        message: "No budget exhaustion handler configured",
      };
  }
}
