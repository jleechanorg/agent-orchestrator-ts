import type {
  OrchestratorEvent,
  Session,
  NotifyAction,
  EventPriority,
  EventType,
  SessionStatus,
  ActivityState,
} from "@agent-orchestrator/core";

/**
 * Create a test OrchestratorEvent with sensible defaults.
 * Override any field as needed.
 */
export function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-test-1",
    type: "session.spawned" as EventType,
    priority: "info" as EventPriority,
    sessionId: "app-1",
    projectId: "my-project",
    timestamp: new Date("2025-06-15T12:00:00Z"),
    message: "Session app-1 spawned successfully",
    data: {},
    ...overrides,
  };
}

/**
 * Create a test Session with sensible defaults.
 * Override any field as needed.
 */
export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-project",
    status: "working" as SessionStatus,
    activity: "active" as ActivityState,
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/workspace",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date("2025-06-15T12:00:00Z"),
    lastActivityAt: new Date("2025-06-15T12:00:00Z"),
    metadata: {},
    ...overrides,
  };
}

/**
 * Create a set of test NotifyActions.
 */
export function makeActions(overrides?: Partial<NotifyAction>[]): NotifyAction[] {
  const defaults: NotifyAction[] = [
    { label: "View PR", url: "https://github.com/org/repo/pull/42" },
    { label: "Kill Session", callbackEndpoint: "/api/sessions/app-1/kill" },
  ];

  if (!overrides) return defaults;

  return overrides.map((o, i) => ({
    ...defaults[i % defaults.length],
    ...o,
  }));
}
