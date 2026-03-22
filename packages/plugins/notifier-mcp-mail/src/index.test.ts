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

function mockFetchOk(responseBody: unknown = {}) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(responseBody),
    text: () => Promise.resolve(JSON.stringify(responseBody)),
  });
}

/** Find the call whose JSON-RPC method matches. */
function findRpcCall(
  fetchMock: ReturnType<typeof mockFetchOk>,
  method: string,
) {
  return fetchMock.mock.calls.find((call) => {
    const body = JSON.parse((call[1] as { body: string }).body) as {
      method: string;
    };
    return body.method === method;
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
      expect(warnSpy).not.toHaveBeenCalled();
      expect(notifier.name).toBe("mcp-mail");
    });

    it("throws on invalid endpoint URL (non-http scheme)", () => {
      expect(() => create({ endpoint: "ftp://badscheme" })).toThrow(
        "Invalid url",
      );
    });

    it("throws on invalid endpoint URL (no scheme)", () => {
      expect(() => create({ endpoint: "not-a-url" })).toThrow(
        "Invalid url",
      );
    });

    it("accepts valid http endpoint without throwing", () => {
      expect(() => create({ endpoint: "http://localhost:3000" })).not.toThrow();
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
    it("POSTs to the /mcp endpoint with send_message method", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await notifier.notify(makeEvent());

      const sendCall = findRpcCall(fetchMock, "send_message");
      expect(sendCall).toBeDefined();
      expect(sendCall![0]).toContain("/mcp");
      expect(sendCall![1].method).toBe("POST");
    });

    it("sends JSON-RPC 2.0 envelope with Content-Type header", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await notifier.notify(makeEvent());

      const sendCall = findRpcCall(fetchMock, "send_message");
      expect(sendCall![1].headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(sendCall![1].body);
      expect(body.jsonrpc).toBe("2.0");
    });

    it("includes agentId as sender_name in params", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await notifier.notify(makeEvent());

      const body = JSON.parse(findRpcCall(fetchMock, "send_message")![1].body);
      expect(body.params.sender_name).toBe("ao-1");
    });

    it("uses projectId as project_key in params", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        endpoint: "http://localhost:3000",
        agentId: "ao-1",
        projectId: "proj-abc",
      });
      await notifier.notify(makeEvent());

      const body = JSON.parse(findRpcCall(fetchMock, "send_message")![1].body);
      expect(body.params.project_key).toBe("proj-abc");
    });

    it("sends body_md not body in params", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await notifier.notify(makeEvent({ message: "CI failed on PR #42" }));

      const body = JSON.parse(findRpcCall(fetchMock, "send_message")![1].body);
      expect(body.params.body_md).toContain("CI failed on PR #42");
    });

    it("sends to as a string array", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        endpoint: "http://localhost:3000",
        agentId: "ao-1",
        to: ["orchestrator"],
      });
      await notifier.notify(makeEvent());

      const body = JSON.parse(findRpcCall(fetchMock, "send_message")![1].body);
      expect(Array.isArray(body.params.to)).toBe(true);
      expect(body.params.to).toContain("orchestrator");
    });

    it("includes event type in subject", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await notifier.notify(makeEvent({ type: "ci.failing" }));

      const body = JSON.parse(findRpcCall(fetchMock, "send_message")![1].body);
      expect(body.params.subject).toContain("ci.failing");
    });

    it("includes sessionId and projectId in body_md metadata", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await notifier.notify(makeEvent({ sessionId: "backend-3", projectId: "myproj" }));

      const body = JSON.parse(findRpcCall(fetchMock, "send_message")![1].body);
      expect(body.params.body_md).toContain("backend-3");
      expect(body.params.body_md).toContain("myproj");
    });

    it("includes prUrl in body_md when present in event data", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await notifier.notify(
        makeEvent({ data: { prUrl: "https://github.com/org/repo/pull/42" } }),
      );

      const body = JSON.parse(findRpcCall(fetchMock, "send_message")![1].body);
      expect(body.params.body_md).toContain("https://github.com/org/repo/pull/42");
    });

    it("throws on non-ok response from send_message", async () => {
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

    it("throws on JSON-RPC error response", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("") })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ error: { message: "unknown tool" } }),
          text: () => Promise.resolve(""),
        });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await expect(notifier.notify(makeEvent())).rejects.toThrow("JSON-RPC error: unknown tool");
    });
  });

  describe("notifyWithActions", () => {
    it("appends action links to body_md", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      const actions: NotifyAction[] = [
        { label: "View PR", url: "https://github.com/org/repo/pull/42" },
        { label: "Kill Session", callbackEndpoint: "/api/sessions/app-1/kill" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const sendCall = findRpcCall(fetchMock, "send_message");
      const body = JSON.parse(sendCall![1].body);
      expect(body.params.body_md).toContain("View PR");
      expect(body.params.body_md).toContain("https://github.com/org/repo/pull/42");
      expect(body.params.body_md).toContain("Kill Session");
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
    it("sends a free-form text message via body_md", async () => {
      const fetchMock = mockFetchOk({ messageId: "msg-abc" });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await notifier.post!("Hello from AO");

      const body = JSON.parse(findRpcCall(fetchMock, "send_message")![1].body);
      expect(body.params.body_md).toBe("Hello from AO");
    });

    it("uses context channel as to array when provided", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await notifier.post!("ping", { channel: "orchestrator" });

      const body = JSON.parse(findRpcCall(fetchMock, "send_message")![1].body);
      expect(body.params.to).toEqual(["orchestrator"]);
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
    it("POSTs register_agent via JSON-RPC on first notify call", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        endpoint: "http://localhost:3000",
        agentId: "ao-register-test",
        projectId: "proj-x",
      });
      await notifier.notify(makeEvent());

      const registerCall = findRpcCall(fetchMock, "register_agent");
      expect(registerCall).toBeDefined();
    });

    it("uses official register_agent params: project_key, program, model, name", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        endpoint: "http://localhost:3000",
        agentId: "ao-session-abc",
        projectId: "proj-xyz",
      });
      await notifier.notify(makeEvent());

      const registerCall = findRpcCall(fetchMock, "register_agent");
      const body = JSON.parse(registerCall![1].body);
      expect(body.params.project_key).toBe("proj-xyz");
      expect(body.params.program).toBe("agent-orchestrator");
      expect(body.params.model).toBe("claude");
      expect(body.params.name).toBe("ao-session-abc");
    });

    it("does not re-register on subsequent notify calls", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await notifier.notify(makeEvent());
      await notifier.notify(makeEvent());

      const registerCalls = fetchMock.mock.calls.filter((call) => {
        const body = JSON.parse((call[1] as { body: string }).body) as { method: string };
        return body.method === "register_agent";
      });
      expect(registerCalls).toHaveLength(1);
    });

    it("only registers once when concurrent notify calls race", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1" });
      await Promise.all([
        notifier.notify(makeEvent()),
        notifier.notify(makeEvent()),
        notifier.notify(makeEvent()),
      ]);

      const registerCalls = fetchMock.mock.calls.filter((call) => {
        const body = JSON.parse((call[1] as { body: string }).body) as { method: string };
        return body.method === "register_agent";
      });
      expect(registerCalls).toHaveLength(1);
    });
  });
});
