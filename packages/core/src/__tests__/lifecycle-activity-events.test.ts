import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  emitLifecycleTransition,
  emitActivityTransition,
} from "../lifecycle-activity-events.js";

vi.mock("../activity-events.js", () => ({
  recordActivityEvent: vi.fn(),
}));

import { recordActivityEvent } from "../activity-events.js";

describe("lifecycle-activity-events companion hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emitLifecycleTransition records lifecycle.transition", () => {
    emitLifecycleTransition("proj-1", "sess-1", "spawning", "working");
    expect(recordActivityEvent).toHaveBeenCalledOnce();
    expect(recordActivityEvent).toHaveBeenCalledWith({
      projectId: "proj-1",
      sessionId: "sess-1",
      source: "lifecycle",
      kind: "lifecycle.transition",
      level: "info",
      summary: "spawning → working",
      data: { from: "spawning", to: "working" },
    });
  });

  it("emitLifecycleTransition uses warn level for ci_failed", () => {
    emitLifecycleTransition("proj-1", "sess-1", "working", "ci_failed");
    expect(recordActivityEvent).toHaveBeenCalledOnce();
    expect(recordActivityEvent).toHaveBeenCalledWith({
      projectId: "proj-1",
      sessionId: "sess-1",
      source: "lifecycle",
      kind: "lifecycle.transition",
      level: "warn",
      summary: "working → ci_failed",
      data: { from: "working", to: "ci_failed" },
    });
  });

  it("emitLifecycleTransition records terminal promotion (killed → merged)", () => {
    emitLifecycleTransition("proj-1", "sess-1", "killed", "merged");
    expect(recordActivityEvent).toHaveBeenCalledOnce();
    expect(recordActivityEvent).toHaveBeenCalledWith({
      projectId: "proj-1",
      sessionId: "sess-1",
      source: "lifecycle",
      kind: "lifecycle.transition",
      level: "info",
      summary: "killed → merged",
      data: { from: "killed", to: "merged" },
    });
  });

  it("emitActivityTransition records activity.transition", () => {
    emitActivityTransition("proj-1", "sess-1", "active", "idle");
    expect(recordActivityEvent).toHaveBeenCalledOnce();
    expect(recordActivityEvent).toHaveBeenCalledWith({
      projectId: "proj-1",
      sessionId: "sess-1",
      source: "lifecycle",
      kind: "activity.transition",
      level: "info",
      summary: "active → idle",
      data: { from: "active", to: "idle" },
    });
  });
});
