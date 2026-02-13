import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createEventBus, createEvent } from "../event-bus.js";
import type { OrchestratorEvent } from "../types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-test-eventbus-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("createEvent", () => {
  it("creates event with all fields", () => {
    const event = createEvent("session.spawned", {
      sessionId: "app-1",
      projectId: "my-app",
      message: "Session spawned",
      data: { branch: "main" },
    });

    expect(event.id).toBeTruthy();
    expect(event.type).toBe("session.spawned");
    expect(event.sessionId).toBe("app-1");
    expect(event.projectId).toBe("my-app");
    expect(event.message).toBe("Session spawned");
    expect(event.data).toEqual({ branch: "main" });
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  it("infers priority from event type", () => {
    expect(
      createEvent("session.stuck", { sessionId: "a", projectId: "p", message: "" }).priority,
    ).toBe("urgent");
    expect(
      createEvent("session.needs_input", { sessionId: "a", projectId: "p", message: "" }).priority,
    ).toBe("urgent");
    expect(
      createEvent("session.errored", { sessionId: "a", projectId: "p", message: "" }).priority,
    ).toBe("urgent");
    expect(
      createEvent("review.approved", { sessionId: "a", projectId: "p", message: "" }).priority,
    ).toBe("action");
    expect(
      createEvent("merge.ready", { sessionId: "a", projectId: "p", message: "" }).priority,
    ).toBe("action");
    expect(
      createEvent("merge.completed", { sessionId: "a", projectId: "p", message: "" }).priority,
    ).toBe("action");
    expect(
      createEvent("ci.failing", { sessionId: "a", projectId: "p", message: "" }).priority,
    ).toBe("warning");
    expect(
      createEvent("review.changes_requested", { sessionId: "a", projectId: "p", message: "" })
        .priority,
    ).toBe("warning");
    expect(
      createEvent("session.spawned", { sessionId: "a", projectId: "p", message: "" }).priority,
    ).toBe("info");
    expect(
      createEvent("pr.created", { sessionId: "a", projectId: "p", message: "" }).priority,
    ).toBe("info");
  });

  it("allows explicit priority override", () => {
    const event = createEvent("session.spawned", {
      sessionId: "a",
      projectId: "p",
      message: "",
      priority: "urgent",
    });
    expect(event.priority).toBe("urgent");
  });

  it("generates unique IDs", () => {
    const e1 = createEvent("session.spawned", { sessionId: "a", projectId: "p", message: "" });
    const e2 = createEvent("session.spawned", { sessionId: "a", projectId: "p", message: "" });
    expect(e1.id).not.toBe(e2.id);
  });
});

describe("createEventBus (no persistence)", () => {
  it("emits events to typed handlers", () => {
    const bus = createEventBus(null);
    const received: OrchestratorEvent[] = [];

    bus.on("session.spawned", (e) => received.push(e));

    const event = createEvent("session.spawned", {
      sessionId: "app-1",
      projectId: "p",
      message: "spawned",
    });
    bus.emit(event);

    expect(received).toHaveLength(1);
    expect(received[0].sessionId).toBe("app-1");
  });

  it("emits events to wildcard handlers", () => {
    const bus = createEventBus(null);
    const received: OrchestratorEvent[] = [];

    bus.on("*", (e) => received.push(e));

    bus.emit(createEvent("session.spawned", { sessionId: "a", projectId: "p", message: "" }));
    bus.emit(createEvent("ci.failing", { sessionId: "b", projectId: "p", message: "" }));

    expect(received).toHaveLength(2);
  });

  it("does not deliver events to wrong type", () => {
    const bus = createEventBus(null);
    const received: OrchestratorEvent[] = [];

    bus.on("ci.failing", (e) => received.push(e));

    bus.emit(createEvent("session.spawned", { sessionId: "a", projectId: "p", message: "" }));

    expect(received).toHaveLength(0);
  });

  it("unsubscribes handlers with off()", () => {
    const bus = createEventBus(null);
    const received: OrchestratorEvent[] = [];
    const handler = (e: OrchestratorEvent) => received.push(e);

    bus.on("session.spawned", handler);
    bus.emit(createEvent("session.spawned", { sessionId: "a", projectId: "p", message: "" }));
    expect(received).toHaveLength(1);

    bus.off("session.spawned", handler);
    bus.emit(createEvent("session.spawned", { sessionId: "b", projectId: "p", message: "" }));
    expect(received).toHaveLength(1); // still 1, not 2
  });

  it("survives handler errors without breaking", () => {
    const bus = createEventBus(null);
    const received: OrchestratorEvent[] = [];

    bus.on("session.spawned", () => {
      throw new Error("boom");
    });
    bus.on("session.spawned", (e) => received.push(e));

    bus.emit(createEvent("session.spawned", { sessionId: "a", projectId: "p", message: "" }));

    expect(received).toHaveLength(1);
  });

  it("supports multiple handlers on same event", () => {
    const bus = createEventBus(null);
    let count = 0;

    bus.on("session.spawned", () => count++);
    bus.on("session.spawned", () => count++);

    bus.emit(createEvent("session.spawned", { sessionId: "a", projectId: "p", message: "" }));
    expect(count).toBe(2);
  });
});

describe("getHistory", () => {
  it("returns all events when no filter", () => {
    const bus = createEventBus(null);

    bus.emit(createEvent("session.spawned", { sessionId: "a", projectId: "p1", message: "" }));
    bus.emit(createEvent("ci.failing", { sessionId: "b", projectId: "p2", message: "" }));

    const history = bus.getHistory();
    expect(history).toHaveLength(2);
  });

  it("filters by sessionId", () => {
    const bus = createEventBus(null);

    bus.emit(createEvent("session.spawned", { sessionId: "a", projectId: "p", message: "" }));
    bus.emit(createEvent("session.spawned", { sessionId: "b", projectId: "p", message: "" }));

    expect(bus.getHistory({ sessionId: "a" })).toHaveLength(1);
  });

  it("filters by projectId", () => {
    const bus = createEventBus(null);

    bus.emit(createEvent("session.spawned", { sessionId: "a", projectId: "p1", message: "" }));
    bus.emit(createEvent("session.spawned", { sessionId: "b", projectId: "p2", message: "" }));

    expect(bus.getHistory({ projectId: "p1" })).toHaveLength(1);
  });

  it("filters by type", () => {
    const bus = createEventBus(null);

    bus.emit(createEvent("session.spawned", { sessionId: "a", projectId: "p", message: "" }));
    bus.emit(createEvent("ci.failing", { sessionId: "b", projectId: "p", message: "" }));

    expect(bus.getHistory({ type: "ci.failing" })).toHaveLength(1);
  });

  it("filters by priority", () => {
    const bus = createEventBus(null);

    bus.emit(createEvent("session.spawned", { sessionId: "a", projectId: "p", message: "" }));
    bus.emit(createEvent("session.stuck", { sessionId: "b", projectId: "p", message: "" }));

    expect(bus.getHistory({ priority: "urgent" })).toHaveLength(1);
  });

  it("filters by since", () => {
    const bus = createEventBus(null);
    const beforeTime = new Date(Date.now() - 1000);

    bus.emit(createEvent("session.spawned", { sessionId: "a", projectId: "p", message: "" }));

    const afterTime = new Date(Date.now() + 1000);
    expect(bus.getHistory({ since: beforeTime })).toHaveLength(1);
    expect(bus.getHistory({ since: afterTime })).toHaveLength(0);
  });

  it("applies limit (takes last N)", () => {
    const bus = createEventBus(null);

    for (let i = 0; i < 10; i++) {
      bus.emit(
        createEvent("session.spawned", {
          sessionId: `s-${i}`,
          projectId: "p",
          message: `msg-${i}`,
        }),
      );
    }

    const result = bus.getHistory({ limit: 3 });
    expect(result).toHaveLength(3);
    expect(result[0].sessionId).toBe("s-7");
    expect(result[2].sessionId).toBe("s-9");
  });

  it("combines multiple filters", () => {
    const bus = createEventBus(null);

    bus.emit(createEvent("session.spawned", { sessionId: "a", projectId: "p1", message: "" }));
    bus.emit(createEvent("session.spawned", { sessionId: "b", projectId: "p1", message: "" }));
    bus.emit(createEvent("ci.failing", { sessionId: "a", projectId: "p1", message: "" }));
    bus.emit(createEvent("session.spawned", { sessionId: "a", projectId: "p2", message: "" }));

    expect(bus.getHistory({ sessionId: "a", projectId: "p1" })).toHaveLength(2);
    expect(bus.getHistory({ sessionId: "a", type: "session.spawned" })).toHaveLength(2);
    expect(
      bus.getHistory({ sessionId: "a", projectId: "p1", type: "session.spawned" }),
    ).toHaveLength(1);
  });
});

describe("JSONL persistence", () => {
  it("persists events to JSONL file", () => {
    const logPath = join(tmpDir, "events.jsonl");
    const bus = createEventBus(logPath);

    bus.emit(createEvent("session.spawned", { sessionId: "a", projectId: "p", message: "hello" }));
    bus.emit(createEvent("ci.failing", { sessionId: "b", projectId: "p", message: "oops" }));

    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe("session.spawned");
    expect(parsed.sessionId).toBe("a");
    expect(parsed.timestamp).toBeTruthy();
  });

  it("loads history from existing JSONL file on creation", async () => {
    const logPath = join(tmpDir, "existing.jsonl");
    const event = createEvent("session.spawned", {
      sessionId: "old",
      projectId: "p",
      message: "old event",
    });
    const serialized = JSON.stringify({ ...event, timestamp: event.timestamp.toISOString() });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(logPath, serialized + "\n", "utf-8");

    const bus = createEventBus(logPath);
    const history = bus.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].sessionId).toBe("old");
    expect(history[0].timestamp).toBeInstanceOf(Date);
  });

  it("creates log directory if it does not exist", () => {
    const logPath = join(tmpDir, "subdir", "nested", "events.jsonl");
    const bus = createEventBus(logPath);

    bus.emit(createEvent("session.spawned", { sessionId: "a", projectId: "p", message: "" }));

    expect(existsSync(logPath)).toBe(true);
  });

  it("appends to existing log file", () => {
    const logPath = join(tmpDir, "append.jsonl");

    const bus1 = createEventBus(logPath);
    bus1.emit(createEvent("session.spawned", { sessionId: "a", projectId: "p", message: "" }));

    const bus2 = createEventBus(logPath);
    bus2.emit(createEvent("ci.failing", { sessionId: "b", projectId: "p", message: "" }));

    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    // bus2 should have loaded the first event + emitted the second
    expect(bus2.getHistory()).toHaveLength(2);
  });
});
