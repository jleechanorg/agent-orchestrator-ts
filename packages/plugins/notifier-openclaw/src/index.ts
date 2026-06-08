import {
  type EventPriority,
  type Notifier,
  type NotifyAction,
  type NotifyContext,
  type OrchestratorEvent,
  type PluginModule,
  recordActivityEvent,
} from "@jleechanorg/ao-core";
import { isRetryableHttpStatus, normalizeRetryConfig, validateUrl } from "@jleechanorg/ao-core/utils";

export const manifest = {
  name: "openclaw",
  slot: "notifier" as const,
  description: "Notifier plugin: OpenClaw webhook notifications",
  version: "0.1.0",
};

type WakeMode = "now" | "next-heartbeat";

interface OpenClawWebhookPayload {
  message: string;
  name?: string;
  sessionKey?: string;
  wakeMode?: WakeMode;
  deliver?: boolean;
  channel?: string;
  to?: string;
}

async function postWithRetry(
  url: string,
  payload: OpenClawWebhookPayload,
  headers: Record<string, string>,
  retries: number,
  retryDelayMs: number,
  context: { sessionId: string },
): Promise<void> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (response.ok) return;

      const body = await response.text();

      if (response.status === 401 || response.status === 403) {
        recordActivityEvent({
          sessionId: context.sessionId,
          source: "notifier",
          kind: "notifier.auth_failed",
          level: "error",
          summary: `OpenClaw rejected auth token (HTTP ${response.status})`,
          data: {
            plugin: "notifier-openclaw",
            status: response.status,
            url,
          },
        });
        lastError = new Error(
          `OpenClaw rejected the auth token (HTTP ${response.status}). Check hooks.token in OpenClaw config.`,
        );
        throw lastError;
      }

      lastError = new Error(`OpenClaw webhook failed (${response.status}): ${body}`);

      if (!isRetryableHttpStatus(response.status)) {
        throw lastError;
      }

      if (attempt < retries) {
        console.warn(
          `[notifier-openclaw] Retry ${attempt + 1}/${retries} for session=${context.sessionId} after HTTP ${response.status}`,
        );
      }
    } catch (err) {
      if (err === lastError) throw err;
      const networkErr = err instanceof Error ? err : new Error(String(err));
      lastError = networkErr;

      if (
        networkErr.message.includes("ECONNREFUSED") ||
        networkErr.message.includes("ETIMEDOUT") ||
        networkErr.message.includes("ENOTFOUND")
      ) {
        recordActivityEvent({
          sessionId: context.sessionId,
          source: "notifier",
          kind: "notifier.unreachable",
          level: "warn",
          summary: `OpenClaw gateway unreachable at ${url}`,
          data: {
            plugin: "notifier-openclaw",
            url,
            errorMessage: networkErr.message,
          },
        });
        throw new Error(
          `Can't reach OpenClaw gateway at ${url}. Is OpenClaw running?`,
          { cause: err },
        );
      }

      if (attempt < retries) {
        console.warn(
          `[notifier-openclaw] Retry ${attempt + 1}/${retries} for session=${context.sessionId} after network error: ${lastError.message}`,
        );
      }
    }

    if (attempt < retries) {
      const delay = retryDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

function sanitizeSessionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9:_-]/g, "-");
}

function sanitizeThreadTs(ts: string): string {
  return ts.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function eventHeadline(event: OrchestratorEvent): string {
  const priorityTag: Record<EventPriority, string> = {
    urgent: "URGENT",
    action: "ACTION",
    warning: "WARNING",
    info: "INFO",
  };
  return `[AO ${priorityTag[event.priority]}] ${event.sessionId} ${event.type}`;
}

function stringifyData(data?: Record<string, unknown> | null): string {
  if (!data) return "";
  const entries = Object.entries(data);
  if (entries.length === 0) return "";
  return `Context: ${JSON.stringify(data)}`;
}

function formatEscalationMessage(event: OrchestratorEvent): string {
  const parts = [eventHeadline(event), event.message, stringifyData(event.data)].filter(Boolean);
  return parts.join("\n");
}

function formatActionsLine(actions: NotifyAction[]): string {
  if (actions.length === 0) return "";
  const labels = actions.map((a) => a.label).join(", ");
  return `Actions available: ${labels}`;
}

export function create(config?: Record<string, unknown>): Notifier {
  const url =
    (typeof config?.url === "string" ? config.url : undefined) ??
    "http://127.0.0.1:18789/hooks/agent";
  const token =
    (typeof config?.token === "string" ? config.token : undefined) ??
    process.env.OPENCLAW_HOOKS_TOKEN;
  const senderName = typeof config?.name === "string" ? config.name : "AO";
  const sessionKeyPrefix =
    typeof config?.sessionKeyPrefix === "string" ? config.sessionKeyPrefix : "hook:ao:";
  const wakeMode: WakeMode = config?.wakeMode === "next-heartbeat" ? "next-heartbeat" : "now";
  const deliver = typeof config?.deliver === "boolean" ? config.deliver : true;

  const { retries, retryDelayMs } = normalizeRetryConfig(config);

  validateUrl(url, "notifier-openclaw");

  if (!token) {
    console.warn(
      "[notifier-openclaw] No token configured (token or OPENCLAW_HOOKS_TOKEN). Sending without Authorization header.",
    );
  }

  async function sendPayload(payload: OpenClawWebhookPayload): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const sessionId = payload.sessionKey?.slice(sessionKeyPrefix.length) ?? "default";

    await postWithRetry(url, payload, headers, retries, retryDelayMs, { sessionId });
  }

  return {
    name: "openclaw",

    async notify(event: OrchestratorEvent): Promise<void> {
      let sessionKey = `${sessionKeyPrefix}${sanitizeSessionId(event.sessionId)}`;
      
      const rawSlackThreadTs = event.data?.slackThreadTs;
      const slackThreadTs = typeof rawSlackThreadTs === "string" ? rawSlackThreadTs : process.env.SLACK_THREAD_TS;
      
      const rawSlackChannelId = event.data?.slackChannelId;
      const slackChannelId = typeof rawSlackChannelId === "string" ? rawSlackChannelId : process.env.SLACK_CHANNEL_ID;

      if (typeof slackThreadTs === "string") {
        sessionKey += `:thread:${sanitizeThreadTs(slackThreadTs)}`;
      }

      const payload: OpenClawWebhookPayload = {
        message: formatEscalationMessage(event),
        name: senderName,
        sessionKey,
        wakeMode,
        deliver,
      };

      if (typeof slackChannelId === "string") {
        payload.channel = "slack";
        payload.to = slackChannelId;
      }

      await sendPayload(payload);
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      let sessionKey = `${sessionKeyPrefix}${sanitizeSessionId(event.sessionId)}`;

      const rawSlackThreadTs = event.data?.slackThreadTs;
      const slackThreadTs = typeof rawSlackThreadTs === "string" ? rawSlackThreadTs : process.env.SLACK_THREAD_TS;

      const rawSlackChannelId = event.data?.slackChannelId;
      const slackChannelId = typeof rawSlackChannelId === "string" ? rawSlackChannelId : process.env.SLACK_CHANNEL_ID;

      if (typeof slackThreadTs === "string") {
        sessionKey += `:thread:${sanitizeThreadTs(slackThreadTs)}`;
      }
      const actionsLine = formatActionsLine(actions);
      const message = [formatEscalationMessage(event), actionsLine].filter(Boolean).join("\n");

      const payload: OpenClawWebhookPayload = {
        message,
        name: senderName,
        sessionKey,
        wakeMode,
        deliver,
      };

      if (typeof slackChannelId === "string") {
        payload.channel = "slack";
        payload.to = slackChannelId;
      }

      await sendPayload(payload);
    },

    async post(message: string, context?: NotifyContext): Promise<string | null> {
      const sessionId = context?.sessionId ? sanitizeSessionId(context.sessionId) : "default";
      let sessionKey = `${sessionKeyPrefix}${sessionId}`;

      const rawSlackThreadTs = context?.slackThreadTs;
      const slackThreadTs = typeof rawSlackThreadTs === "string" ? rawSlackThreadTs : process.env.SLACK_THREAD_TS;

      const rawSlackChannelId = context?.slackChannelId;
      const slackChannelId = typeof rawSlackChannelId === "string" ? rawSlackChannelId : process.env.SLACK_CHANNEL_ID;

      if (typeof slackThreadTs === "string") {
        sessionKey += `:thread:${sanitizeThreadTs(slackThreadTs)}`;
      }

      const payload: OpenClawWebhookPayload = {
        message,
        name: senderName,
        sessionKey,
        wakeMode,
        deliver,
      };

      if (typeof slackChannelId === "string") {
        payload.channel = "slack";
        payload.to = slackChannelId;
      }

      await sendPayload(payload);

      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
