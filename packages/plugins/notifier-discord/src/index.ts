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
import { isRetryableHttpStatus, normalizeRetryConfig } from "@jleechanorg/ao-core/utils";

export const manifest = {
  name: "discord",
  slot: "notifier" as const,
  description: "Notifier plugin: Discord webhook notifications with rich embeds",
  version: "0.1.0",
};

// Discord embed color codes (decimal)
const PRIORITY_COLOR: Record<EventPriority, number> = {
  urgent: 0xed4245, // red
  action: 0x5865f2, // blurple
  warning: 0xfee75c, // yellow
  info: 0x57f287, // green
};

const PRIORITY_EMOJI: Record<EventPriority, string> = {
  urgent: "\u{1F6A8}", // rotating light
  action: "\u{1F449}", // point right
  warning: "\u{26A0}\u{FE0F}", // warning
  info: "\u{2139}\u{FE0F}", // info
};

const DISCORD_WEBHOOK_URL_RE =
  /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\//;

const EMBED_DESCRIPTION_MAX = 4096;
const EMBED_TITLE_MAX = 256;
const EMBED_FIELD_VALUE_MAX = 1024;
const POST_CONTENT_MAX = 2000;

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
  const description =
    event.message.length > EMBED_DESCRIPTION_MAX
      ? event.message.slice(0, EMBED_DESCRIPTION_MAX - 1) + "\u2026"
      : event.message;
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

  // Add PR link if available
  const prUrl = typeof event.data.prUrl === "string" ? event.data.prUrl : undefined;
  if (prUrl) {
    embed.fields!.push({ name: "Pull Request", value: truncate(`[View PR](${prUrl})`, EMBED_FIELD_VALUE_MAX), inline: false });
  }

  // Add CI status if available
  const ciStatus = typeof event.data.ciStatus === "string" ? event.data.ciStatus : undefined;
  if (ciStatus) {
    const ciEmoji =
      ciStatus === CI_STATUS.PASSING
        ? "\u{2705}"
        : ciStatus === CI_STATUS.PENDING
          ? "\u{23F3}"
          : ciStatus === CI_STATUS.NONE
            ? "\u{2B55}"
            : "\u{274C}"; // FAILING or unknown
    embed.fields!.push({ name: "CI", value: truncate(`${ciEmoji} ${ciStatus}`, EMBED_FIELD_VALUE_MAX), inline: true });
  }

  // Add actions as a field
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
  // Trim description to bring total within limit
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
  // Separate counter for 429 Retry-After waits so they don't consume the error
  // retry budget — a server-mandated wait shouldn't cost a retry slot.
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

      // Handle rate limiting: wait then retry without burning an error retry slot.
      // Use Retry-After if present, otherwise fall back to retryDelayMs.
      if (response.status === 429) {
        if (rateLimitRetries < retries) {
          const retryAfter = response.headers.get("Retry-After");
          const waitMs = retryAfter ? (parseFloat(retryAfter) || 1) * 1000 : retryDelayMs;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          rateLimitRetries++;
          attempt--; // undo the for-loop increment so error budget is preserved
          continue;
        }
        // Rate-limit budget exhausted — fail immediately rather than falling through
        // to the error retry path (which would compound the two counters).
        const body = await response.text().catch(() => "");
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

export function create(config?: Record<string, unknown>): Notifier {
  const webhookUrl = config?.webhookUrl as string | undefined;
  const username = (config?.username as string) ?? "Agent Orchestrator";
  const avatarUrl = config?.avatarUrl as string | undefined;
  const threadId = config?.threadId as string | undefined;

  const { retries, retryDelayMs } = normalizeRetryConfig(config);
  const timeoutMs =
    typeof config?.timeoutMs === "number" ? config.timeoutMs : DEFAULT_TIMEOUT_MS;

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

  // Discord requires thread_id as a URL query param, not in the JSON body
  const effectiveUrl = webhookUrl && threadId
    ? `${webhookUrl}${webhookUrl.includes("?") ? "&" : "?"}thread_id=${encodeURIComponent(threadId)}`
    : webhookUrl;

  function buildPayload(embeds: DiscordEmbed[]): Record<string, unknown> {
    const payload: Record<string, unknown> = { username, embeds };
    if (avatarUrl) payload.avatar_url = avatarUrl;
    return payload;
  }

  return {
    name: "discord",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!effectiveUrl) return;
      const payload = buildPayload([buildEmbed(event)]);
      await postWithRetry(effectiveUrl, payload, retries, retryDelayMs, timeoutMs);
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!effectiveUrl) return;
      const payload = buildPayload([buildEmbed(event, actions)]);
      await postWithRetry(effectiveUrl, payload, retries, retryDelayMs, timeoutMs);
    },

    async post(message: string, _context?: NotifyContext): Promise<string | null> {
      if (!effectiveUrl) return null;
      const payload: Record<string, unknown> = { username, content: truncate(message, POST_CONTENT_MAX) };
      if (avatarUrl) payload.avatar_url = avatarUrl;
      // thread_id is already passed as a URL query param via effectiveUrl
      await postWithRetry(effectiveUrl, payload, retries, retryDelayMs, timeoutMs);
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
