import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

vi.mock("../events-db.js", () => {
  const rows: unknown[] = [];
  const mockDb = {
    prepare: (sql: string) => ({
      run: (..._args: unknown[]) => {
        if (sql.includes("INSERT INTO activity_events")) {
          rows.push(_args);
        }
      },
      all: () => [],
    }),
  };
  return {
    getDb: vi.fn(() => mockDb),
    __rows: rows,
  };
});

import { recordActivityEvent, droppedEventCount } from "../activity-events.js";
import * as eventsDb from "../events-db.js";

describe("recordActivityEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inserts an event when DB is available", () => {
    recordActivityEvent({
      projectId: "proj-1",
      sessionId: "sess-1",
      source: "lifecycle",
      kind: "lifecycle.transition",
      summary: "working → pr_open",
      data: { from: "working", to: "pr_open" },
    });
    expect(eventsDb.getDb).toHaveBeenCalled();
  });

  it("increments droppedEventCount when DB returns null", () => {
    const before = droppedEventCount();
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(null);
    recordActivityEvent({
      source: "lifecycle",
      kind: "session.spawned",
      summary: "spawned: sess-x",
    });
    expect(droppedEventCount()).toBe(before + 1);
  });

  it("never throws even if prepare throws", () => {
    const badDb = {
      prepare: () => {
        throw new Error("disk full");
      },
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(badDb as any);
    expect(() =>
      recordActivityEvent({
        source: "session-manager",
        kind: "session.killed",
        summary: "killed: sess-1",
      }),
    ).not.toThrow();
  });

  it("never throws even if data sanitization throws", () => {
    const data = {};
    Object.defineProperty(data, "bad", {
      enumerable: true,
      get: () => {
        throw new Error("getter failed");
      },
    });

    expect(() =>
      recordActivityEvent({
        source: "session-manager",
        kind: "session.spawned",
        summary: "spawned",
        data,
      }),
    ).not.toThrow();
  });

  it("sanitizes sensitive data keys", () => {
    let capturedData: unknown;
    const captureDb = {
      prepare: (_sql: string) => ({
        run: (...args: unknown[]) => {
          capturedData = args[8];
        },
        all: () => [],
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(captureDb as any);
    recordActivityEvent({
      source: "lifecycle",
      kind: "session.spawned",
      summary: "spawned",
      data: { token: "secret123", agent: "claude-code" },
    });
    const parsed = JSON.parse(capturedData as string);
    expect(parsed["token"]).toBe("[redacted]");
    expect(parsed["agent"]).toBe("claude-code");
  });

  it("sanitizes nested sensitive data keys and credential URLs", () => {
    let capturedData: unknown;
    const captureDb = {
      prepare: (_sql: string) => ({
        run: (...args: unknown[]) => {
          capturedData = args[8];
        },
        all: () => [],
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(captureDb as any);
    recordActivityEvent({
      source: "lifecycle",
      kind: "session.spawned",
      summary: "spawned",
      data: {
        request: {
          headers: {
            authorization: "Bearer ghp_secret",
            url: "HTTPS://token@example.com/path",
          },
        },
      },
    });
    const parsed = JSON.parse(capturedData as string);
    expect(parsed["request"]["headers"]["authorization"]).toBe("[redacted]");
    expect(parsed["request"]["headers"]["url"]).toBe("https://[redacted]@example.com/path");
  });

  it("preserves error messages that mention sensitive words in values", () => {
    let capturedData: unknown;
    const captureDb = {
      prepare: (_sql: string) => ({
        run: (...args: unknown[]) => {
          capturedData = args[8];
        },
        all: () => [],
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(captureDb as any);
    recordActivityEvent({
      source: "session-manager",
      kind: "session.spawn_failed",
      summary: "spawn failed",
      data: {
        reason: "token expired",
        message: "authorization header missing",
        agent: "claude-code",
      },
    });
    const parsed = JSON.parse(capturedData as string);
    expect(parsed["reason"]).toBe("token expired");
    expect(parsed["message"]).toBe("authorization header missing");
    expect(parsed["agent"]).toBe("claude-code");
  });

  it("handles BigInt in data without throwing", () => {
    let capturedData: unknown;
    const captureDb = {
      prepare: (_sql: string) => ({
        run: (...args: unknown[]) => {
          capturedData = args[8];
        },
        all: () => [],
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(captureDb as any);
    expect(() =>
      recordActivityEvent({
        source: "lifecycle",
        kind: "session.spawned",
        summary: "spawned",
        data: { big: BigInt(9007199254740991) as any },
      }),
    ).not.toThrow();
    expect(typeof capturedData).toBe("string");
  });

  it("truncates summary to 500 chars", () => {
    let capturedSummary: unknown;
    const captureDb = {
      prepare: (_sql: string) => ({
        run: (...args: unknown[]) => {
          capturedSummary = args[7];
        },
        all: () => [],
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(captureDb as any);
    const longSummary = "x".repeat(600);
    recordActivityEvent({
      source: "lifecycle",
      kind: "lifecycle.transition",
      summary: longSummary,
    });
    expect((capturedSummary as string).length).toBe(500);
    expect(capturedSummary).toMatch(/\.\.\.$/);
  });

  it("redacts Bearer tokens in string values", () => {
    let capturedData: unknown;
    const captureDb = {
      prepare: (_sql: string) => ({
        run: (...args: unknown[]) => {
          capturedData = args[8];
        },
        all: () => [],
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(captureDb as any);
    recordActivityEvent({
      source: "api",
      kind: "api.webhook_failed",
      summary: "webhook failed",
      data: { errorMessage: `HTTP 401: Bearer ${"a".repeat(20)} is invalid` },
    });
    const parsed = JSON.parse(capturedData as string);
    expect(parsed["errorMessage"]).toContain("Bearer [redacted]");
    expect(parsed["errorMessage"]).not.toContain("a".repeat(20));
  });

  it("redacts GitHub PAT patterns in string values", () => {
    let capturedData: unknown;
    const captureDb = {
      prepare: (_sql: string) => ({
        run: (...args: unknown[]) => {
          capturedData = args[8];
        },
        all: () => [],
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(captureDb as any);
    const pat = "ghp_" + "A".repeat(36);
    recordActivityEvent({
      source: "scm",
      kind: "scm.poll_pr_failed",
      summary: "poll failed",
      data: { errorMessage: `git push failed: ${pat}` },
    });
    const parsed = JSON.parse(capturedData as string);
    expect(parsed["errorMessage"]).toContain("[redacted]");
    expect(parsed["errorMessage"]).not.toContain(pat);
  });

  it("redacts credential URLs with long userinfo via linear scan", () => {
    let capturedData: unknown;
    const captureDb = {
      prepare: (_sql: string) => ({
        run: (...args: unknown[]) => {
          capturedData = args[8];
        },
        all: () => [],
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(captureDb as any);
    const longCred = "x".repeat(300);
    recordActivityEvent({
      source: "scm",
      kind: "scm.poll_pr_failed",
      summary: "poll failed",
      data: { url: `https://${longCred}@github.com/owner/repo.git` },
    });
    const parsed = JSON.parse(capturedData as string);
    expect(parsed["url"]).toContain("[redacted]");
    expect(parsed["url"]).not.toContain(longCred);
  });

  it("truncates individual string values to 500 chars", () => {
    let capturedData: unknown;
    const captureDb = {
      prepare: (_sql: string) => ({
        run: (...args: unknown[]) => {
          capturedData = args[8];
        },
        all: () => [],
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(captureDb as any);
    const longValue = "y".repeat(600);
    recordActivityEvent({
      source: "lifecycle",
      kind: "lifecycle.poll_failed",
      summary: "poll failed",
      data: { errorMessage: longValue },
    });
    const parsed = JSON.parse(capturedData as string);
    expect(parsed["errorMessage"].length).toBeLessThanOrEqual(500);
  });
});
