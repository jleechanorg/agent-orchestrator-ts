import {
  recordActivityEvent,
  validateUrl,
  type PluginModule,
  type Notifier,
  type OrchestratorEvent,
  type NotifyAction,
  type NotifyContext,
  type EventPriority,
  CI_STATUS,
} from "@jleechanorg/ao-core";
import { isRetryableHttpStatus, normalizeRetryConfig } from "@jleechanorg/ao-core/utils";

export const manifest = {
  name: "discord",
  slot: "notifier" as const,
  description: "Notifier plugin: Discord webhook notifications with rich embeds, batching, and dedup",
  version: "0.2.0",
};

const PRIORITY_COLOR: Record<EventPriority, number> = {
  urgent: 0xed4245,
  action: 0x5865f2,
  warning: 0xfee75c,
  info: 0x57f287,
};

const PRIORITY_EMOJI: Record<EventPriority, string> = {
  urgent: "\u{1F6A8}",
  action: "\u{1F449}",
  warning: "\u{26A0}\u{FE0F}",
  info: "\u{2139}\u{FE0F}",
};

const DISCORD_WEBHOOK_URL_RE =
  /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\//;

const EMBED_DESCRIPTION_MAX = 4096;
const EMBED_TITLE_MAX = 256;
const EMBED_FIELD_VALUE_MAX = 1024;
const POST_CONTENT_MAX = 2000;

const DEFAULT_BATCH_WINDOW_MS = 2_000;
const DEDUP_TTL_MS = 60_000;

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 1) + "\u2026" : text;
}

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  timestamp?: string;
  footer?: { text: string };
}

function buildEmbed(event: OrchestratorEvent, actions?: NotifyAction[]): DiscordEmbed {
  const emoji = PRIORITY_EMOJI[event.priority];
  const description = truncate(event.message, EMBED_DESCRIPTION_MAX);
  const embed: DiscordEmbed = {
    title: truncate(`${emoji} ${event.type} — ${event.sessionId}`, EMBED_TITLE_MAX),
    description,
    color: PRIORITY_COLOR[event.priority],
    fields: [
      { name: "Project", value: truncate(event.projectId, EMBED_FIELD_VALUE_MAX), inline: true },
      { name: "Priority", value: event.priority, inline: true },
    ],
    timestamp: event.timestamp.toISOString(),
    footer: { text: "Agent Orchestrator" },
  };

  const prUrl = typeof event.data.prUrl === "string" ? event.data.prUrl : undefined;
  if (prUrl) {
    embed.fields!.push({ name: "Pull Request", value: truncate(`[View PR](${prUrl})`, EMBED_FIELD_VALUE_MAX), inline: false });
  }

  const ciStatus = typeof event.data.ciStatus === "string" ? event.data.ciStatus : undefined;
  if (ciStatus) {
    const ciEmoji =
      ciStatus === CI_STATUS.PASSING
        ? "\u{2705}"
        : ciStatus === CI_STATUS.PENDING
          ? "\u{23F3}"
          : ciStatus === CI_STATUS.NONE
            ? "\u{2B55}"
            : "\u{274C}";
    embed.fields!.push({ name: "CI", value: truncate(`${ciEmoji} ${ciStatus}`, EMBED_FIELD_VALUE_MAX), inline: true });
  }

  if (actions && actions.length > 0) {
    const actionLinks = actions.map((a) => {
      if (a.url) return `[${a.label}](${a.url})`;
      return `\`${a.label}\``;
    });
    embed.fields!.push({ name: "Actions", value: truncate(actionLinks.join(" | "), EMBED_FIELD_VALUE_MAX), inline: false });
  }

  return capEmbedTotalChars(embed);
}

const DEFAULT_TIMEOUT_MS = 10_000;
const EMBED_TOTAL_CHARS_MAX = 6000;

function capEmbedTotalChars(embed: DiscordEmbed): DiscordEmbed {
  const count = (s: string | undefined) => s?.length ?? 0;
  const fieldChars = (embed.fields ?? []).reduce(
    (acc, f) => acc + f.name.length + f.value.length,
    0,
  );
  const total =
    count(embed.title) +
    count(embed.description) +
    fieldChars +
    count(embed.footer?.text);
  if (total <= EMBED_TOTAL_CHARS_MAX) return embed;
  const overhead = total - count(embed.description);
  const maxDesc = Math.max(0, EMBED_TOTAL_CHARS_MAX - overhead - 1);
  return {
    ...embed,
    description: embed.description
      ? embed.description.slice(0, maxDesc) + "\u2026"
      : embed.description,
  };
}

async function postWithRetry(
  webhookUrl: string,
  payload: Record<string, unknown>,
  retries: number,
  retryDelayMs: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  let lastError: Error | undefined;
  let rateLimitRetries = 0;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.ok || response.status === 204) return;

      if (response.status === 429) {
        if (rateLimitRetries < retries) {
          const retryAfter = response.headers.get("Retry-After");
          const waitMs = retryAfter ? (parseFloat(retryAfter) || 1) * 1000 : retryDelayMs;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          rateLimitRetries++;
          attempt--;
          continue;
        }
        const body = await response.text().catch(() => "");
        recordActivityEvent({
          source: "notifier",
          kind: "notifier.rate_limited",
          level: "warn",
          summary: `Discord webhook rate-limit retry budget exhausted`,
          data: {
            plugin: "notifier-discord",
            status: 429,
            rateLimitRetries,
          },
        });
        lastError = new Error(`Discord webhook rate-limited (HTTP 429)${body ? `: ${body.trim()}` : ""}`);
        throw lastError;
      }

      const body = await response.text();
      lastError = new Error(`Discord webhook failed (${response.status}): ${body}`);

      if (!isRetryableHttpStatus(response.status)) {
        throw lastError;
      }
    } catch (err) {
      if (err === lastError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }

    if (attempt < retries) {
      const delay = retryDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

function eventDedupeKey(event: OrchestratorEvent): string {
  return `${event.type}:${event.sessionId}:${event.projectId}:${event.message}`;
}

interface PendingItem {
  embed: DiscordEmbed;
  dedupeKey: string;
  enqueuedAt: number;
}

export function create(config?: Record<string, unknown>): Notifier {
  if (config?.webhookUrl !== undefined && typeof config.webhookUrl !== "string") {
    throw new Error("[notifier-discord] webhookUrl must be a string");
  }
  if (config?.username !== undefined && typeof config.username !== "string") {
    throw new Error("[notifier-discord] username must be a string");
  }
  if (config?.avatarUrl !== undefined && typeof config.avatarUrl !== "string") {
    throw new Error("[notifier-discord] avatarUrl must be a string");
  }
  if (config?.threadId !== undefined && typeof config.threadId !== "string") {
    throw new Error("[notifier-discord] threadId must be a string");
  }
  if (config?.batchWindowMs !== undefined && typeof config.batchWindowMs !== "number") {
    throw new Error("[notifier-discord] batchWindowMs must be a number");
  }

  const webhookUrl = typeof config?.webhookUrl === "string" ? config.webhookUrl : undefined;
  const username = typeof config?.username === "string" ? config.username : "Agent Orchestrator";
  const avatarUrl = typeof config?.avatarUrl === "string" ? config.avatarUrl : undefined;
  const threadId = typeof config?.threadId === "string" ? config.threadId : undefined;

  const { retries, retryDelayMs } = normalizeRetryConfig(config);
  const rawTimeoutMs = config?.timeoutMs;
  if (
    rawTimeoutMs !== undefined &&
    (typeof rawTimeoutMs !== "number" || !Number.isFinite(rawTimeoutMs) || rawTimeoutMs <= 0)
  ) {
    throw new Error("[notifier-discord] timeoutMs must be a positive finite number");
  }
  const timeoutMs = typeof rawTimeoutMs === "number" ? rawTimeoutMs : DEFAULT_TIMEOUT_MS;
  const batchWindowMs = typeof config?.batchWindowMs === "number" && config.batchWindowMs >= 0
    ? config.batchWindowMs
    : DEFAULT_BATCH_WINDOW_MS;

  if (!webhookUrl) {
    console.warn(
      "[notifier-discord] No webhookUrl configured.\n" +
      "  Set it in agent-orchestrator.yaml under notifiers.discord.webhookUrl\n" +
      "  Create a webhook: Discord Server Settings > Integrations > Webhooks > New Webhook",
    );
  } else {
    validateUrl(webhookUrl, "notifier-discord");
    if (!DISCORD_WEBHOOK_URL_RE.test(webhookUrl)) {
      throw new Error(
        "[notifier-discord] webhookUrl must match https://discord.com/api/webhooks/... or https://discordapp.com/api/webhooks/...",
      );
    }
  }

  const effectiveUrl = webhookUrl && threadId
    ? `${webhookUrl}${webhookUrl.includes("?") ? "&" : "?"}thread_id=${encodeURIComponent(threadId)}`
    : webhookUrl;

  function buildPayload(embeds: DiscordEmbed[]): Record<string, unknown> {
    const payload: Record<string, unknown> = { username, embeds };
    if (avatarUrl) payload.avatar_url = avatarUrl;
    return payload;
  }

  // ── Batch + dedup state ──
  const pending: PendingItem[] = [];
  const seenKeys = new Map<string, number>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flush(): Promise<void> {
    flushTimer = null;

    const now = Date.now();
    for (const [key, ts] of seenKeys) {
      if (now - ts >= DEDUP_TTL_MS) seenKeys.delete(key);
    }

    if (pending.length === 0) return Promise.resolve();

    const batches: DiscordEmbed[][] = [];
    let current: DiscordEmbed[] = [];
    for (const item of pending) {
      current.push(item.embed);
      if (current.length >= 10) {
        batches.push(current);
        current = [];
      }
    }
    if (current.length > 0) batches.push(current);

    pending.splice(0);

    const promises = batches.map((batch) => {
      const payload = buildPayload(batch);
      return postWithRetry(effectiveUrl!, payload, retries, retryDelayMs, timeoutMs).catch(() => {});
    });
    return Promise.all(promises).then(() => {});
  }

  function scheduleFlush(): void {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => void flush(), batchWindowMs);
    if (flushTimer && typeof flushTimer === "object" && "unref" in flushTimer) {
      flushTimer.unref();
    }
  }

  function enqueue(event: OrchestratorEvent, actions?: NotifyAction[]): Promise<void> {
    if (!effectiveUrl) return Promise.resolve();

    const dedupeKey = eventDedupeKey(event);
    const now = Date.now();
    const lastSeen = seenKeys.get(dedupeKey);
    if (lastSeen !== undefined && now - lastSeen < DEDUP_TTL_MS) {
      return Promise.resolve();
    }
    seenKeys.set(dedupeKey, now);

    pending.push({
      embed: buildEmbed(event, actions),
      dedupeKey,
      enqueuedAt: now,
    });

    if (batchWindowMs <= 0) {
      return flush();
    } else {
      scheduleFlush();
      return Promise.resolve();
    }
  }

  return {
    name: "discord",

    async notify(event: OrchestratorEvent): Promise<void> {
      await enqueue(event);
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      await enqueue(event, actions);
    },

    async post(message: string, _context?: NotifyContext): Promise<string | null> {
      if (!effectiveUrl) return null;
      const payload: Record<string, unknown> = { username, content: truncate(message, POST_CONTENT_MAX) };
      if (avatarUrl) payload.avatar_url = avatarUrl;
      await postWithRetry(effectiveUrl, payload, retries, retryDelayMs, timeoutMs);
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
