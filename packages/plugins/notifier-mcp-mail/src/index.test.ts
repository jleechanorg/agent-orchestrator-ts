import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrchestratorEvent, NotifyAction } from "@jleechanorg/ao-core";
import { manifest, create } from "./index.js";

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "session.spawned",
    priority: "info",
    sessionId: "app-1",
    projectId: "my-project",
    timestamp: new Date("2025-06-15T12:00:00Z"),
    message: "Session app-1 spawned successfully",
    data: {},
    ...overrides,
  };
}

function mockFetchOk(responseBody: unknown = { ok: true }) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(responseBody),
    text: () => Promise.resolve(JSON.stringify(responseBody)),
  });
}


describe("notifier-mcp-mail", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("mcp-mail");
      expect(manifest.slot).toBe("notifier");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("create", () => {
    it("returns a notifier with name 'mcp-mail'", () => {
      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-session-1" });
      expect(notifier.name).toBe("mcp-mail");
    });

    it("warns when no endpoint configured", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      create();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("No endpoint configured"));
    });

    it("uses MCP_AGENT_MAIL_URL env var as default endpoint", () => {
      vi.stubGlobal("process", {
        ...process,
        env: { ...process.env, MCP_AGENT_MAIL_URL: "http://env-host:4000" },
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const notifier = create({ agentId: "ao-1" });
      // Should not warn — env var filled in endpoint
      expect(warnSpy).not.toHaveBeenCalled();
      expect(notifier.name).toBe("mcp-mail");
    });
  });

  describe("notify — no endpoint", () => {
    it("does nothing when no endpoint configured", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      const notifier = create();
      await notifier.notify(makeEvent());
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("notify — with endpoint", () => {
    // Helper: find the send_message call (register_agent fires first)
    function getSendCall(fetchMock: ReturnType<typeof mockFetchOk>) {
      return fetchMock.mock.calls.find((call) =>
        (call[0] as string).includes("send_message"),
      )!;
    }

    it("POSTs to the send_message endpoint", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await notifier.notify(makeEvent());

      const sendCall = getSendCall(fetchMock);
      expect(sendCall).toBeDefined();
      expect(sendCall[0]).toContain("/send_message");
      expect(sendCall[1].method).toBe("POST");
    });

    it("sends JSON with Content-Type header", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await notifier.notify(makeEvent());

      const sendCall = getSendCall(fetchMock);
      expect(sendCall[1].headers["Content-Type"]).toBe("application/json");
    });

    it("includes agentId as sender in payload", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await notifier.notify(makeEvent());

      const body = JSON.parse(getSendCall(fetchMock)[1].body);
      expect(body.from).toBe("ao-1");
    });

    it("includes event type in subject", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await notifier.notify(makeEvent({ type: "ci.failing" }));

      const body = JSON.parse(getSendCall(fetchMock)[1].body);
      expect(body.subject).toContain("ci.failing");
    });

    it("includes event message in body", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await notifier.notify(makeEvent({ message: "CI failed on PR #42" }));

      const body = JSON.parse(getSendCall(fetchMock)[1].body);
      expect(body.body).toContain("CI failed on PR #42");
    });

    it("includes sessionId and projectId in body metadata", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await notifier.notify(makeEvent({ sessionId: "backend-3", projectId: "myproj" }));

      const body = JSON.parse(getSendCall(fetchMock)[1].body);
      expect(body.body).toContain("backend-3");
      expect(body.body).toContain("myproj");
    });

    it("includes prUrl in body when present in event data", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await notifier.notify(
        makeEvent({ data: { prUrl: "https://github.com/org/repo/pull/42" } }),
      );

      const body = JSON.parse(getSendCall(fetchMock)[1].body);
      expect(body.body).toContain("https://github.com/org/repo/pull/42");
    });

    it("throws on non-ok response from send_message", async () => {
      // First call (register_agent) succeeds, second (send_message) fails
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("") })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: () => Promise.resolve("server error"),
        });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await expect(notifier.notify(makeEvent())).rejects.toThrow("MCP mail send_message failed (500)");
    });
  });

  describe("notifyWithActions", () => {
    it("appends action links to message body", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      const actions: NotifyAction[] = [
        { label: "View PR", url: "https://github.com/org/repo/pull/42" },
        { label: "Kill Session", callbackEndpoint: "/api/sessions/app-1/kill" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const sendCall = fetchMock.mock.calls.find((call) =>
        (call[0] as string).includes("send_message"),
      )!;
      const body = JSON.parse(sendCall[1].body);
      expect(body.body).toContain("View PR");
      expect(body.body).toContain("https://github.com/org/repo/pull/42");
      expect(body.body).toContain("Kill Session");
    });

    it("does nothing when no endpoint configured", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create();
      await notifier.notifyWithActions!(makeEvent(), []);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("post", () => {
    function getSendCall(fetchMock: ReturnType<typeof mockFetchOk>) {
      return fetchMock.mock.calls.find((call) =>
        (call[0] as string).includes("send_message"),
      )!;
    }

    it("sends a free-form text message", async () => {
      const fetchMock = mockFetchOk({ messageId: "msg-abc" });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await notifier.post!("Hello from AO");

      const body = JSON.parse(getSendCall(fetchMock)[1].body);
      expect(body.body).toBe("Hello from AO");
    });

    it("uses context channel as recipient when provided", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await notifier.post!("ping", { channel: "orchestrator" });

      const body = JSON.parse(getSendCall(fetchMock)[1].body);
      expect(body.to).toBe("orchestrator");
    });

    it("returns null when no endpoint configured", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create();
      const result = await notifier.post!("test");
      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("register", () => {
    it("POSTs to register_agent on first notify call", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        endpoint: "http://localhost:3000",
        agentId: "ao-register-test",
        projectId: "proj-x",
      });
      await notifier.notify(makeEvent());

      const calls = fetchMock.mock.calls;
      const registerCall = calls.find((call) => (call[0] as string).includes("register_agent"));
      expect(registerCall).toBeDefined();
    });

    it("does not re-register on subsequent notify calls", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await notifier.notify(makeEvent());
      await notifier.notify(makeEvent());

      const registerCalls = fetchMock.mock.calls.filter((call) =>
        (call[0] as string).includes("register_agent"),
      );
      expect(registerCalls).toHaveLength(1);
    });

    it("includes agentId and projectId in registration payload", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        endpoint: "http://localhost:3000",
        agentId: "ao-session-abc",
        projectId: "proj-xyz",
      });
      await notifier.notify(makeEvent());

      const registerCall = fetchMock.mock.calls.find((call) =>
        (call[0] as string).includes("register_agent"),
      );
      const body = JSON.parse(registerCall![1].body);
      expect(body.agentId).toBe("ao-session-abc");
      expect(body.projectId).toBe("proj-xyz");
    });
  });
});
