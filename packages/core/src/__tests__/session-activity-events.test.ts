import { describe, it, expect, vi } from "vitest";
import {
  emitSpawnStarted,
  emitSpawnFailed,
  emitSpawned,
  emitKilled,
} from "../session-activity-events.js";

vi.mock("../activity-events.js", () => ({
  recordActivityEvent: vi.fn(),
}));

import { recordActivityEvent } from "../activity-events.js";

describe("session-activity-events companion hooks", () => {
  it("emitSpawnStarted records session.spawn_started", () => {
    emitSpawnStarted("proj-1", "claude-code");
    expect(recordActivityEvent).toHaveBeenCalledWith({
      projectId: "proj-1",
      source: "session-manager",
      kind: "session.spawn_started",
      summary: "spawn started",
      data: { agent: "claude-code" },
    });
  });

  it("emitSpawnFailed records session.spawn_failed with error level", () => {
    emitSpawnFailed("proj-1", "disk full");
    expect(recordActivityEvent).toHaveBeenCalledWith({
      projectId: "proj-1",
      source: "session-manager",
      kind: "session.spawn_failed",
      level: "error",
      summary: "spawn failed",
      data: { reason: "disk full" },
    });
  });

  it("emitSpawned records session.spawned", () => {
    emitSpawned("proj-1", "sess-1", "claude-code", "feat/branch");
    expect(recordActivityEvent).toHaveBeenCalledWith({
      projectId: "proj-1",
      sessionId: "sess-1",
      source: "session-manager",
      kind: "session.spawned",
      summary: "spawned: sess-1",
      data: { agent: "claude-code", branch: "feat/branch" },
    });
  });

  it("emitKilled records session.killed", () => {
    emitKilled("proj-1", "sess-1", "manually_killed");
    expect(recordActivityEvent).toHaveBeenCalledWith({
      projectId: "proj-1",
      sessionId: "sess-1",
      source: "session-manager",
      kind: "session.killed",
      summary: "killed: sess-1",
      data: { reason: "manually_killed" },
    });
  });
});
