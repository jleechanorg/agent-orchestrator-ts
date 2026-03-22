import {
  type PluginModule,
  type Notifier,
  type OrchestratorEvent,
  type NotifyAction,
  type NotifyContext,
} from "@jleechanorg/ao-core";

export const manifest = {
  name: "mcp-mail",
  slot: "notifier" as const,
  description: "Notifier plugin: MCP Agent Mail inter-agent messaging",
  version: "0.1.0",
};

interface SendMessagePayload {
  from: string;
  to?: string;
  subject: string;
  body: string;
  projectId?: string;
  metadata?: Record<string, unknown>;
}

interface RegisterAgentPayload {
  agentId: string;
  projectId?: string;
  description?: string;
}

async function apiPost(endpoint: string, path: string, payload: unknown): Promise<void> {
  const url = `${endpoint.replace(/\/$/, "")}/${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`MCP mail ${path} failed (${response.status}): ${body}`);
  }
}

function buildMessageBody(event: OrchestratorEvent): string {
  const lines: string[] = [
    event.message,
    "",
    `Session: ${event.sessionId}`,
    `Project: ${event.projectId}`,
    `Priority: ${event.priority}`,
    `Time: ${event.timestamp.toISOString()}`,
  ];

  const prUrl = typeof event.data.prUrl === "string" ? event.data.prUrl : undefined;
  if (prUrl) lines.push(`PR: ${prUrl}`);

  const ciStatus = typeof event.data.ciStatus === "string" ? event.data.ciStatus : undefined;
  if (ciStatus) lines.push(`CI: ${ciStatus}`);

  return lines.join("\n");
}

function buildBodyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): string {
  const base = buildMessageBody(event);
  if (actions.length === 0) return base;

  const actionLines = actions.map((a) => {
    if (a.url) return `- ${a.label}: ${a.url}`;
    if (a.callbackEndpoint) return `- ${a.label} [callback: ${a.callbackEndpoint}]`;
    return `- ${a.label}`;
  });

  return `${base}\n\nActions:\n${actionLines.join("\n")}`;
}

export function create(config?: Record<string, unknown>): Notifier {
  const endpoint =
    (config?.endpoint as string | undefined) ?? process.env["MCP_AGENT_MAIL_URL"];
  const agentId = (config?.agentId as string | undefined) ?? "ao-session";
  const projectId = config?.projectId as string | undefined;

  if (!endpoint) {
    console.warn("[notifier-mcp-mail] No endpoint configured — notifications will be no-ops");
  } else {
    try {
      new URL(endpoint);
    } catch {
      throw new Error(`[notifier-mcp-mail] Invalid endpoint URL: ${endpoint}`);
    }
  }

  let registrationPromise: Promise<void> | null = null;

  async function ensureRegistered(): Promise<void> {
    if (!endpoint) return;
    if (!registrationPromise) {
      const p = (async () => {
        const payload: RegisterAgentPayload = {
          agentId,
          description: "Agent Orchestrator session notifier",
        };
        if (projectId) payload.projectId = projectId;
        await apiPost(endpoint, "register_agent", payload);
      })();
      registrationPromise = p;
      p.catch(() => {
        registrationPromise = null;
      });
    }
    await registrationPromise;
  }

  return {
    name: "mcp-mail",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!endpoint) return;
      await ensureRegistered();

      const payload: SendMessagePayload = {
        from: agentId,
        subject: `[AO] ${event.type} — ${event.sessionId}`,
        body: buildMessageBody(event),
      };
      if (projectId) payload.projectId = projectId;

      await apiPost(endpoint, "send_message", payload);
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!endpoint) return;
      await ensureRegistered();

      const payload: SendMessagePayload = {
        from: agentId,
        subject: `[AO] ${event.type} — ${event.sessionId}`,
        body: buildBodyWithActions(event, actions),
      };
      if (projectId) payload.projectId = projectId;

      await apiPost(endpoint, "send_message", payload);
    },

    async post(message: string, context?: NotifyContext): Promise<string | null> {
      if (!endpoint) return null;
      await ensureRegistered();

      const payload: SendMessagePayload = {
        from: agentId,
        subject: "[AO] message",
        body: message,
      };
      if (context?.channel) payload.to = context.channel;
      if (projectId) payload.projectId = projectId;

      await apiPost(endpoint, "send_message", payload);
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
