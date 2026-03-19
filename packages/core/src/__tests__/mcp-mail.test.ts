import { describe, expect, it, beforeEach } from "vitest";
import {
  AgentMailBridge,
  formatGuidancePrompt,
} from "../mcp-mail.js";
import type { AgentMailConfig } from "../mcp-mail.js";

describe("AgentMailBridge", () => {
  let bridge: AgentMailBridge;
  const config: AgentMailConfig = {
    orchestratorId: "orch-1",
    enabled: true,
  };

  beforeEach(() => {
    bridge = new AgentMailBridge(config);
  });

  it("sendGuidance creates message with correct fields", () => {
    const msg = bridge.sendGuidance("session-1", "retry with backoff");
    expect(msg.from).toBe("orch-1");
    expect(msg.to).toBe("session-1");
    expect(msg.subject).toBe("Fix Strategy Guidance");
    expect(msg.priority).toBe("high");
    expect(msg.read).toBe(false);
  });

  it("sendGuidance assigns unique IDs", () => {
    const a = bridge.sendGuidance("session-1", "strategy A");
    const b = bridge.sendGuidance("session-1", "strategy B");
    expect(a.id).not.toBe(b.id);
  });

  it("sendStatusUpdate creates status message", () => {
    const msg = bridge.sendStatusUpdate("session-1", "running", "all good");
    expect(msg.from).toBe("session-1");
    expect(msg.to).toBe("orch-1");
    expect(msg.subject).toBe("Status: running");
    expect(msg.priority).toBe("normal");
    expect(msg.body).toBe("all good");
    expect(msg.read).toBe(false);
  });

  it("getInbox returns messages for agent", () => {
    bridge.sendGuidance("session-1", "do X");
    bridge.sendGuidance("session-1", "do Y");
    const inbox = bridge.getInbox("session-1");
    expect(inbox).toHaveLength(2);
  });

  it("getInbox returns empty array for unknown agent", () => {
    expect(bridge.getInbox("unknown")).toEqual([]);
  });

  it("markRead removes message from unread count", () => {
    const msg = bridge.sendGuidance("session-1", "fix it");
    expect(bridge.getUnreadCount("session-1")).toBe(1);
    bridge.markRead(msg.id);
    expect(bridge.getUnreadCount("session-1")).toBe(0);
  });

  it("getUnreadCount tracks correctly", () => {
    bridge.sendGuidance("session-1", "a");
    bridge.sendGuidance("session-1", "b");
    bridge.sendGuidance("session-1", "c");
    expect(bridge.getUnreadCount("session-1")).toBe(3);
    const inbox = bridge.getInbox("session-1");
    bridge.markRead(inbox[0].id);
    expect(bridge.getUnreadCount("session-1")).toBe(2);
  });

  it("formatGuidancePrompt includes strategy", () => {
    const prompt = formatGuidancePrompt("retry with backoff");
    expect(prompt).toContain("## Fix Strategy");
    expect(prompt).toContain("retry with backoff");
  });

  it("formatGuidancePrompt includes context when provided", () => {
    const prompt = formatGuidancePrompt("retry", "error log here");
    expect(prompt).toContain("## Context");
    expect(prompt).toContain("error log here");
  });

  it("formatGuidancePrompt omits context section when not provided", () => {
    const prompt = formatGuidancePrompt("retry");
    expect(prompt).not.toContain("## Context");
  });

  it("messages have correct timestamps", () => {
    const before = new Date().toISOString();
    const msg = bridge.sendGuidance("session-1", "test");
    const after = new Date().toISOString();
    expect(msg.timestamp >= before).toBe(true);
    expect(msg.timestamp <= after).toBe(true);
  });
});
