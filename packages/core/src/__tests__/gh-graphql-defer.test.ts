import { describe, it, expect, vi } from "vitest";
import {
  DeferredGraphQLExecutor,
  getBackoffForAttempt,
  withRetryAndDefer,
} from "../gh-graphql-defer.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Create a fake executor that always resolves successfully. */
function resolvingExecutor(data: unknown) {
  return {
    execute: vi.fn<[string, Record<string, unknown>], Promise<unknown>>(
      async () => data,
    ),
  };
}

/** Create a fake executor that always throws a rate-limit error. */
function rateLimitExecutor(message = "GraphQL rate limit exceeded") {
  return {
    execute: vi.fn<[string, Record<string, unknown>], Promise<unknown>>(
      async () => {
        const err = new Error(message);
        Object.defineProperty(err, "cause", {
          value: { message },
          enumerable: false,
        });
        throw err;
      },
    ),
  };
}

/** Create a fake executor that throws a non-rate-limit error. */
function errorExecutor(message = "Not found") {
  return {
    execute: vi.fn<[string, Record<string, unknown>], Promise<unknown>>(
      async () => {
        throw new Error(message);
      },
    ),
  };
}

/** Create a fake executor that fails N times then resolves. */
function failThenResolve(failCount: number, successData: unknown) {
  let calls = 0;
  return {
    execute: vi.fn<[string, Record<string, unknown>], Promise<unknown>>(
      async () => {
        calls++;
        if (calls <= failCount) {
          const err = new Error("rate limit");
          Object.defineProperty(err, "cause", {
            value: { message: "rate limit" },
            enumerable: false,
          });
          throw err;
        }
        return successData;
      },
    ),
  };
}

// ---------------------------------------------------------------------------
// getBackoffForAttempt
// ---------------------------------------------------------------------------

describe("getBackoffForAttempt", () => {
  it("returns INITIAL_BACKOFF_MS (1s) for attempt 1", () => {
    expect(getBackoffForAttempt(1)).toBe(1_000);
  });

  it("returns 2s for attempt 2", () => {
    expect(getBackoffForAttempt(2)).toBe(2_000);
  });

  it("returns 4s for attempt 3", () => {
    expect(getBackoffForAttempt(3)).toBe(4_000);
  });

  it("caps at the provided value", () => {
    expect(getBackoffForAttempt(10, 30_000)).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// DeferredGraphQLExecutor
// ---------------------------------------------------------------------------

describe("DeferredGraphQLExecutor", () => {
  describe("happy path", () => {
    it("resolves immediately when base executor succeeds", async () => {
      const base = resolvingExecutor({ foo: "bar" });
      const exec = new DeferredGraphQLExecutor(base);

      const result = await exec.executeWithLabel("test-op", "query {}", {});

      expect(result.data).toEqual({ foo: "bar" });
      expect(result.wasDeferred).toBe(false);
      expect(result.deferred).toHaveLength(0);
      expect(base.execute).toHaveBeenCalledTimes(1);
    });

    it("successive calls with resolving executor don't accumulate deferred state", async () => {
      const base = resolvingExecutor({ ok: true });
      const exec = new DeferredGraphQLExecutor(base);

      // Both calls succeed — no deferred record is ever created.
      await exec.executeWithLabel("op", "mutation {}", {});
      const result = await exec.executeWithLabel("op", "mutation {}", {});

      expect(result.data).toEqual({ ok: true });
      expect(exec.hasDeferred).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Retry + backoff
  // ---------------------------------------------------------------------------

  describe("retry on rate-limit errors", () => {
    it("retries up to maxAttempts before deferring", async () => {
      vi.useFakeTimers();
      try {
        const base = rateLimitExecutor();
        const exec = new DeferredGraphQLExecutor(base);

        // Fire but don't await — advance timers to exhaust backoff periods
        const promise = exec.executeWithLabel("test-op", "mutation {}", {});

        // Exhaust retries: maxAttempts=3 by default
        // Attempt 1 fails → sleep 1s
        await vi.advanceTimersByTimeAsync(1_000);
        // Attempt 2 fails → sleep 2s
        await vi.advanceTimersByTimeAsync(2_000);
        // Attempt 3 fails → defer
        await vi.advanceTimersByTimeAsync(4_000);

        const result = await promise;

        expect(result.wasDeferred).toBe(true);
        expect(result.data).toBeNull();
        expect(result.deferred).toHaveLength(1);
        expect(result.deferred[0]!.label).toBe("test-op");
        expect(base.execute).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("succeeds on second attempt after one rate-limit failure", async () => {
      vi.useFakeTimers();
      try {
        const base = failThenResolve(1, { ok: true });
        const exec = new DeferredGraphQLExecutor(base);

        const promise = exec.executeWithLabel("test-op", "query {}", {});

        // First fail + backoff 1s
        await vi.advanceTimersByTimeAsync(1_000);
        // Second attempt succeeds
        const result = await promise;

        expect(result.data).toEqual({ ok: true });
        expect(result.wasDeferred).toBe(false);
        expect(base.execute).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not retry non-rate-limit errors", async () => {
      const base = errorExecutor("validation error");
      const exec = new DeferredGraphQLExecutor(base);

      const result = await exec.executeWithLabel("test-op", "query {}", {});

      expect(result.wasDeferred).toBe(false);
      expect(result.data).toBeNull();
      expect(result.deferred).toHaveLength(0);
      expect(base.execute).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Deferred-state persistence
  // ---------------------------------------------------------------------------

  describe("deferred state", () => {
    it("is accessible via hasDeferred and deferredItems after deferral", async () => {
      vi.useFakeTimers();
      try {
        const base = rateLimitExecutor();
        const exec = new DeferredGraphQLExecutor(base);

        const promise = exec.executeWithLabel("op-1", "mutation {}", {});

        await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
        await promise;

        expect(exec.hasDeferred).toBe(true);
        const items = Array.from(exec.deferredItems.values());
        expect(items).toHaveLength(1);
        expect(items[0]!.label).toBe("op-1");
        expect(items[0]!.attempts).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("clearAllDeferred removes all deferred items", async () => {
      vi.useFakeTimers();
      try {
        const base = rateLimitExecutor();
        const exec = new DeferredGraphQLExecutor(base);

        const p = exec.executeWithLabel("op", "mutation {}", {});
        await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
        await p;

        exec.clearAllDeferred();
        expect(exec.hasDeferred).toBe(false);
        expect(Array.from(exec.deferredItems.values())).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not re-attempt without sufficient backoff elapsed since deferral", async () => {
      vi.useFakeTimers();
      try {
        const base = rateLimitExecutor();
        const exec = new DeferredGraphQLExecutor(base);

        // First invocation — defer
        const p1 = exec.executeWithLabel("op", "mutation {}", {});
        await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
        await p1;
        expect(exec.hasDeferred).toBe(true);

        // Advance only 500ms — less than the 1s backoff required for next attempt
        await vi.advanceTimersByTimeAsync(500);

        // Second invocation — should skip retry (insufficient backoff elapsed)
        const p2 = exec.executeWithLabel("op", "mutation {}", {});
        const result = await p2;

        expect(result.wasDeferred).toBe(true);
        // Base executor should NOT have been called again (still at 3 calls)
        expect(base.execute).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Passthrough via GraphQLExecutor interface
  // ---------------------------------------------------------------------------

  describe("GraphQLExecutor interface", () => {
    it("execute() is a passthrough without retry", async () => {
      const base = resolvingExecutor({ passthrough: true });
      const exec = new DeferredGraphQLExecutor(base);

      // Call the raw interface method (no retry, no deferral)
      const result = await exec.execute("query {}", {});

      expect(result).toEqual({ passthrough: true });
      expect(base.execute).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // withRetryAndDefer factory
  // ---------------------------------------------------------------------------

  describe("withRetryAndDefer", () => {
    it("returns a DeferredGraphQLExecutor", async () => {
      const base = resolvingExecutor({ data: 1 });
      const exec = withRetryAndDefer(base);

      const result = await exec.executeWithLabel("test", "query {}", {});
      expect(result.data).toEqual({ data: 1 });
    });
  });
});
