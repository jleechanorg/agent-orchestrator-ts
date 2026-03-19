import { randomUUID } from "node:crypto";

export interface AgentMailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  priority: "high" | "normal" | "low";
  timestamp: string;
  metadata?: Record<string, string>;
  read: boolean;
}

export interface AgentMailConfig {
  orchestratorId: string;
  enabled: boolean;
}

export class AgentMailBridge {
  private readonly config: AgentMailConfig;
  private readonly messages: Map<string, AgentMailMessage[]> = new Map();

  constructor(config: AgentMailConfig) {
    this.config = config;
  }

  sendGuidance(sessionId: string, strategy: string, context?: string): AgentMailMessage {
    const msg: AgentMailMessage = {
      id: randomUUID(),
      from: this.config.orchestratorId,
      to: sessionId,
      subject: "Fix Strategy Guidance",
      body: formatGuidancePrompt(strategy, context),
      priority: "high",
      timestamp: new Date().toISOString(),
      read: false,
    };
    if (this.config.enabled) {
      const inbox = this.messages.get(sessionId) ?? [];
      inbox.push(msg);
      this.messages.set(sessionId, inbox);
    }
    return msg;
  }

  sendStatusUpdate(sessionId: string, status: string, details?: string): AgentMailMessage {
    const msg: AgentMailMessage = {
      id: randomUUID(),
      from: sessionId,
      to: this.config.orchestratorId,
      subject: `Status: ${status}`,
      body: details ?? status,
      priority: "normal",
      timestamp: new Date().toISOString(),
      read: false,
    };
    if (this.config.enabled) {
      const inbox = this.messages.get(this.config.orchestratorId) ?? [];
      inbox.push(msg);
      this.messages.set(this.config.orchestratorId, inbox);
    }
    return msg;
  }

  getInbox(agentId: string): AgentMailMessage[] {
    if (!this.config.enabled) {
      return [];
    }
    return this.messages.get(agentId) ?? [];
  }

  markRead(messageId: string): void {
    if (!this.config.enabled) {
      return;
    }
    for (const inbox of this.messages.values()) {
      const msg = inbox.find((m) => m.id === messageId);
      if (msg) {
        msg.read = true;
        return;
      }
    }
  }

  getUnreadCount(agentId: string): number {
    if (!this.config.enabled) {
      return 0;
    }
    return (this.messages.get(agentId) ?? []).filter((m) => !m.read).length;
  }
}

export function formatGuidancePrompt(strategy: string, context?: string): string {
  let prompt = `## Fix Strategy\n\n${strategy}`;
  if (context) {
    prompt += `\n\n## Context\n\n${context}`;
  }
  return prompt;
}
