import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Shared MCP Agent Mail HTTP client (used by core lifecycle manager + plugins)
// ---------------------------------------------------------------------------

/** Timeout for outbound MCP mail HTTP calls (ms). */
const MCP_TIMEOUT_MS = 30_000;

export interface McpMailClientConfig {
  endpoint: string;
  projectKey: string;
  agentId: string;
}

/** Canonical message shape used for both inbound (fetch_inbox) and outbound (send) messages. */
export interface McpMailMessage {
  id: string;
  project_key: string;
  sender_name: string;
  to: string[];
  subject: string;
  body_md: string;
  created_at: string;
  read: boolean;
}

/** Alias for inbox messages (identical structure to McpMailMessage). */
export type InboxMessage = McpMailMessage;

/** Callback invoked with new inbox messages on each poll. */
export type InboxCallback = (messages: InboxMessage[]) => void;

// ---------------------------------------------------------------------------
// McpMailClient — encapsulates all per-client state to avoid cross-process
// or cross-test contamination from module-level singletons.
// ---------------------------------------------------------------------------

let _instance: McpMailClient | null = null;

export function initMcpMailClient(config: McpMailClientConfig): void {
  _instance = new McpMailClient(config);
}

export function getMcpMailClientConfig(): McpMailClientConfig | null {
  return _instance?.config ?? null;
}

export function setMcpMailInboxCallback(cb: InboxCallback): void {
  if (_instance) _instance._setCallback(cb);
}

class McpMailClient {
  readonly config: McpMailClientConfig;
  private _registrationPromise: Promise<void> | null = null;
  private _seenMessageIds = new Set<string>();
  private _inboxCallback: InboxCallback | null = null;

  constructor(config: McpMailClientConfig) {
    this.config = config;
  }

  _setCallback(cb: InboxCallback): void {
    this._inboxCallback = cb;
  }

  private async _apiPost(toolName: string, params: Record<string, unknown>): Promise<unknown> {
    const base = this.config.endpoint.replace(/\/+$/, "").replace(/\/mcp$/, "");
    const url = `${base}/mcp`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: toolName, arguments: params },
        id: 1,
      }),
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`MCP mail ${toolName} failed (${response.status}): ${body}`);
    }

    const result = (await response.json()) as {
      error?: { message?: string; code?: number };
      result?: { content?: Array<{ text?: string }> };
    };
    if (result.error) {
      throw new Error(
        `MCP mail ${toolName} error (${result.error.code ?? "?"}): ${result.error.message ?? JSON.stringify(result.error)}`,
      );
    }
    return result.result;
  }

  private async _ensureRegistered(): Promise<void> {
    if (!this._registrationPromise) {
      const p = (async () => {
        await this._apiPost("register_agent", {
          project_key: this.config.projectKey,
          program: "agent-orchestrator",
          model: "claude",
          agent_name: this.config.agentId,
        });
      })();
      this._registrationPromise = p;
      p.catch(() => { this._registrationPromise = null; });
    }
    await this._registrationPromise;
  }

  async pollInbox(): Promise<InboxMessage[]> {
    try {
      await this._ensureRegistered();
      const raw = await this._apiPost("fetch_inbox", {
        project_key: this.config.projectKey,
        agent_name: this.config.agentId,
        limit: 20,
        include_bodies: true,
      });

      // Parse inbox from structuredContent (preferred) or content[0].text fallback
      let rawMessages: unknown[] = [];
      const result = raw as {
        content?: Array<{ text?: string }>;
        structuredContent?: { result?: unknown[] };
      };
      if (result.structuredContent?.result) {
        rawMessages = result.structuredContent.result;
      } else if (result.content?.[0]?.text) {
        // Skip error text returned when agent not found
        const rawText = result.content[0].text;
        try {
          rawMessages = JSON.parse(rawText) as unknown[];
        } catch {
          // non-JSON — treat as empty inbox
        }
      }

      const messages: InboxMessage[] = rawMessages.map((m) => {
        const msg = m as Record<string, unknown>;
        return {
          id: String(msg["id"] ?? msg["message_id"] ?? ""),
          project_key: this.config.projectKey,
          sender_name: String(msg["sender_name"] ?? msg["from"] ?? msg["sender"] ?? ""),
          to: Array.isArray(msg["to"])
            ? (msg["to"] as unknown[]).filter((v): v is string => typeof v === "string")
            : [],
          subject: String(msg["subject"] ?? ""),
          body_md: String(msg["body_md"] ?? msg["body"] ?? msg["text"] ?? ""),
          created_at: String(msg["created_at"] ?? msg["created_ts"] ?? msg["timestamp"] ?? ""),
          read: Boolean(msg["read"] ?? msg["is_read"]),
        };
      });

      // Surface only messages never seen across any previous poll
      const newMessages = messages.filter((m) => !this._seenMessageIds.has(m.id));

      // Remember all IDs so stale messages are never re-delivered
      this._seenMessageIds = new Set(messages.map((m) => m.id));

      if (newMessages.length > 0 && this._inboxCallback) {
        try { this._inboxCallback(newMessages); } catch { /* non-fatal */ }
      }

      return messages;
    } catch (err) {
      console.warn(
        `[mcp-mail] Inbox poll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  private async _send(params: { subject: string; body_md: string; to?: string[] }): Promise<void> {
    await this._ensureRegistered();
    await this._apiPost("send_message", {
      project_key: this.config.projectKey,
      sender_name: this.config.agentId,
      to: params.to ?? [],
      subject: params.subject,
      body_md: params.body_md,
    });
  }

  async sendHeartbeat(body_md?: string): Promise<void> {
    const body = body_md ?? "I'm alive — heartbeat";
    await this._send({
      subject: `worker heartbeat — ${this.config.agentId}`,
      body_md: body,
      to: [`global:${this.config.projectKey}`],
    });
  }

  async sendSessionStart(taskDescription?: string): Promise<void> {
    const body = taskDescription ? `Starting task: ${taskDescription}` : "Session started";
    await this._send({
      subject: `session start — ${this.config.agentId}`,
      body_md: body,
      to: [`global:${this.config.projectKey}`],
    });
  }

  async sendSessionEnd(doneTask?: string, blockedOn?: string): Promise<void> {
    let body = doneTask ? `Done with: ${doneTask}` : "Session ended";
    if (blockedOn) body += `\nBlocked on: ${blockedOn}`;
    await this._send({
      subject: `session end — ${this.config.agentId}`,
      body_md: body,
      to: [`global:${this.config.projectKey}`],
    });
  }
}

// ---------------------------------------------------------------------------
// Module-level shims that delegate to the singleton instance.
// Required to keep the existing public API (lifecycle-manager, notifier plugin).
// ---------------------------------------------------------------------------

export async function pollMcpMailInbox(): Promise<InboxMessage[]> {
  if (!_instance) return [];
  return _instance.pollInbox();
}

export async function sendMcpMailHeartbeat(currentTask?: string): Promise<void> {
  if (!_instance) return;
  await _instance.sendHeartbeat(currentTask);
}

export async function sendMcpMailSessionStart(taskDescription?: string): Promise<void> {
  if (!_instance) return;
  await _instance.sendSessionStart(taskDescription);
}

export async function sendMcpMailSessionEnd(doneTask?: string, blockedOn?: string): Promise<void> {
  if (!_instance) return;
  await _instance.sendSessionEnd(doneTask, blockedOn);
}

// ---------------------------------------------------------------------------
// Legacy in-memory bridge (existing API, unchanged)
// ---------------------------------------------------------------------------

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
