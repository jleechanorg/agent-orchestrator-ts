import {
  type PluginModule,
  type Notifier,
  type OrchestratorEvent,
  type NotifyAction,
  type NotifyContext,
  validateUrl,
} from "@jleechanorg/ao-core";

export const manifest = {
  name: "mcp-mail",
  slot: "notifier" as const,
  description: "Notifier plugin: MCP Agent Mail inter-agent messaging",
  version: "0.1.0",
};

/** Timeout for outbound MCP calls (ms). */
const MCP_TIMEOUT_MS = 30_000;

/** Monotonic counter for JSON-RPC request IDs — avoids Date.now() collisions. */
let rpcIdCounter = 0;
function nextRpcId(): number {
  return ++rpcIdCounter;
}

interface SendMessageParams {
  project_key: string;
  sender_name: string;
  to: string[];
  subject: string;
  body_md: string;
}

interface RegisterAgentParams {
  project_key: string;
  program: string;
  model: string;
  name: string;
}

async function apiPost(endpoint: string, method: string, params: unknown): Promise<void> {
  // Strip trailing slashes and any existing /mcp suffix to avoid doubling
  // when MCP_AGENT_MAIL_URL already includes /mcp/ (e.g. http://host:8765/mcp/)
  const base = endpoint.replace(/\/+$/, "").replace(/\/mcp$/, "");
  const url = `${base}/mcp`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: nextRpcId() }),
    signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`MCP mail ${method} failed (${response.status}): ${body}`);
  }

  const result = (await response.json()) as { error?: { message?: string } };
  if (result.error) {
    throw new Error(
      `MCP mail ${method} JSON-RPC error: ${result.error.message ?? JSON.stringify(result.error)}`,
    );
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
    typeof config?.endpoint === "string" ? config.endpoint : process.env["MCP_AGENT_MAIL_URL"];

  const agentId =
    typeof config?.agentId === "string" ? config.agentId : "ao-session";
  const projectKey =
    typeof config?.projectId === "string" ? config.projectId : "";
  const defaultTo: string[] =
    Array.isArray(config?.to)
      ? (config.to as unknown[]).filter((v): v is string => typeof v === "string")
      : [];

  if (!endpoint) {
    console.warn("[notifier-mcp-mail] No endpoint configured — notifications will be no-ops");
  } else {
    validateUrl(endpoint, "notifier-mcp-mail");
  }

  if (endpoint && !projectKey) {
    console.warn("[notifier-mcp-mail] No projectId configured — project_key will be empty; server may reject messages");
  }
  if (endpoint && defaultTo.length === 0) {
    console.warn("[notifier-mcp-mail] No to recipients configured — send_message calls will have empty to[]");
  }

  let registrationPromise: Promise<void> | null = null;

  async function ensureRegistered(): Promise<void> {
    if (!endpoint) return;
    if (!registrationPromise) {
      const p = (async () => {
        const params: RegisterAgentParams = {
          project_key: projectKey,
          program: "agent-orchestrator",
          model: "claude",
          name: agentId,
        };
        await apiPost(endpoint, "register_agent", params);
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

      const params: SendMessageParams = {
        project_key: projectKey,
        sender_name: agentId,
        to: defaultTo,
        subject: `[AO] ${event.type} — ${event.sessionId}`,
        body_md: buildMessageBody(event),
      };

      await apiPost(endpoint, "send_message", params);
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!endpoint) return;
      await ensureRegistered();

      const params: SendMessageParams = {
        project_key: projectKey,
        sender_name: agentId,
        to: defaultTo,
        subject: `[AO] ${event.type} — ${event.sessionId}`,
        body_md: buildBodyWithActions(event, actions),
      };

      await apiPost(endpoint, "send_message", params);
    },

    async post(message: string, context?: NotifyContext): Promise<string | null> {
      if (!endpoint) return null;
      await ensureRegistered();

      const to = context?.channel ? [context.channel] : defaultTo;
      const params: SendMessageParams = {
        project_key: projectKey,
        sender_name: agentId,
        to,
        subject: "[AO] message",
        body_md: message,
      };

      await apiPost(endpoint, "send_message", params);
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
