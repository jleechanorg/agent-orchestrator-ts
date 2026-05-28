import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyAction, OrchestratorEvent } from "@jleechanorg/ao-core";
import { create, manifest } from "./index.js";

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "reaction.escalated",
    priority: "urgent",
    sessionId: "ao-5",
    projectId: "ao",
    timestamp: new Date("2026-03-20T12:00:00Z"),
    message: "CI failed after 5 retries",
    data: { attempts: 5, reason: "ci_failed" },
    ...overrides,
  };
}

function immediateConfig(extra?: Record<string, unknown>): Record<string, unknown> {
  return { webhookUrl: "https://discord.com/api/webhooks/123/abc", batchWindowMs: 0, ...extra };
}

describe("notifier-discord", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("has correct manifest", () => {
    expect(manifest.name).toBe("discord");
    expect(manifest.slot).toBe("notifier");
  });

  it("posts to Discord webhook URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create(immediateConfig());
    await notifier.notify(makeEvent());

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://discord.com/api/webhooks/123/abc");
  });

  it("sends Discord embed with correct structure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create(immediateConfig());
    await notifier.notify(makeEvent());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.username).toBe("Agent Orchestrator");
    expect(body.embeds).toHaveLength(1);

    const embed = body.embeds[0];
    expect(embed.title).toContain("ao-5");
    expect(embed.title).toContain("reaction.escalated");
    expect(embed.description).toBe("CI failed after 5 retries");
    expect(embed.color).toBe(0xed4245);
    expect(embed.timestamp).toBe("2026-03-20T12:00:00.000Z");
    expect(embed.footer.text).toBe("Agent Orchestrator");
  });

  it("includes project and priority fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create(immediateConfig());
    await notifier.notify(makeEvent());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const fields = body.embeds[0].fields;
    expect(fields).toContainEqual(expect.objectContaining({ name: "Project", value: "ao" }));
    expect(fields).toContainEqual(expect.objectContaining({ name: "Priority", value: "urgent" }));
  });

  it("includes PR link when available", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create(immediateConfig());
    await notifier.notify(makeEvent({ data: { prUrl: "https://github.com/org/repo/pull/42" } }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const prField = body.embeds[0].fields.find((f: { name: string }) => f.name === "Pull Request");
    expect(prField.value).toContain("https://github.com/org/repo/pull/42");
  });

  it("includes CI status when available", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create(immediateConfig());
    await notifier.notify(makeEvent({ data: { ciStatus: "passing" } }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const ciField = body.embeds[0].fields.find((f: { name: string }) => f.name === "CI");
    expect(ciField.value).toContain("passing");
  });

  it("notifyWithActions includes action links", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create(immediateConfig());
    const actions: NotifyAction[] = [
      { label: "View PR", url: "https://github.com/org/repo/pull/42" },
      { label: "retry" },
    ];
    await notifier.notifyWithActions!(makeEvent(), actions);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const actionsField = body.embeds[0].fields.find((f: { name: string }) => f.name === "Actions");
    expect(actionsField.value).toContain("View PR");
    expect(actionsField.value).toContain("retry");
  });

  it("post sends plain content message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create(immediateConfig());
    await notifier.post!("Session ao-5 completed successfully");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.content).toBe("Session ao-5 completed successfully");
    expect(body.embeds).toBeUndefined();
  });

  it("uses custom username when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create(immediateConfig({ username: "AO Bot" }));
    await notifier.notify(makeEvent());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.username).toBe("AO Bot");
  });

  it("includes avatar_url when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create(immediateConfig({ avatarUrl: "https://example.com/avatar.png" }));
    await notifier.notify(makeEvent());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.avatar_url).toBe("https://example.com/avatar.png");
  });

  it("includes thread_id when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create(immediateConfig({ threadId: "1234567890" }));
    await notifier.notify(makeEvent());

    const calledUrl = fetchMock.mock.calls[0][0];
    expect(calledUrl).toBe("https://discord.com/api/webhooks/123/abc?thread_id=1234567890");
  });

  it("is a no-op when webhookUrl not configured", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create();
    await notifier.notify(makeEvent());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("No webhookUrl configured"));
  });

  it("uses correct color for each priority", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create(immediateConfig());

    await notifier.notify(makeEvent({ priority: "info", message: "info event" }));
    let body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.embeds[0].color).toBe(0x57f287);

    await notifier.notify(makeEvent({ priority: "warning", message: "warning event" }));
    body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.embeds[0].color).toBe(0xfee75c);
  });

  it("handles 204 No Content as success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create(immediateConfig());
    await expect(notifier.notify(makeEvent())).resolves.toBeUndefined();
  });

  it("retries on 5xx response", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve("down") })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({
      ...immediateConfig(),
      retries: 1,
      retryDelayMs: 50,
    });
    const promise = notifier.notify(makeEvent());

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await promise;
    vi.useRealTimers();
  });

  it("does not retry on 4xx response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve("unauthorized") });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({
      ...immediateConfig(),
      retries: 2,
      retryDelayMs: 1,
    });
    await expect(notifier.post!("test")).rejects.toThrow("Discord webhook failed (401)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on non-Discord webhookUrl", () => {
    expect(() => create({ webhookUrl: "https://example.com/hook" })).toThrow(
      "[notifier-discord] webhookUrl must match",
    );
  });

  it("retries on 429 rate-limit with Retry-After header", async () => {
    vi.useFakeTimers();
    const retryAfterHeaders = new Map([["retry-after", "1"]]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (h: string) => retryAfterHeaders.get(h.toLowerCase()) ?? null },
        text: () => Promise.resolve("rate limited"),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({
      ...immediateConfig(),
      retries: 1,
      retryDelayMs: 50,
    });
    const promise = notifier.notify(makeEvent());

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await promise;
  });

  it("truncates title to 256 chars", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const longSessionId = "a".repeat(300);
    const notifier = create(immediateConfig());
    await notifier.notify(makeEvent({ sessionId: longSessionId }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.embeds[0].title.length).toBeLessThanOrEqual(256);
    expect(body.embeds[0].title.endsWith("\u2026")).toBe(true);
  });

  it("truncates post content to 2000 chars", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const longMsg = "x".repeat(2500);
    const notifier = create(immediateConfig());
    await notifier.post!(longMsg);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.content.length).toBeLessThanOrEqual(2000);
    expect(body.content.endsWith("\u2026")).toBe(true);
  });

  describe("batch window", () => {
    it("batches multiple notifications within the window", async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        webhookUrl: "https://discord.com/api/webhooks/123/abc",
        batchWindowMs: 500,
      });

      await notifier.notify(makeEvent({ id: "evt-1", message: "first" }));
      await notifier.notify(makeEvent({ id: "evt-2", message: "second" }));

      expect(fetchMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(600);

      expect(fetchMock).toHaveBeenCalledOnce();
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.embeds).toHaveLength(2);
      vi.useRealTimers();
    });

    it("sends immediately when batchWindowMs is 0", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create(immediateConfig());

      await notifier.notify(makeEvent());
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("splits into multiple messages when more than 10 embeds", async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        webhookUrl: "https://discord.com/api/webhooks/123/abc",
        batchWindowMs: 500,
      });

      for (let i = 0; i < 12; i++) {
        await notifier.notify(makeEvent({ id: `evt-${i}`, message: `event-${i}`, sessionId: `s-${i}` }));
      }

      await vi.advanceTimersByTimeAsync(600);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const body1 = JSON.parse(fetchMock.mock.calls[0][1].body);
      const body2 = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body1.embeds).toHaveLength(10);
      expect(body2.embeds).toHaveLength(2);
      vi.useRealTimers();
    });
  });

  describe("dedup", () => {
    it("collapses duplicate notifications with the same dedupe key", async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        webhookUrl: "https://discord.com/api/webhooks/123/abc",
        batchWindowMs: 500,
      });

      const event = makeEvent({ id: "evt-1", message: "CI failed" });
      await notifier.notify(event);
      await notifier.notify(event);
      await notifier.notify(event);

      await vi.advanceTimersByTimeAsync(600);

      expect(fetchMock).toHaveBeenCalledOnce();
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.embeds).toHaveLength(1);
      vi.useRealTimers();
    });

    it("allows different events through", async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        webhookUrl: "https://discord.com/api/webhooks/123/abc",
        batchWindowMs: 500,
      });

      await notifier.notify(makeEvent({ id: "evt-1", message: "first" }));
      await notifier.notify(makeEvent({ id: "evt-2", message: "second" }));

      await vi.advanceTimersByTimeAsync(600);

      expect(fetchMock).toHaveBeenCalledOnce();
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.embeds).toHaveLength(2);
      vi.useRealTimers();
    });

    it("allows duplicate after dedup TTL expires", async () => {
      vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create(immediateConfig());

      const event = makeEvent({ id: "evt-1", message: "CI failed" });
      await notifier.notify(event);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Same event within TTL should be deduped
      await notifier.notify(event);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Advance past dedup TTL (60s)
      vi.setSystemTime(new Date("2026-01-01T00:01:01Z"));

      await notifier.notify(event);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });
  });
});
