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

let _mcpClientConfig: McpMailClientConfig | null = null;
let _registrationPromise: Promise<void> | null = null;
/** IDs of all messages returned in the previous poll — used to surface only new messages. */
let _lastSeenMessageIds = new Set<string>();

export function initMcpMailClient(config: McpMailClientConfig): void {
  _mcpClientConfig = config;
  _registrationPromise = null;
  _lastSeenMessageIds = new Set();
}

export function getMcpMailClientConfig(): McpMailClientConfig | null {
  return _mcpClientConfig;
}

async function apiPost(toolName: string, params: Record<string, unknown>): Promise<unknown> {
  if (!_mcpClientConfig) throw new Error("MCP mail client not initialized");
  const base = _mcpClientConfig.endpoint.replace(/\/+$/, "").replace(/\/mcp$/, "");
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

async function ensureRegistered(): Promise<void> {
  if (!_mcpClientConfig) return;
  if (!_registrationPromise) {
    const p = (async () => {
      await apiPost("register_agent", {
        project_key: _mcpClientConfig!.projectKey,
        program: "agent-orchestrator",
        model: "claude",
        agent_name: _mcpClientConfig!.agentId,
      });
    })();
    _registrationPromise = p;
    p.catch(() => { _registrationPromise = null; });
  }
  await _registrationPromise;
}

/** Inbox message shape returned by fetch_inbox. */
export interface InboxMessage {
  id: string;
  project_key: string;
  sender_name: string;
  to: string[];
  subject: string;
  body_md: string;
  created_at: string;
  read: boolean;
}

/** Callback invoked with new inbox messages on each poll. */
export type InboxCallback = (messages: InboxMessage[]) => void;
let _inboxCallback: InboxCallback | null = null;

export function setMcpMailInboxCallback(cb: InboxCallback): void {
  _inboxCallback = cb;
}

/**
 * Fetch the global inbox, surface new messages via the registered callback,
 * and return all messages from the last fetch.
 */
export async function pollMcpMailInbox(): Promise<InboxMessage[]> {
  if (!_mcpClientConfig) return [];

  try {
    await ensureRegistered();
    const raw = await apiPost("fetch_inbox", {
      project_key: _mcpClientConfig.projectKey,
      agent_name: _mcpClientConfig.agentId,
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
      // Skip error text (e.g. "Error calling tool...") returned when agent not found
      const rawText = result.content[0].text;
      try {
        rawMessages = JSON.parse(rawText) as unknown[];
      } catch {
        // non-JSON response (error message) — treat as empty inbox
      }
    }

    const messages: InboxMessage[] = rawMessages.map((m) => {
      const msg = m as Record<string, unknown>;
      return {
        id: String(msg["id"] ?? msg["message_id"] ?? ""),
        project_key: _mcpClientConfig!.projectKey,
        sender_name: String(msg["sender_name"] ?? msg["from"] ?? msg["sender"] ?? ""),
        to: Array.isArray(msg["to"]) ? (msg["to"] as string[]) : [],
        subject: String(msg["subject"] ?? ""),
        body_md: String(msg["body_md"] ?? msg["body"] ?? msg["text"] ?? ""),
        created_at: String(msg["created_at"] ?? msg["created_ts"] ?? msg["timestamp"] ?? ""),
        read: Boolean(msg["read"] ?? msg["is_read"]),
      };
    });

    // Surface only messages not seen in the previous poll
    const newMessages = messages.filter((m) => !_lastSeenMessageIds.has(m.id));

    // Remember all IDs from this fetch so next poll can exclude them
    _lastSeenMessageIds = new Set(messages.map((m) => m.id));

    if (newMessages.length > 0 && _inboxCallback) {
      try { _inboxCallback(newMessages); } catch { /* non-fatal */ }
    }

    return messages;
  } catch (err) {
    console.warn(
      `[mcp-mail] Inbox poll failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

async function mcpSend(params: {
  subject: string;
  body_md: string;
  to?: string[];
}): Promise<void> {
  if (!_mcpClientConfig) return;
  await ensureRegistered();
  await apiPost("send_message", {
    project_key: _mcpClientConfig.projectKey,
    sender_name: _mcpClientConfig.agentId,
    to: params.to ?? [],
    subject: params.subject,
    body_md: params.body_md,
  });
}

/** Send a heartbeat to the global inbox (worker wake-up + periodic). */
export async function sendMcpMailHeartbeat(currentTask?: string): Promise<void> {
  if (!_mcpClientConfig) return;
  const body = currentTask ? `I'm working on: ${currentTask}` : "I'm alive — heartbeat";
  await mcpSend({
    subject: `worker heartbeat — ${_mcpClientConfig.agentId}`,
    body_md: body,
    to: [`global:${_mcpClientConfig.projectKey}`],
  });
}

/** Send a session-start message to the global inbox. */
export async function sendMcpMailSessionStart(taskDescription?: string): Promise<void> {
  if (!_mcpClientConfig) return;
  const body = taskDescription ? `Starting task: ${taskDescription}` : "Session started";
  await mcpSend({
    subject: `session start — ${_mcpClientConfig.agentId}`,
    body_md: body,
    to: [`global:${_mcpClientConfig.projectKey}`],
  });
}

/** Send a session-end message to the global inbox. */
export async function sendMcpMailSessionEnd(doneTask?: string, blockedOn?: string): Promise<void> {
  if (!_mcpClientConfig) return;
  let body = doneTask ? `Done with: ${doneTask}` : "Session ended";
  if (blockedOn) body += `\nBlocked on: ${blockedOn}`;
  await mcpSend({
    subject: `session end — ${_mcpClientConfig.agentId}`,
    body_md: body,
    to: [`global:${_mcpClientConfig.projectKey}`],
  });
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
