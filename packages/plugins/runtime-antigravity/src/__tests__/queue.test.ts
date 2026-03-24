import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the queue module by verifying serial execution behavior.
// p-queue is a real dependency — we test the integration, not mock it.

import { enqueue, pendingCount } from "../queue.js";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("enqueue()", () => {
  it("resolves with the return value of the enqueued function", async () => {
    const result = await enqueue(async () => 42);
    expect(result).toBe(42);
  });

  it("propagates errors from the enqueued function", async () => {
    await expect(
      enqueue(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("executes tasks serially (concurrency 1)", async () => {
    const order: number[] = [];
    const delay = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    // Enqueue three tasks — task 2 is slower but should still complete
    // before task 3 starts since concurrency is 1.
    const p1 = enqueue(async () => {
      order.push(1);
      await delay(10);
      order.push(11);
    });
    const p2 = enqueue(async () => {
      order.push(2);
      await delay(30);
      order.push(22);
    });
    const p3 = enqueue(async () => {
      order.push(3);
      order.push(33);
    });

    await Promise.all([p1, p2, p3]);

    // Tasks must execute in order: 1 starts, 1 ends, 2 starts, 2 ends, 3 starts, 3 ends
    expect(order).toEqual([1, 11, 2, 22, 3, 33]);
  });

  it("continues processing after a failed task", async () => {
    const failTask = enqueue(async () => {
      throw new Error("fail");
    });
    const successTask = enqueue(async () => "ok");

    await expect(failTask).rejects.toThrow("fail");
    const result = await successTask;
    expect(result).toBe("ok");
  });
});

describe("pendingCount()", () => {
  it("returns 0 when queue is idle", () => {
    expect(pendingCount()).toBe(0);
  });
});
