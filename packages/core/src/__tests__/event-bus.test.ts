import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, createEvent } from "../event-bus.js";
import type { OrchestratorEvent } from "../types.js";

const SESSION_ID = "test-session-1" as const;
const PROJECT_ID = "test-project";

describe("createEvent", () => {
  it("creates an event with all required fields", () => {
    const event = createEvent("session.spawned", {
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      message: "Session started",
    });

    expect(event.id).toBeTruthy();
    expect(event.type).toBe("session.spawned");
    expect(event.priority).toBe("info");
    expect(event.sessionId).toBe(SESSION_ID);
    expect(event.projectId).toBe(PROJECT_ID);
    expect(event.message).toBe("Session started");
    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.data).toEqual({});
  });

  it("infers urgent priority for stuck events", () => {
    const event = createEvent("session.stuck", {
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      message: "Session stuck",
    });
    expect(event.priority).toBe("urgent");
  });

  it("infers urgent priority for needs_input events", () => {
    const event = createEvent("session.needs_input", {
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      message: "Needs input",
    });
    expect(event.priority).toBe("urgent");
  });

  it("infers action priority for merged events", () => {
    const event = createEvent("pr.merged", {
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      message: "PR merged",
    });
    expect(event.priority).toBe("action");
  });

  it("infers warning priority for failing events", () => {
    const event = createEvent("ci.failing", {
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      message: "CI failing",
    });
    expect(event.priority).toBe("warning");
  });

  it("accepts custom priority override", () => {
    const event = createEvent("session.spawned", {
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      message: "Session started",
      priority: "action",
    });
    expect(event.priority).toBe("action");
  });

  it("accepts custom data", () => {
    const event = createEvent("session.spawned", {
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      message: "Session started",
      data: { foo: "bar" },
    });
    expect(event.data).toEqual({ foo: "bar" });
  });
});

describe("createEventBus (in-memory)", () => {
  let bus: ReturnType<typeof createEventBus>;

  beforeEach(() => {
    bus = createEventBus(null);
  });

  it("emits events to type-specific handlers", () => {
    const received: OrchestratorEvent[] = [];
    bus.on("session.spawned", (e) => received.push(e));

    const event = createEvent("session.spawned", {
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      message: "test",
    });
    bus.emit(event);

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe(event.id);
  });

  it("emits to wildcard handlers for any event type", () => {
    const received: OrchestratorEvent[] = [];
    bus.on("*", (e) => received.push(e));

    bus.emit(createEvent("session.spawned", { sessionId: SESSION_ID, projectId: PROJECT_ID, message: "a" }));
    bus.emit(createEvent("pr.merged", { sessionId: SESSION_ID, projectId: PROJECT_ID, message: "b" }));

    expect(received).toHaveLength(2);
  });

  it("emits to both type-specific and wildcard handlers", () => {
    const typeHandler: OrchestratorEvent[] = [];
    const wildcardHandler: OrchestratorEvent[] = [];
    bus.on("session.spawned", (e) => typeHandler.push(e));
    bus.on("*", (e) => wildcardHandler.push(e));

    bus.emit(createEvent("session.spawned", { sessionId: SESSION_ID, projectId: PROJECT_ID, message: "test" }));

    expect(typeHandler).toHaveLength(1);
    expect(wildcardHandler).toHaveLength(1);
  });

  it("off removes the handler", () => {
    const received: OrchestratorEvent[] = [];
    const handler = (e: OrchestratorEvent) => received.push(e);
    bus.on("session.spawned", handler);
    bus.off("session.spawned", handler);

    bus.emit(createEvent("session.spawned", { sessionId: SESSION_ID, projectId: PROJECT_ID, message: "test" }));
    expect(received).toHaveLength(0);
  });

  it("handler errors do not break the bus", () => {
    bus.on("session.spawned", () => {
      throw new Error("handler error");
    });

    expect(() => {
      bus.emit(createEvent("session.spawned", { sessionId: SESSION_ID, projectId: PROJECT_ID, message: "test" }));
    }).not.toThrow();
  });

  it("getHistory returns all emitted events when no filter", () => {
    bus.emit(createEvent("session.spawned", { sessionId: SESSION_ID, projectId: PROJECT_ID, message: "a" }));
    bus.emit(createEvent("pr.merged", { sessionId: SESSION_ID, projectId: PROJECT_ID, message: "b" }));

    const history = bus.getHistory();
    expect(history).toHaveLength(2);
  });

  it("getHistory filters by sessionId", () => {
    bus.emit(createEvent("session.spawned", { sessionId: "s1", projectId: PROJECT_ID, message: "a" }));
    bus.emit(createEvent("session.spawned", { sessionId: "s2", projectId: PROJECT_ID, message: "b" }));

    const history = bus.getHistory({ sessionId: "s1" as any });
    expect(history).toHaveLength(1);
    expect(history[0].sessionId).toBe("s1");
  });

  it("getHistory filters by type", () => {
    bus.emit(createEvent("session.spawned", { sessionId: SESSION_ID, projectId: PROJECT_ID, message: "a" }));
    bus.emit(createEvent("pr.merged", { sessionId: SESSION_ID, projectId: PROJECT_ID, message: "b" }));

    const history = bus.getHistory({ type: "session.spawned" as any });
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe("session.spawned");
  });

  it("getHistory filters by priority", () => {
    bus.emit(createEvent("session.spawned", { sessionId: SESSION_ID, projectId: PROJECT_ID, message: "a" }));
    bus.emit(createEvent("session.stuck", { sessionId: SESSION_ID, projectId: PROJECT_ID, message: "b" }));

    const history = bus.getHistory({ priority: "urgent" as any });
    expect(history).toHaveLength(1);
    expect(history[0].priority).toBe("urgent");
  });

  it("getHistory filters by since", () => {
    const before = new Date(Date.now() - 10_000);
    const event1 = createEvent("session.spawned", { sessionId: SESSION_ID, projectId: PROJECT_ID, message: "a" });
    event1.timestamp = new Date(Date.now() - 20_000);
    const event2 = createEvent("session.spawned", { sessionId: SESSION_ID, projectId: PROJECT_ID, message: "b" });
    event2.timestamp = new Date();

    bus.emit(event1);
    bus.emit(event2);

    const history = bus.getHistory({ since: before });
    expect(history).toHaveLength(1);
    expect(history[0].message).toBe("b");
  });

  it("getHistory respects limit", () => {
    for (let i = 0; i < 5; i++) {
      bus.emit(createEvent("session.spawned", { sessionId: SESSION_ID, projectId: PROJECT_ID, message: String(i) }));
    }

    const history = bus.getHistory({ limit: 3 });
    expect(history).toHaveLength(3);
  });

  it("getHistory filters by projectId", () => {
    bus.emit(createEvent("session.spawned", { sessionId: SESSION_ID, projectId: "proj-a", message: "a" }));
    bus.emit(createEvent("session.spawned", { sessionId: SESSION_ID, projectId: "proj-b", message: "b" }));

    const history = bus.getHistory({ projectId: "proj-a" });
    expect(history).toHaveLength(1);
    expect(history[0].projectId).toBe("proj-a");
  });
});

describe("createEventBus (JSONL persistence)", () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "event-bus-test-"));
    logPath = join(tmpDir, "events.jsonl");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists events to JSONL file", () => {
    const bus = createEventBus(logPath);

    bus.emit(createEvent("session.spawned", { sessionId: SESSION_ID, projectId: PROJECT_ID, message: "test" }));
    bus.emit(createEvent("pr.merged", { sessionId: SESSION_ID, projectId: PROJECT_ID, message: "merged" }));

    const content = readFileSync(logPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe("session.spawned");
    expect(parsed.id).toBeTruthy();
    expect(parsed.timestamp).toBeTruthy();
  });

  it("loads existing events from JSONL on startup", () => {
    // Pre-populate the log file
    const event1 = createEvent("session.spawned", { sessionId: SESSION_ID, projectId: PROJECT_ID, message: "pre-existing" });
    const event2 = createEvent("pr.merged", { sessionId: SESSION_ID, projectId: PROJECT_ID, message: "also pre-existing" });

    writeFileSync(
      logPath,
      JSON.stringify({ ...event1, timestamp: event1.timestamp.toISOString() }) + "\n" +
      JSON.stringify({ ...event2, timestamp: event2.timestamp.toISOString() }) + "\n"
    );

    const bus = createEventBus(logPath);
    const history = bus.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].type).toBe("session.spawned");
    expect(history[1].type).toBe("pr.merged");
  });

  it("creates log directory if it does not exist", () => {
    const nestedPath = join(tmpDir, "subdir", "nested", "events.jsonl");
    const bus = createEventBus(nestedPath);
    bus.emit(createEvent("session.spawned", { sessionId: SESSION_ID, projectId: PROJECT_ID, message: "test" }));

    const content = readFileSync(nestedPath, "utf-8");
    expect(content).toContain("session.spawned");
  });
});
