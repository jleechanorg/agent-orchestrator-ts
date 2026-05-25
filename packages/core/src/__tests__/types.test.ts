import { describe, expect, it } from "vitest";
import { isOrchestratorSession, isTerminalSession, type SessionStatus, type ActivityState } from "../types.js";

describe("isOrchestratorSession", () => {
  it("detects orchestrators by explicit role metadata", () => {
    expect(
      isOrchestratorSession({
        id: "app-control",
        metadata: { role: "orchestrator" },
      }),
    ).toBe(true);
  });

  it("falls back to orchestrator naming for legacy sessions", () => {
    expect(isOrchestratorSession({ id: "app-orchestrator", metadata: {} })).toBe(true);
  });

  it("does not classify worker sessions as orchestrators", () => {
    expect(isOrchestratorSession({ id: "app-7", metadata: { role: "worker" } })).toBe(false);
  });
});

describe("isTerminalSession", () => {
  const terminalStatuses: SessionStatus[] = ["killed", "terminated", "done", "cleanup", "errored", "merged"];

  it.each(terminalStatuses)("returns true for terminal status: %s", (status) => {
    expect(isTerminalSession({ status, activity: null })).toBe(true);
  });

  it.each(terminalStatuses)("returns true for terminal status even with non-terminal activity", (status) => {
    expect(isTerminalSession({ status, activity: "active" as ActivityState })).toBe(true);
  });

  const activeStatuses: SessionStatus[] = ["spawning", "working", "pr_open", "ci_failed", "review_pending", "changes_requested", "approved", "mergeable", "merge_conflicts", "needs_input", "stuck", "idle"];

  it.each(activeStatuses)("returns false for active status with null activity: %s", (status) => {
    expect(isTerminalSession({ status, activity: null })).toBe(false);
  });

  it.each(activeStatuses)("returns false for active status with active activity: %s", (status) => {
    expect(isTerminalSession({ status, activity: "active" as ActivityState })).toBe(false);
  });

  it("returns true when activity is exited even with non-terminal status", () => {
    expect(isTerminalSession({ status: "idle", activity: "exited" as ActivityState })).toBe(true);
  });

  it("returns false when activity is non-terminal and status is non-terminal", () => {
    expect(isTerminalSession({ status: "working", activity: "ready" as ActivityState })).toBe(false);
  });

  it("returns true when both status and activity are terminal", () => {
    expect(isTerminalSession({ status: "done", activity: "exited" as ActivityState })).toBe(true);
  });

  it("prioritizes terminal status over non-terminal activity", () => {
    expect(isTerminalSession({ status: "killed", activity: "active" as ActivityState })).toBe(true);
  });
});
