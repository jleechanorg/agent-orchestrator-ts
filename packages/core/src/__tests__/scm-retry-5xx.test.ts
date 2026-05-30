import { describe, it, expect } from "vitest";
import { withScmRetry } from "../scm-retry-5xx.js";

describe("withScmRetry", () => {
  it("returns result on first success", async () => {
    const result = await withScmRetry(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
  });

  it("retries on 5xx status and succeeds on retry", async () => {
    let attempt = 0;
    const fn = () => {
      attempt++;
      if (attempt === 1) {
        const err = new Error("server error 500");
        throw err;
      }
      return Promise.resolve("ok");
    };

    const result = await withScmRetry(fn, { retries: 2, retryDelayMs: 10 });
    expect(result).toBe("ok");
    expect(attempt).toBe(2);
  });

  it("retries on 429 status", async () => {
    let attempt = 0;
    const fn = () => {
      attempt++;
      if (attempt === 1) {
        throw new Error("rate limited 429");
      }
      return Promise.resolve("ok");
    };

    const result = await withScmRetry(fn, { retries: 2, retryDelayMs: 10 });
    expect(result).toBe("ok");
  });

  it("throws immediately on non-retryable error", async () => {
    const fn = () => {
      throw new Error("not found 404");
    };

    await expect(withScmRetry(fn, { retries: 2, retryDelayMs: 10 })).rejects.toThrow("404");
  });

  it("throws after retries exhausted", async () => {
    const fn = () => {
      throw new Error("server error 503");
    };

    await expect(withScmRetry(fn, { retries: 1, retryDelayMs: 10 })).rejects.toThrow("503");
  });

  it("uses custom getStatus extractor", async () => {
    let attempt = 0;
    const fn = () => {
      attempt++;
      if (attempt === 1) {
        throw { statusCode: 502 };
      }
      return Promise.resolve("ok");
    };

    const result = await withScmRetry(
      fn,
      { retries: 2, retryDelayMs: 10 },
      (err) => (err as any).statusCode ?? null,
    );
    expect(result).toBe("ok");
  });
});
