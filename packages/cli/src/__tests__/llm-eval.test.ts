/**
 * Tests for llm-eval.ts — ETIMEDOUT and 429 retry/continue behavior.
 *
 * RED phase: capture the bug where ETIMEDOUT and 429 cause early return
 * instead of continuing to the next candidate binary.
 *
 * GREEN phase: fix the catch block in tryClaudePrint to:
 *   ETIMEDOUT  → continue to next candidate (binary-specific hang)
 *   429        → retry once with 2s backoff, then continue to next candidate
 *   401/403    → return immediately (auth failure, all binaries share same creds)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());
const accessSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const original = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...original,
    execFileSync: execFileSyncMock,
  };
});

vi.mock("node:fs", async () => {
  const original = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...original,
    accessSync: accessSyncMock,
    constants: { X_OK: 1 },
  };
});

// Bring in the module under test — must import after mocks are set up
import { tryClaudePrint } from "../lib/llm-eval.js";

// Helper to build an Error with a specific code
function makeError(code: string | undefined, message: string): Error {
  const err = new Error(message) as NodeJS.ErrnoException;
  if (code !== undefined) err.code = code;
  return err;
}

describe("tryClaudePrint — ETIMEDOUT handling", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation(() => {
      throw new Error("unexpected call");
    });
    // Default: all candidates are executable
    accessSyncMock.mockImplementation(() => {});
  });

  it("continues to next binary candidate when first candidate ETIMEDOUT", async () => {
    // Candidate 1: ETIMEDOUT (binary-specific hang — GUI app in headless env)
    execFileSyncMock.mockImplementationOnce(() => {
      throw makeError("ETIMEDOUT", "Command timed out");
    });
    // Candidate 2: returns valid VERDICT
    execFileSyncMock.mockImplementationOnce(() => {
      return "Some output\nVERDICT: PASS\n";
    });

    const result = await tryClaudePrint("test prompt");

    // Should succeed via second candidate — not bail out after ETIMEDOUT
    expect(result.validVerdict).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it("returns VERDICT: FAIL when all binary candidates ETIMEDOUT", async () => {
    // All candidates return ETIMEDOUT
    execFileSyncMock.mockImplementation(() => {
      throw makeError("ETIMEDOUT", "Command timed out");
    });

    const result = await tryClaudePrint("test prompt");

    // No valid verdict — all candidates exhausted
    expect(result.validVerdict).toBe(false);
    expect(result.error).toBeUndefined(); // none found were "missing" — all ETIMEDOUT
  });
});

describe("tryClaudePrint — 429 rate-limit handling", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation(() => {
      throw new Error("unexpected call");
    });
    accessSyncMock.mockImplementation(() => {});
  });

  it("retries once after 429 before trying next candidate", async () => {
    // First call: 429 (rate limit)
    execFileSyncMock.mockImplementationOnce(() => {
      throw makeError(undefined, "Request failed with status code 429");
    });
    // Retry after backoff: valid VERDICT
    execFileSyncMock.mockImplementationOnce(() => {
      return "Some output\nVERDICT: PASS\n";
    });

    const start = Date.now();
    const result = await tryClaudePrint("test prompt");
    const elapsed = Date.now() - start;

    // Should succeed on retry — not bail out on 429
    expect(result.validVerdict).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    // Backoff should be ~2s
    expect(elapsed).toBeGreaterThan(1900);
  });

  it("continues to next candidate after 429 retry fails", async () => {
    // First call: 429 (rate limit)
    execFileSyncMock.mockImplementationOnce(() => {
      throw makeError(undefined, "Request failed with status code 429");
    });
    // Retry: 429 again (still rate limited)
    execFileSyncMock.mockImplementationOnce(() => {
      throw makeError(undefined, "status 429 rate limit exceeded");
    });
    // Next candidate: valid VERDICT
    execFileSyncMock.mockImplementationOnce(() => {
      return "output\nVERDICT: PASS\n";
    });

    const result = await tryClaudePrint("test prompt");

    // Should succeed via third candidate after both 429 attempts
    expect(result.validVerdict).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledTimes(3);
  });

  it("handles 429 with rate_limit in message body", async () => {
    // 429 via "rate_limit" in message
    execFileSyncMock.mockImplementationOnce(() => {
      throw makeError(undefined, "anthropic API error: rate limit exceeded, retry after 2s");
    });
    // Retry: valid
    execFileSyncMock.mockImplementationOnce(() => {
      return "output\nVERDICT: PASS\n";
    });

    const result = await tryClaudePrint("test prompt");
    expect(result.validVerdict).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });
});

describe("tryClaudePrint — 401/403 auth failure still returns immediately", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation(() => {
      throw new Error("unexpected call");
    });
    accessSyncMock.mockImplementation(() => {});
  });

  it("returns immediately (not continue) on 401 auth failure — all binaries share same creds", async () => {
    // 401 on first candidate
    execFileSyncMock.mockImplementationOnce(() => {
      throw makeError(undefined, "Request failed with status code 401");
    });
    // Second candidate would succeed but we should never reach it
    execFileSyncMock.mockImplementationOnce(() => {
      return "output\nVERDICT: PASS\n";
    });

    const result = await tryClaudePrint("test prompt");

    // Returns with error=undefined (tool unavailable) — does NOT continue to second candidate
    // because 401 means auth is globally bad — another binary won't help
    expect(result.validVerdict).toBe(false);
    expect(result.error).toBeUndefined();
    expect(execFileSyncMock).toHaveBeenCalledTimes(1); // Only first candidate tried
  });

  it("returns immediately on 403 forbidden", async () => {
    execFileSyncMock.mockImplementationOnce(() => {
      throw makeError(undefined, "403 Forbidden");
    });
    execFileSyncMock.mockImplementationOnce(() => {
      return "output\nVERDICT: PASS\n";
    });

    const result = await tryClaudePrint("test prompt");

    expect(result.validVerdict).toBe(false);
    expect(result.error).toBeUndefined();
    expect(execFileSyncMock).toHaveBeenCalledTimes(1); // Only first candidate tried
  });
});

describe("tryClaudePrint — 429 then retry auth failure (regression)", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation(() => {
      throw new Error("unexpected call");
    });
    accessSyncMock.mockImplementation(() => {});
  });

  it("returns immediately when 429 initial retry hits 401 — auth is global", async () => {
    // First call: 429 (rate limit)
    execFileSyncMock.mockImplementationOnce(() => {
      throw makeError(undefined, "Request failed with status code 429");
    });
    // Retry: 401 (auth failure — no other binary will help)
    execFileSyncMock.mockImplementationOnce(() => {
      throw makeError(undefined, "Request failed with status code 401");
    });
    // Third candidate would succeed but should never be reached
    execFileSyncMock.mockImplementationOnce(() => {
      return "output\nVERDICT: PASS\n";
    });

    const result = await tryClaudePrint("test prompt");

    // Returns immediately on 401 retry — does NOT continue to third candidate
    expect(result.validVerdict).toBe(false);
    expect(result.error).toBeUndefined();
    expect(execFileSyncMock).toHaveBeenCalledTimes(2); // Only 2 calls (429 then 401)
  });

  it("returns immediately when 429 initial retry hits 403 — auth is global", async () => {
    execFileSyncMock.mockImplementationOnce(() => {
      throw makeError(undefined, "429 rate limit exceeded");
    });
    execFileSyncMock.mockImplementationOnce(() => {
      throw makeError(undefined, "403 Forbidden");
    });
    execFileSyncMock.mockImplementationOnce(() => {
      return "output\nVERDICT: PASS\n";
    });

    const result = await tryClaudePrint("test prompt");

    expect(result.validVerdict).toBe(false);
    expect(result.error).toBeUndefined();
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it("returns immediately when 429 initial retry hits 401 via unauthorized message", async () => {
    execFileSyncMock.mockImplementationOnce(() => {
      throw makeError(undefined, "status 429");
    });
    execFileSyncMock.mockImplementationOnce(() => {
      throw makeError(undefined, "unauthorized — invalid credentials");
    });
    execFileSyncMock.mockImplementationOnce(() => {
      return "output\nVERDICT: PASS\n";
    });

    const result = await tryClaudePrint("test prompt");

    expect(result.validVerdict).toBe(false);
    expect(result.error).toBeUndefined();
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });
});