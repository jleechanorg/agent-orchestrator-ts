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

  private static cloneMessage(msg: AgentMailMessage): AgentMailMessage {
    return {
      ...msg,
      metadata: msg.metadata ? { ...msg.metadata } : undefined,
    };
  }

  constructor(config: AgentMailConfig) {
    this.config = config;
  }

  sendGuidance(sessionId: string, strategy: string, context?: string): AgentMailMessage | undefined {
    if (!this.config.enabled) return undefined;
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
    const inbox = this.messages.get(sessionId) ?? [];
    inbox.push(AgentMailBridge.cloneMessage(msg));
    this.messages.set(sessionId, inbox);
    return AgentMailBridge.cloneMessage(msg);
  }

  sendStatusUpdate(sessionId: string, status: string, details?: string): AgentMailMessage | undefined {
    if (!this.config.enabled) return undefined;
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
    const inbox = this.messages.get(this.config.orchestratorId) ?? [];
    inbox.push(AgentMailBridge.cloneMessage(msg));
    this.messages.set(this.config.orchestratorId, inbox);
    return AgentMailBridge.cloneMessage(msg);
  }

  getInbox(agentId: string): AgentMailMessage[] {
    const inbox = this.messages.get(agentId);
    if (!inbox) return [];
    return inbox.map((m) => AgentMailBridge.cloneMessage(m));
  }

  markRead(messageId: string): void {
    for (const inbox of this.messages.values()) {
      const msg = inbox.find((m) => m.id === messageId);
      if (msg) { msg.read = true; return; }
    }
  }

  getUnreadCount(agentId: string): number {
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
