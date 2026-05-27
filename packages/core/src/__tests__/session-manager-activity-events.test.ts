import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../activity-events.js", () => ({
  recordActivityEvent: vi.fn(),
}));

import { recordActivityEvent } from "../activity-events.js";
import { emitActivityTransition } from "../lifecycle-activity-events.js";
import { emitKilled } from "../session-activity-events.js";

describe("session-manager activity event integration (bd-lbgc)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emitKilled records session.killed with runtime-dead-in-refresh reason", () => {
    emitKilled("proj-1", "sess-1", "runtime-dead-in-refresh");
    expect(recordActivityEvent).toHaveBeenCalledWith({
      projectId: "proj-1",
      sessionId: "sess-1",
      source: "session-manager",
      kind: "session.killed",
      summary: "killed: sess-1",
      data: { reason: "runtime-dead-in-refresh" },
    });
  });

  it("emitActivityTransition records transition from active to exited", () => {
    emitActivityTransition("proj-1", "sess-1", "active", "exited");
    expect(recordActivityEvent).toHaveBeenCalledWith({
      projectId: "proj-1",
      sessionId: "sess-1",
      source: "lifecycle",
      kind: "activity.transition",
      level: "info",
      summary: "active → exited",
      data: { from: "active", to: "exited" },
    });
  });

  it("emitActivityTransition records transition from idle to active", () => {
    emitActivityTransition("proj-1", "sess-1", "idle", "active");
    expect(recordActivityEvent).toHaveBeenCalledWith({
      projectId: "proj-1",
      sessionId: "sess-1",
      source: "lifecycle",
      kind: "activity.transition",
      level: "info",
      summary: "idle → active",
      data: { from: "idle", to: "active" },
    });
  });

  it("emitActivityTransition records transition from active to ready", () => {
    emitActivityTransition("proj-1", "sess-1", "active", "ready");
    expect(recordActivityEvent).toHaveBeenCalledWith({
      projectId: "proj-1",
      sessionId: "sess-1",
      source: "lifecycle",
      kind: "activity.transition",
      level: "info",
      summary: "active → ready",
      data: { from: "active", to: "ready" },
    });
  });
});
