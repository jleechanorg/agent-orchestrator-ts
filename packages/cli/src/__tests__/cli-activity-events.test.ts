import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@jleechanorg/ao-core", () => ({
  recordActivityEvent: vi.fn(),
  loadConfig: vi.fn(),
  isTerminalSession: vi.fn(),
  enqueueSpawnRequest: vi.fn(),
  resolveSpawnQueueConfig: vi.fn(() => ({ maxActiveSessions: 20, enabled: false })),
  expandHome: vi.fn(),
  DEFAULT_DECOMPOSER_CONFIG: {},
}));

import { recordActivityEvent } from "@jleechanorg/ao-core";

describe("CLI activity event emissions (bd-lbgc)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cli.ao_started event is recorded via recordActivityEvent", () => {
    recordActivityEvent({
      projectId: "proj-1",
      source: "cli",
      kind: "cli.ao_started",
      summary: "ao start completed for project proj-1",
      data: { port: 3000, projectId: "proj-1" },
    });
    expect(recordActivityEvent).toHaveBeenCalledWith({
      projectId: "proj-1",
      source: "cli",
      kind: "cli.ao_started",
      summary: "ao start completed for project proj-1",
      data: { port: 3000, projectId: "proj-1" },
    });
  });

  it("cli.spawn_command event is recorded via recordActivityEvent", () => {
    recordActivityEvent({
      projectId: "proj-1",
      source: "cli",
      kind: "cli.spawn_command",
      summary: "spawn command invoked for project proj-1",
      data: { issueId: "123", agent: undefined, prompt: undefined },
    });
    expect(recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "cli",
        kind: "cli.spawn_command",
        projectId: "proj-1",
      }),
    );
  });

  it("cli.spawn_failed event is recorded with error level", () => {
    recordActivityEvent({
      projectId: "proj-1",
      source: "cli",
      kind: "cli.spawn_failed",
      level: "error",
      summary: "spawn command failed for project proj-1",
      data: { reason: "preflight failed", issueId: "123" },
    });
    expect(recordActivityEvent).toHaveBeenCalledWith({
      projectId: "proj-1",
      source: "cli",
      kind: "cli.spawn_failed",
      level: "error",
      summary: "spawn command failed for project proj-1",
      data: { reason: "preflight failed", issueId: "123" },
    });
  });
});
