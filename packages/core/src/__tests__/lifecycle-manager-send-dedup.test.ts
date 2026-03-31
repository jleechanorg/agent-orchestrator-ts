/**
 * Tests for bd-n039 + bd-1178: SHA-based deduplication for send-to-agent reactions.
 *
 * These tests verify the dedup-head-sha-store module which provides the underlying
 * state for lifecycle-manager's send-to-agent dedup logic. The store is tested
 * directly — no module mocking needed.
 *
 * Invariants verified:
 *  1. getLastSentHeadSha returns undefined before any set (first-send allowed)
 *  2. setLastSentHeadSha records the SHA; subsequent get returns it (dedup triggers)
 *  3. If SHA changes, dedup is bypassed (new commit → re-send allowed)
 *  4. Cross-project isolation: same session+reaction in different projects uses different keys
 *  5. Cross-reaction isolation: same project+session with different reactionKeys are separate
 *  6. pruneStaleSessionIds removes entries for dead sessions only
 *  7. clearLastSentHeadSha removes all entries for a session regardless of reaction key
 *  8. Message hash dedup: same message hash skips send; different hash allows send
 *  9. SHA-unavailable fallback: when currentSha is undefined, shaUnchanged=true (message-hash only)
 * 10. Combined dedup: skip only when BOTH SHA and message hash are unchanged
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  getLastSentHeadSha,
  setLastSentHeadSha,
  clearLastSentHeadSha,
  pruneStaleSessionIds,
  getLastSentMessageHash,
  setLastSentMessageHash,
  clearAllMessageHashesForSession,
  hashMessageContent,
} from "../dedup-head-sha-store.js";

// Reset store state between tests to keep tests hermetic
function resetStoreForSession(sessionId: string) {
  clearLastSentHeadSha(sessionId);
  clearAllMessageHashesForSession(sessionId);
}

describe("bd-n039 send-to-agent SHA dedup — dedup-head-sha-store invariants", () => {
  const PROJECT = "project-alpha";
  const SESSION = "session-dedup-1";
  const REACTION = "changes-requested";

  beforeEach(() => {
    resetStoreForSession(SESSION);
  });

  // Invariant 1: fresh session has no recorded SHA
  it("returns undefined before any SHA is set (first send is always allowed)", () => {
    const sha = getLastSentHeadSha(PROJECT, SESSION, REACTION);
    expect(sha).toBeUndefined();

    // Dedup check as used in lifecycle-manager.ts:
    const currentSha = "abc1111111111111111111111111111111111111";
    const lastSha = sha; // undefined
    const shaUnchanged = currentSha !== undefined
      ? (lastSha !== undefined && currentSha === lastSha)
      : true;
    // SHA is defined and lastSha is undefined → shaUnchanged = false → send allowed
    expect(shaUnchanged).toBe(false);
  });

  // Invariant 2: after recording, dedup triggers on same SHA
  it("dedup triggers when SHA is the same as last sent", () => {
    const sha = "abc2222222222222222222222222222222222222";
    setLastSentHeadSha(PROJECT, SESSION, REACTION, sha);

    const lastSha = getLastSentHeadSha(PROJECT, SESSION, REACTION);
    const currentSha = sha; // unchanged
    const shaUnchanged = currentSha !== undefined
      ? (lastSha !== undefined && currentSha === lastSha)
      : true;
    expect(shaUnchanged).toBe(true); // should dedup
  });

  // Invariant 3: SHA change bypasses dedup
  it("SHA change allows re-send even if message content is the same", () => {
    const oldSha = "abc3333333333333333333333333333333333333";
    const newSha = "abc4444444444444444444444444444444444444";
    setLastSentHeadSha(PROJECT, SESSION, REACTION, oldSha);

    const lastSha = getLastSentHeadSha(PROJECT, SESSION, REACTION);
    const shaUnchanged = newSha !== undefined
      ? (lastSha !== undefined && newSha === lastSha)
      : true;
    expect(shaUnchanged).toBe(false); // SHA changed → not deduped
  });

  // Invariant 4: cross-project isolation
  it("different projectIds produce separate dedup keys (cross-project isolation)", () => {
    const PROJECT_B = "project-beta";
    const sha = "abc5555555555555555555555555555555555555";

    setLastSentHeadSha(PROJECT, SESSION, REACTION, sha);

    // Project B has no entry yet — should not see Project A's SHA
    const shaInProjectB = getLastSentHeadSha(PROJECT_B, SESSION, REACTION);
    expect(shaInProjectB).toBeUndefined();

    // Cleanup
    clearLastSentHeadSha(SESSION);
  });

  // Invariant 5: cross-reaction isolation
  it("different reactionKeys produce separate dedup keys (cross-reaction isolation)", () => {
    const REACTION_B = "ci-failed";
    const shaA = "abc6666666666666666666666666666666666666";
    const shaB = "abc7777777777777777777777777777777777777";

    setLastSentHeadSha(PROJECT, SESSION, REACTION, shaA);
    setLastSentHeadSha(PROJECT, SESSION, REACTION_B, shaB);

    expect(getLastSentHeadSha(PROJECT, SESSION, REACTION)).toBe(shaA);
    expect(getLastSentHeadSha(PROJECT, SESSION, REACTION_B)).toBe(shaB);
  });
});

describe("bd-n039 send-to-agent dedup — pruneStaleSessionIds", () => {
  const PROJECT = "project-prune";

  beforeEach(() => {
    clearLastSentHeadSha("prune-alive");
    clearLastSentHeadSha("prune-dead");
    clearAllMessageHashesForSession("prune-alive");
    clearAllMessageHashesForSession("prune-dead");
  });

  // Invariant 6: pruneStaleSessionIds removes dead entries, keeps live ones
  it("pruneStaleSessionIds removes dead session entries, preserves live ones", () => {
    setLastSentHeadSha(PROJECT, "prune-alive", "changes-requested", "sha-alive");
    setLastSentHeadSha(PROJECT, "prune-dead", "changes-requested", "sha-dead");

    const liveSessions = new Set(["prune-alive"]);
    pruneStaleSessionIds(PROJECT, liveSessions);

    expect(getLastSentHeadSha(PROJECT, "prune-alive", "changes-requested")).toBe("sha-alive");
    expect(getLastSentHeadSha(PROJECT, "prune-dead", "changes-requested")).toBeUndefined();
  });

  // Invariant 6b: pruneStaleSessionIds only prunes in the specified project
  it("pruneStaleSessionIds does not prune entries from other projects", () => {
    const OTHER_PROJECT = "project-other";
    setLastSentHeadSha(OTHER_PROJECT, "prune-dead", "reaction", "sha-other");

    // Prune project-prune, session prune-dead is "dead" — but it's in OTHER_PROJECT
    const liveSessions = new Set<string>();
    pruneStaleSessionIds(PROJECT, liveSessions);

    // OTHER_PROJECT entry should NOT be pruned
    expect(getLastSentHeadSha(OTHER_PROJECT, "prune-dead", "reaction")).toBe("sha-other");

    clearLastSentHeadSha("prune-dead");
  });
});

describe("bd-n039 send-to-agent dedup — clearLastSentHeadSha", () => {
  const PROJECT = "project-clear";
  const SESSION = "session-clear-1";

  // Invariant 7: clearLastSentHeadSha removes ALL reaction keys for a session
  it("clearLastSentHeadSha removes all entries for a session regardless of reaction key", () => {
    setLastSentHeadSha(PROJECT, SESSION, "changes-requested", "sha1");
    setLastSentHeadSha(PROJECT, SESSION, "ci-failed", "sha2");
    setLastSentHeadSha(PROJECT, SESSION, "agent-stuck", "sha3");

    clearLastSentHeadSha(SESSION);

    expect(getLastSentHeadSha(PROJECT, SESSION, "changes-requested")).toBeUndefined();
    expect(getLastSentHeadSha(PROJECT, SESSION, "ci-failed")).toBeUndefined();
    expect(getLastSentHeadSha(PROJECT, SESSION, "agent-stuck")).toBeUndefined();
  });
});

describe("bd-n039 send-to-agent dedup — message hash dedup", () => {
  const PROJECT = "project-hash";
  const SESSION = "session-hash-1";
  const REACTION = "changes-requested";

  beforeEach(() => {
    clearAllMessageHashesForSession(SESSION);
  });

  // Invariant 8a: same message hash → message is unchanged
  it("getLastSentMessageHash returns the recorded hash (same message → dedup)", () => {
    const hash = "a".repeat(64); // mock sha256 hex
    setLastSentMessageHash(PROJECT, SESSION, REACTION, hash);
    expect(getLastSentMessageHash(PROJECT, SESSION, REACTION)).toBe(hash);
  });

  // Invariant 8b: different hash → allow send
  it("different message hash means message changed — send is allowed", () => {
    const oldHash = "a".repeat(64);
    const newHash = "b".repeat(64);
    setLastSentMessageHash(PROJECT, SESSION, REACTION, oldHash);
    const recorded = getLastSentMessageHash(PROJECT, SESSION, REACTION);
    expect(recorded).not.toBe(newHash);
    // messageUnchanged = (recorded === newHash) = false → send is allowed
    const messageUnchanged = recorded === newHash;
    expect(messageUnchanged).toBe(false);
  });

  // Invariant 9: SHA unavailable → store has no SHA, dedup falls back to message-hash only
  it("when SHA is unavailable, store has no recorded SHA and dedup uses message-hash only", () => {
    // No SHA stored — getLastSentHeadSha returns undefined (SHA fetch failed / sentinel)
    const recordedSha = getLastSentHeadSha(PROJECT, SESSION, REACTION);
    expect(recordedSha).toBeUndefined();

    // SHA unavailable → shaUnchanged treated as true (don't block on missing SHA)
    const currentSha: string | undefined = undefined;
    const shaUnchanged = currentSha === undefined || currentSha === recordedSha;
    expect(shaUnchanged).toBe(true);

    // Message hash IS stored — simulates unchanged message
    const storedHash = "a".repeat(64);
    setLastSentMessageHash(PROJECT, SESSION, REACTION, storedHash);
    const messageUnchanged = getLastSentMessageHash(PROJECT, SESSION, REACTION) === storedHash;
    expect(messageUnchanged).toBe(true);

    // Combined: SHA-unavailable + message unchanged → dedup
    expect(shaUnchanged && messageUnchanged).toBe(true);
  });
});

describe("bd-n039 send-to-agent dedup — combined SHA + message hash invariant", () => {
  const PROJECT = "project-combined";
  const SESSION = "session-combined-1";
  const REACTION = "changes-requested";

  beforeEach(() => {
    clearLastSentHeadSha(SESSION);
    clearAllMessageHashesForSession(SESSION);
  });

  // Invariant 10: skip only when BOTH SHA and message hash are unchanged (store-level test)
  it("skip send only when BOTH SHA and message hash are unchanged", () => {
    const sha1 = "abc1234";
    const hash1 = "a".repeat(64);

    // Record initial send
    setLastSentHeadSha(PROJECT, SESSION, REACTION, sha1);
    setLastSentMessageHash(PROJECT, SESSION, REACTION, hash1);

    // Case: both SHA and message unchanged → dedup (skip send)
    const shaUnchanged1 = getLastSentHeadSha(PROJECT, SESSION, REACTION) === sha1;
    const msgUnchanged1 = getLastSentMessageHash(PROJECT, SESSION, REACTION) === hash1;
    expect(shaUnchanged1 && msgUnchanged1).toBe(true);

    // Case: SHA same, message changed → send
    const hash2 = "b".repeat(64);
    const shaUnchanged2 = getLastSentHeadSha(PROJECT, SESSION, REACTION) === sha1;
    const msgUnchanged2 = getLastSentMessageHash(PROJECT, SESSION, REACTION) === hash2;
    expect(shaUnchanged2 && msgUnchanged2).toBe(false);

    // Case: SHA changed, message same → send
    const sha2 = "def5678";
    const shaUnchanged3 = getLastSentHeadSha(PROJECT, SESSION, REACTION) === sha2;
    const msgUnchanged3 = getLastSentMessageHash(PROJECT, SESSION, REACTION) === hash1;
    expect(shaUnchanged3 && msgUnchanged3).toBe(false);

    // Case: both changed → send
    const shaUnchanged4 = getLastSentHeadSha(PROJECT, SESSION, REACTION) === sha2;
    const msgUnchanged4 = getLastSentMessageHash(PROJECT, SESSION, REACTION) === hash2;
    expect(shaUnchanged4 && msgUnchanged4).toBe(false);
  });
});

describe("bd-n039 hashMessageContent utility", () => {
  it("hashes identical content to the same digest", async () => {
    const content = "CI failed: 3 tests failing in workflow run #12345";
    const hash1 = await hashMessageContent(content);
    const hash2 = await hashMessageContent(content);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // sha256 = 64 hex chars
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hashes different content to different digests", async () => {
    const hash1 = await hashMessageContent("message A — SHA abc1234");
    const hash2 = await hashMessageContent("message A — SHA def5678"); // different SHA in message
    expect(hash1).not.toBe(hash2);
  });

  it("hashes empty string without throwing", async () => {
    const hash = await hashMessageContent("");
    expect(typeof hash).toBe("string");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
