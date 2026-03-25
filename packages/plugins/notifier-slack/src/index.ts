import {
  validateUrl,
  type PluginModule,
  type Notifier,
  type OrchestratorEvent,
  type NotifyAction,
  type NotifyContext,
  type EventPriority,
  CI_STATUS,
} from "@jleechanorg/ao-core";

export const manifest = {
  name: "slack",
  slot: "notifier" as const,
  description: "Notifier plugin: Slack webhook notifications",
  version: "0.1.0",
};

const PRIORITY_EMOJI: Record<EventPriority, string> = {
  urgent: ":rotating_light:",
  action: ":point_right:",
  warning: ":warning:",
  info: ":information_source:",
};

function buildBlocks(event: OrchestratorEvent, actions?: NotifyAction[]): unknown[] {
  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${PRIORITY_EMOJI[event.priority]} ${event.type} — ${event.sessionId}`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: event.message,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*Project:* ${event.projectId} | *Priority:* ${event.priority} | *Time:* <!date^${Math.floor(event.timestamp.getTime() / 1000)}^{date_short_pretty} {time}|${event.timestamp.toISOString()}>`,
        },
      ],
    },
  ];

  // Add PR link if available (type-guarded)
  const prUrl = typeof event.data.prUrl === "string" ? event.data.prUrl : undefined;
  if (prUrl) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:github: <${prUrl}|View Pull Request>`,
      },
    });
  }

  // Add CI status if available (type-guarded)
  const ciStatus = typeof event.data.ciStatus === "string" ? event.data.ciStatus : undefined;
  if (ciStatus) {
    const ciEmoji = ciStatus === CI_STATUS.PASSING ? ":white_check_mark:" : ":x:";
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${ciEmoji} CI: ${ciStatus}`,
        },
      ],
    });
  }

  // Add action buttons
  if (actions && actions.length > 0) {
    const elements = actions
      .filter((a) => a.url || a.callbackEndpoint)
      .map((action) => {
        if (action.url) {
          return {
            type: "button",
            text: { type: "plain_text", text: action.label, emoji: true },
            url: action.url,
          };
        }
        const sanitized = action.label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "");
        const idx = actions.indexOf(action);
        const actionId = sanitized ? `${sanitized}_${idx}` : `action_${idx}`;
        return {
          type: "button",
          text: { type: "plain_text", text: action.label, emoji: true },
          action_id: `ao_${actionId}`,
          value: action.callbackEndpoint,
        };
      });

    if (elements.length > 0) {
      blocks.push({
        type: "actions",
        elements,
      });
    }
  }

  blocks.push({ type: "divider" });

  return blocks;
}

async function postToWebhook(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Slack webhook failed (${response.status}): ${body}`);
  }
}

/** In-memory dedup cache: key = "sessionId:eventType", value = last-sent timestamp (ms). */
type DedupEntry = { ts: number };

/**
 * Deduplication config for [[create]].
 * @param dedupTtlMs  Suppress duplicate notifies within this window (default 60 000 ms).
 */
export interface SlackNotifierConfig extends Record<string, unknown> {
  webhookUrl?: string;
  channel?: string;
  username?: string;
  /** Deduplication TTL in ms. Default: 60000. */
  dedupTtlMs?: number;
}

export function create(config: SlackNotifierConfig = {}): Notifier {
  const webhookUrl = config.webhookUrl;
  const defaultChannel = config.channel;
  const username = config.username ?? "Agent Orchestrator";
  const dedupTtlMs = config.dedupTtlMs ?? 60_000;

  if (!webhookUrl) {
    console.warn("[notifier-slack] No webhookUrl configured — notifications will be no-ops");
  } else {
    validateUrl(webhookUrl, "notifier-slack");
  }

  /** Deduplication map — per notifier instance, survives process restarts via launchd. */
  const dedupCache = new Map<string, DedupEntry>();
  const MAX_DEDUP_ENTRIES = 10_000;

  /**
   * Evict stale dedup entries older than [[dedupTtlMs]].
   * Call this on each send to keep the map bounded.
   */
  function sweepDedupCache(): void {
    const cutoff = Date.now() - dedupTtlMs;
    for (const [k, v] of dedupCache) {
      if (v.ts < cutoff) dedupCache.delete(k);
    }
    if (dedupCache.size <= MAX_DEDUP_ENTRIES) return;
    // Over limit — evict oldest half
    const sorted = [...dedupCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (const [k] of sorted.slice(0, sorted.length / 2)) dedupCache.delete(k);
  }

  /**
   * Return true if the (sessionId, eventType) pair was already sent
   * within [[dedupTtlMs]]; false if it is new or the entry is stale.
   * Does NOT update the timestamp — only [[recordSend]] marks a send.
   */
  function isRecentlySent(sessionId: string, eventType: string): boolean {
    const key = `${sessionId}:${eventType}`;
    const entry = dedupCache.get(key);
    if (!entry) return false;
    if (Date.now() - entry.ts >= dedupTtlMs) {
      dedupCache.delete(key); // stale, allow through
      return false;
    }
    return true;
  }

  /** Record a successful send so future calls within TTL are suppressed. */
  function recordSend(sessionId: string, eventType: string): void {
    sweepDedupCache();
    dedupCache.set(`${sessionId}:${eventType}`, { ts: Date.now() });
  }

  async function sendNotify(event: OrchestratorEvent, actions?: NotifyAction[]): Promise<void> {
    if (!webhookUrl) return;
    if (isRecentlySent(event.sessionId, event.type)) return;

    const payload: Record<string, unknown> = {
      username,
      blocks: buildBlocks(event, actions),
    };
    if (defaultChannel) payload.channel = defaultChannel;

    await postToWebhook(webhookUrl, payload);
    recordSend(event.sessionId, event.type);
  }

  return {
    name: "slack",

    async notify(event: OrchestratorEvent): Promise<void> {
      await sendNotify(event);
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      await sendNotify(event, actions);
    },

    async post(message: string, context?: NotifyContext): Promise<string | null> {
      if (!webhookUrl) return null;
      const channel = context?.channel ?? defaultChannel;
      const payload: Record<string, unknown> = { username, text: message };
      if (channel) payload.channel = channel;
      await postToWebhook(webhookUrl, payload);
      // Incoming webhooks don't return a message ID
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
