import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrchestratorEvent, NotifyAction } from "@jleechanorg/ao-core";
import { manifest, create } from "./index.js";

function makeMockFetch() { return vi.fn(); }

function mockOk2(mf: ReturnType<typeof makeMockFetch>) {
  // Each notify/post call triggers 2 fetch calls: register_agent then send_message.
  mf.mockResolvedValue({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("{}") });
  mf.mockResolvedValue({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("{}") });
}

function findCall(mf: ReturnType<typeof makeMockFetch>, toolName: string) {
  return mf.mock.calls.find((call) => {
    if (!call[1]) return false;
    const body = JSON.parse((call[1] as { body: string }).body) as { params?: { name?: string; arguments?: Record<string, unknown> } };
    return body.params?.name === toolName || body.params?.arguments?.name === toolName;
  });
}

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return { id: "evt-1", type: "session.spawned", priority: "info", sessionId: "app-1", projectId: "my-project", timestamp: new Date("2025-06-15T12:00:00Z"), message: "Session app-1 spawned successfully", data: {}, ...overrides };
}

describe("notifier-mcp-mail", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("mcp-mail");
      expect(manifest.slot).toBe("notifier");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("create", () => {
    it("returns a notifier with name mcp-mail", () => {
      const mf = makeMockFetch();
      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-session-1", _fetch: mf });
      expect(notifier.name).toBe("mcp-mail");
    });
    it("warns when no endpoint configured", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      create();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("No endpoint configured"));
    });
    it("warns when endpoint configured but no projectId", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      create({ endpoint: "http://127.0.0.1:8765/mcp" });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("No projectId configured"));
    });
    it("throws on invalid endpoint URL (non-http scheme)", () => {
      expect(() => create({ endpoint: "ftp://badscheme" })).toThrow("Invalid url");
    });
    it("throws on invalid endpoint URL (no scheme)", () => {
      expect(() => create({ endpoint: "not-a-url" })).toThrow("Invalid url");
    });
    it("accepts valid http endpoint without throwing", () => {
      expect(() => create({ endpoint: "http://localhost:3000" })).not.toThrow();
    });
  });

  describe("notify -- no endpoint", () => {
    it("does nothing when no endpoint configured", async () => {
      const mf = makeMockFetch();
      const notifier = create({ _fetch: mf });
      await notifier.notify(makeEvent());
      expect(mf).not.toHaveBeenCalled();
    });
  });

  describe("notify -- with endpoint", () => {
    it("POSTs to the /mcp endpoint with send_message method", async () => {
      const mf = makeMockFetch(); mockOk2(mf);
      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1", _fetch: mf });
      await notifier.notify(makeEvent());
      const sendCall = findCall(mf, "send_message");
      expect(sendCall).toBeDefined();
      expect(sendCall![0]).toContain("/mcp");
      expect(sendCall![1].method).toBe("POST");
    });
    it("does not double /mcp when endpoint already ends with /mcp/", async () => {
      const mf = makeMockFetch(); mockOk2(mf);
      const notifier = create({ endpoint: "http://localhost:8765/mcp/", agentId: "ao-1", _fetch: mf });
      await notifier.notify(makeEvent());
      const sendCall = findCall(mf, "send_message");
      expect(sendCall![0]).toBe("http://localhost:8765/mcp");
    });
    it("sends JSON-RPC 2.0 envelope with Content-Type header", async () => {
      const mf = makeMockFetch(); mockOk2(mf);
      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1", _fetch: mf });
      await notifier.notify(makeEvent());
      const sendCall = findCall(mf, "send_message");
      expect(sendCall![1].headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(sendCall![1].body as string);
      expect(body.jsonrpc).toBe("2.0");
    });
    it("includes agentId as sender_name in params", async () => {
      const mf = makeMockFetch(); mockOk2(mf);
      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1", _fetch: mf });
      await notifier.notify(makeEvent());
      const body = JSON.parse(findCall(mf, "send_message")![1].body as string);
      expect(body.params.arguments.sender_name).toBe("ao-1");
    });
    it("uses projectId as project_key in params", async () => {
      const mf = makeMockFetch(); mockOk2(mf);
      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1", projectId: "proj-abc", _fetch: mf });
      await notifier.notify(makeEvent());
      const body = JSON.parse(findCall(mf, "send_message")![1].body as string);
      expect(body.params.arguments.project_key).toBe("proj-abc");
    });
    it("sends body_md built from buildMessageBody", async () => {
      const mf = makeMockFetch(); mockOk2(mf);
      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1", _fetch: mf });
      await notifier.notify(makeEvent({ message: "CI failed on PR #42" }));
      const body = JSON.parse(findCall(mf, "send_message")![1].body as string);
      expect(body.params.arguments.body_md).toContain("CI failed on PR #42");
    });
    it("sends to as a string array", async () => {
      const mf = makeMockFetch(); mockOk2(mf);
      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1", to: ["orchestrator"], _fetch: mf });
      await notifier.notify(makeEvent());
      const body = JSON.parse(findCall(mf, "send_message")![1].body as string);
      expect(Array.isArray(body.params.arguments.to)).toBe(true);
      expect(body.params.arguments.to).toContain("orchestrator");
    });
    it("includes event type in subject", async () => {
      const mf = makeMockFetch(); mockOk2(mf);
      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1", _fetch: mf });
      await notifier.notify(makeEvent({ type: "ci.failing" }));
      const body = JSON.parse(findCall(mf, "send_message")![1].body as string);
      expect(body.params.arguments.subject).toContain("ci.failing");
    });
    it("includes sessionId and projectId in body_md", async () => {
      const mf = makeMockFetch(); mockOk2(mf);
      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1", _fetch: mf });
      await notifier.notify(makeEvent({ sessionId: "backend-3", projectId: "myproj" }));
      const body = JSON.parse(findCall(mf, "send_message")![1].body as string);
      expect(body.params.arguments.body_md).toContain("backend-3");
      expect(body.params.arguments.body_md).toContain("myproj");
    });
    it("includes prUrl in body_md when present in event data", async () => {
      const mf = makeMockFetch(); mockOk2(mf);
      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1", _fetch: mf });
      await notifier.notify(makeEvent({ data: { prUrl: "https://github.com/org/repo/pull/42" } }));
      const body = JSON.parse(findCall(mf, "send_message")![1].body as string);
      expect(body.params.arguments.body_md).toContain("https://github.com/org/repo/pull/42");
    });
    it("throws on non-ok response from send_message", async () => {
      const mf = makeMockFetch();
      mf.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
      mf.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("server error") });
      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1", _fetch: mf });
      await expect(notifier.notify(makeEvent())).rejects.toThrow("MCP mail send_message failed (500)");
    });
    it("throws on JSON-RPC error response", async () => {
      const mf = makeMockFetch();
      mf.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
      mf.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ error: { message: "unknown tool" } }), text: () => Promise.resolve("") });
      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1", _fetch: mf });
      await expect(notifier.notify(makeEvent())).rejects.toThrow("MCP mail send_message error (?): unknown tool");
    });
    it("uses env var MCP_AGENT_MAIL_URL when no endpoint passed", async () => {
      const mf = makeMockFetch(); mockOk2(mf);
      vi.stubEnv("MCP_AGENT_MAIL_URL", "http://localhost:9999/mcp");
      const notifier = create({ projectId: "jleechanclaw", _fetch: mf });
      await notifier.notify(makeEvent());
      const firstCall = mf.mock.calls[0]! as unknown[];
      expect(firstCall[0]).toBe("http://localhost:9999/mcp");
    });
  });

  describe("notifyWithActions", () => {
    it("appends action links to body_md", async () => {
      const mf = makeMockFetch(); mockOk2(mf);
      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1", _fetch: mf });
      const actions: NotifyAction[] = [
        { label: "View PR", url: "https://github.com/org/repo/pull/42" },
        { label: "Kill Session", callbackEndpoint: "/api/sessions/app-1/kill" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);
      const body = JSON.parse(findCall(mf, "send_message")![1].body as string);
      expect(body.params.arguments.body_md).toContain("View PR");
      expect(body.params.arguments.body_md).toContain("https://github.com/org/repo/pull/42");
      expect(body.params.arguments.body_md).toContain("Kill Session");
    });
    it("does nothing when no endpoint configured", async () => {
      const mf = makeMockFetch();
      const notifier = create({ _fetch: mf });
      await notifier.notifyWithActions!(makeEvent(), []);
      expect(mf).not.toHaveBeenCalled();
    });
  });

  describe("post", () => {
    it("sends a free-form text message via body_md", async () => {
      const mf = makeMockFetch(); mockOk2(mf);
      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1", _fetch: mf });
      await notifier.post!("Hello from AO");
      const body = JSON.parse(findCall(mf, "send_message")![1].body as string);
      expect(body.params.arguments.body_md).toBe("Hello from AO");
    });
    it("uses context channel as to array when provided", async () => {
      const mf = makeMockFetch(); mockOk2(mf);
      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1", _fetch: mf });
      await notifier.post!("ping", { channel: "orchestrator" });
      const body = JSON.parse(findCall(mf, "send_message")![1].body as string);
      expect(body.params.arguments.to).toEqual(["orchestrator"]);
    });
    it("returns null when no endpoint configured", async () => {
      const mf = makeMockFetch();
      const notifier = create({ _fetch: mf });
      const result = await notifier.post!("test");
      expect(result).toBeNull();
      expect(mf).not.toHaveBeenCalled();
    });
  });

  describe("register", () => {
    it("POSTs register_agent via JSON-RPC on first notify call", async () => {
      const mf = makeMockFetch(); mockOk2(mf);
      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-register-test", projectId: "proj-x", _fetch: mf });
      await notifier.notify(makeEvent());
      expect(findCall(mf, "register_agent")).toBeDefined();
    });
    it("uses official register_agent params: project_key, program, model, agent_name", async () => {
      const mf = makeMockFetch(); mockOk2(mf);
      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-session-abc", projectId: "proj-xyz", _fetch: mf });
      await notifier.notify(makeEvent());
      const body = JSON.parse(findCall(mf, "register_agent")![1].body as string);
      expect(body.params.arguments.project_key).toBe("proj-xyz");
      expect(body.params.arguments.program).toBe("agent-orchestrator");
      expect(body.params.arguments.model).toBe("claude");
      expect(body.params.arguments.agent_name).toBe("ao-session-abc");
    });
    it("does not re-register on subsequent notify calls", async () => {
      const mf = makeMockFetch(); mockOk2(mf);
      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1", _fetch: mf });
      await notifier.notify(makeEvent());
      await notifier.notify(makeEvent());
      const registerCalls = mf.mock.calls.filter((call) => {
        if (!call[1]) return false;
        const body = JSON.parse((call[1] as { body: string }).body) as { params?: { name?: string } };
        return body.params?.name === "register_agent" || body.params?.arguments?.name === "register_agent";
      });
      expect(registerCalls).toHaveLength(1);
    });
    it("only registers once when concurrent notify calls race", async () => {
      const mf = makeMockFetch(); mockOk2(mf);
      const notifier = create({ endpoint: "http://localhost:3000", agentId: "ao-1", _fetch: mf });
      await Promise.all([notifier.notify(makeEvent()), notifier.notify(makeEvent()), notifier.notify(makeEvent())]);
      const registerCalls = mf.mock.calls.filter((call) => {
        if (!call[1]) return false;
        const body = JSON.parse((call[1] as { body: string }).body) as { params?: { name?: string } };
        return body.params?.name === "register_agent" || body.params?.arguments?.name === "register_agent";
      });
      expect(registerCalls).toHaveLength(1);
    });
  });
});
