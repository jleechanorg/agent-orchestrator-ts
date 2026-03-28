import { describe, it, expect, vi, beforeEach } from "vitest";

// Track ghJson calls for debug
const ghJsonLog: unknown[] = [];
let ghJsonImpl: (...args: unknown[]) => unknown = () => null;

vi.mock("../../../src/commands/skeptic/gh-client.js", () => {
  const ghJson = vi.fn((...args: unknown[]) => {
    ghJsonLog.push(args);
    return ghJsonImpl(...args);
  });
  return {
    ghJson,
    fetchReviews: vi.fn(() => Promise.resolve([])),
  };
});

const { fetchMergeGateState } = await import("../../../src/commands/skeptic/mergeGate.js");

describe("debug", () => {
  beforeEach(() => {
    ghJsonLog.length = 0;
  });

  it("verify call order and args", async () => {
    // Queue up return values
    const comments = [
      { id: 99, body: "VERDICT: SKIPPED", user: { login: "jleechan-agent[bot]" } }
    ];
    let idx = 0;
    const queue = [
      { head: { ref: "main" }, mergeable: true },
      { state: "success" },
      [],
      comments,
    ];
    ghJsonImpl = () => {
      const val = queue[idx];
      idx++;
      return Promise.resolve(val ?? null);
    };

    const state = await fetchMergeGateState({
      owner: "test", repo: "test-repo", prNumber: 1,
      skepticBotAuthor: "jleechan-agent[bot]",
    });

    console.error('[DEBUG] ghJsonLog count:', ghJsonLog.length);
    ghJsonLog.forEach((args, i) => {
      console.error(`  call[${i}]: ${JSON.stringify((args as unknown[]).map(a => typeof a === 'string' ? a : `[${typeof a}]`))}`);
    });
    console.error('[DEBUG] skepticVerdict:', state.skepticVerdict);
    expect(state.skepticVerdict).toBe("SKIPPED");
  });
});
