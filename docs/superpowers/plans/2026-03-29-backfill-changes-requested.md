# Backfill CHANGES_REQUESTED PRs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When CR posts CHANGES_REQUESTED on a PR whose AO worker has died (tmux session gone), the lifecycle-worker's backfill loop spawns a fresh worker with the specific CR review comments injected into the spawn prompt.

**Architecture:** Augment `backfillUncoveredPRs()` in `backfill-extensions.ts` with: (1) a tmux liveness pass that prunes dead-agent sessions from the "covered" set, (2) a CR review context fetch for CHANGES_REQUESTED PRs before spawning, and (3) a per-cycle rate-limit of 2 respawns for CR-PRs.

**Tech Stack:** TypeScript, vitest, tmux.ts (hasSession), scm-github (getReviewDecision, getReviews)

---

## Files Modified

| File | Role |
|------|------|
| `packages/core/src/backfill-extensions.ts` | Add tmux liveness, CR context fetch, rate-limit, context-aware prompt |
| `packages/core/src/__tests__/backfill-extensions.test.ts` | Add unit tests for new behavior |

---

## Test Doubles Needed

The existing test mocks `tmux` implicitly via `sessionManager`. We need to add a mock for `tmux.hasSession`. Since `backfill-extensions.ts` imports `hasSession` directly, we need to mock the module.

The vitest pattern from other tests in this repo uses `vi.mock("./tmux", ...)` with inline factory. We need to add this mock to the test file.

---

## Task 1: Add `tmux` module mock and new tests for tmux liveness behavior

**Files:**
- Modify: `packages/core/src/__tests__/backfill-extensions.test.ts`

- [ ] **Step 1: Add `tmux` module mock at top of test file**

Add this import mock block after the existing imports (before the first `describe`):

```typescript
// Mock tmux.ts — must be hoisted
vi.mock("../tmux.js", () => ({
  hasSession: vi.fn<(name: string) => Promise<boolean>>(),
}));

import { hasSession } from "../tmux.js";
```

- [ ] **Step 2: Add beforeEach reset for `hasSession` mock**

In the existing `beforeEach`, add:
```typescript
vi.mocked(hasSession).mockResolvedValue(true); // default: all sessions alive
```

- [ ] **Step 3: Add test — dead tmux session makes PR uncovered**

Add to the existing `describe` block (after the "spawns only the first uncovered PR per cycle" test):

```typescript
it("treats PR as uncovered when its session's tmux session is dead", async () => {
  const pr = makePR({ number: 77, branch: "feat/dead-tmux" });

  // Session for this PR exists, but tmux is dead
  const deadSession = makeSession({
    id: "dead-1",
    branch: "feat/dead-tmux",
    pr: { ...pr },
    runtimeHandle: { id: "rt-dead", runtimeName: "tmux", data: {} },
  });
  // Override the default: this specific runtimeHandle is dead
  vi.mocked(hasSession).mockImplementation(async (handle: string) => {
    return handle !== "rt-dead";
  });

  vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);

  const result = await backfillUncoveredPRs(
    deps,
    makeParams({ activeSessions: [deadSession] }),
  );

  expect(result).toBe(true);
  expect(mockSessionManager.spawn).toHaveBeenCalledOnce();
  expect(mockSessionManager.claimPR).toHaveBeenCalledWith("new-1", "77");
});
```

- [ ] **Step 4: Add test — alive tmux session keeps PR covered**

```typescript
it("keeps PR covered when session's tmux session is alive", async () => {
  const pr = makePR({ number: 88, branch: "feat/alive-tmux" });
  const aliveSession = makeSession({
    branch: "feat/alive-tmux",
    pr: { ...pr },
    runtimeHandle: { id: "rt-alive", runtimeName: "tmux", data: {} },
  });
  // hasSession always returns true → session is alive → PR stays covered
  vi.mocked(hasSession).mockResolvedValue(true);

  vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);

  const result = await backfillUncoveredPRs(
    deps,
    makeParams({ activeSessions: [aliveSession] }),
  );

  expect(result).toBe(false);
  expect(mockSessionManager.spawn).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: Add test — session without runtimeHandle is skipped in tmux check**

```typescript
it("skips tmux check for sessions without runtimeHandle (non-tmux runtime)", async () => {
  const pr = makePR({ number: 99, branch: "feat/no-rt" });
  const noRtSession = makeSession({
    branch: "feat/no-rt",
    pr: { ...pr },
    runtimeHandle: null, // non-tmux runtime
  });
  // hasSession should NOT be called for this session
  vi.mocked(hasSession).mockResolvedValue(false); // irrelevant

  vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);

  const result = await backfillUncoveredPRs(
    deps,
    makeParams({ activeSessions: [noRtSession] }),
  );

  expect(result).toBe(false);
  expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  expect(hasSession).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: Add test — tmux check fail-open (treats as alive)**

```typescript
it("treats session as alive when tmux.hasSession throws (fail-open)", async () => {
  const pr = makePR({ number: 55, branch: "feat/tmux-err" });
  const session = makeSession({
    branch: "feat/tmux-err",
    pr: { ...pr },
    runtimeHandle: { id: "rt-err", runtimeName: "tmux", data: {} },
  });
  vi.mocked(hasSession).mockRejectedValue(new Error("tmux server down"));

  vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);

  const result = await backfillUncoveredPRs(
    deps,
    makeParams({ activeSessions: [session] }),
  );

  // Fail-open → session treated as alive → PR stays covered
  expect(result).toBe(false);
  expect(mockSessionManager.spawn).not.toHaveBeenCalled();
});
```

- [ ] **Step 7: Run the new tests**

Run: `pnpm --filter @jleechanorg/ao-core test -- backfill-extensions.test.ts -t "tmux\|dead\|alive\|no-rt\|fail-open" -v`
Expected: FAIL — `hasSession` is imported but not yet wired in `backfill-extensions.ts`

---

## Task 2: Add CR review context tests

**Files:**
- Modify: `packages/core/src/__tests__/backfill-extensions.test.ts`

- [ ] **Step 1: Add test — CHANGES_REQUESTED PR with CR context gets targeted prompt**

```typescript
it("injects CR review body into spawn prompt for CHANGES_REQUESTED PRs", async () => {
  const pr = makePR({ number: 200, branch: "feat/cr-review" });
  vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);

  // Mock getReviewDecision → CHANGES_REQUESTED
  vi.mocked(mockSCM.getReviewDecision!).mockResolvedValue("changes_requested");

  // Mock getReviews → CR CHANGES_REQUESTED review with body
  const crReview = {
    author: "coderabbitai[bot]",
    state: "changes_requested",
    body: "Please fix the naming convention in auth.ts",
    submittedAt: new Date().toISOString(),
    commit_id: "abc123",
  };
  vi.mocked(mockSCM.getReviews!).mockResolvedValue([crReview]);

  const result = await backfillUncoveredPRs(deps, makeParams());

  expect(result).toBe(true);
  expect(mockSCM.getReviewDecision).toHaveBeenCalledWith(pr);
  expect(mockSCM.getReviews).toHaveBeenCalledWith(pr);

  // The spawn prompt should contain the CR review body
  const spawnCall = vi.mocked(mockSessionManager.spawn).mock.calls[0][0];
  expect(spawnCall.prompt).toContain("CHANGES_REQUESTED");
  expect(spawnCall.prompt).toContain("Please fix the naming convention in auth.ts");
});
```

- [ ] **Step 2: Add test — CHANGES_REQUESTED PR with no CR review gets generic prompt**

```typescript
it("falls back to generic prompt when CR review fetch returns no CR reviews", async () => {
  const pr = makePR({ number: 201, branch: "feat/no-cr-review", title: "My feature" });
  vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);
  vi.mocked(mockSCM.getReviewDecision!).mockResolvedValue("changes_requested");
  vi.mocked(mockSCM.getReviews!).mockResolvedValue([]); // no CR reviews

  const result = await backfillUncoveredPRs(deps, makeParams());

  expect(result).toBe(true);
  const spawnCall = vi.mocked(mockSessionManager.spawn).mock.calls[0][0];
  // Should NOT contain CHANGES_REQUESTED injection
  expect(spawnCall.prompt).not.toContain("CHANGES_REQUESTED");
  expect(spawnCall.prompt).toContain("Continue working on PR #201");
});
```

- [ ] **Step 3: Add test — non-CHANGES_REQUESTED PR gets generic prompt (no API call)**

```typescript
it("does not call getReviewDecision for non-CHANGES_REQUESTED PRs", async () => {
  const pr = makePR({ number: 202, branch: "feat/approved", title: "Approved PR" });
  vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);
  // getReviewDecision returns something other than changes_requested

  const result = await backfillUncoveredPRs(deps, makeParams());

  expect(result).toBe(true);
  // getReviewDecision should NOT be called for non-CR-PRs
  expect(mockSCM.getReviewDecision).not.toHaveBeenCalled();
  const spawnCall = vi.mocked(mockSessionManager.spawn).mock.calls[0][0];
  expect(spawnCall.prompt).toContain("Continue working on PR #202");
});
```

- [ ] **Step 4: Run the new tests**

Run: `pnpm --filter @jleechanorg/ao-core test -- backfill-extensions.test.ts -t "CHANGES_REQUESTED\|CR review\|generic prompt" -v`
Expected: FAIL — getReviewDecision not wired in `backfill-extensions.ts` yet

---

## Task 3: Add rate-limit tests

**Files:**
- Modify: `packages/core/src/__tests__/backfill-extensions.test.ts`

- [ ] **Step 1: Add test — max 2 CHANGES_REQUESTED respawns per cycle**

```typescript
it("skips the 3rd CHANGES_REQUESTED PR when rate-limit (2) is reached", async () => {
  const prs = [
    makePR({ number: 301, branch: "feat/cr-1", title: "CR PR 1" }),
    makePR({ number: 302, branch: "feat/cr-2", title: "CR PR 2" }),
    makePR({ number: 303, branch: "feat/cr-3", title: "CR PR 3" }),
  ];
  vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue(prs);

  // All three are CHANGES_REQUESTED
  vi.mocked(mockSCM.getReviewDecision!).mockImplementation(async (p: PRInfo) => {
    return "changes_requested";
  });
  vi.mocked(mockSCM.getReviews!).mockResolvedValue([
    { author: "coderabbitai[bot]", state: "changes_requested", body: "fix it", submittedAt: new Date().toISOString(), commit_id: "x" },
  ]);

  // spawn always succeeds, claim always succeeds
  let spawnCount = 0;
  vi.mocked(mockSessionManager.spawn).mockImplementation(async () => {
    spawnCount++;
    return makeSession({ id: `new-${spawnCount}` });
  });
  vi.mocked(mockSessionManager.claimPR).mockResolvedValue({
    sessionId: `new-${spawnCount}`,
    projectId: "proj",
    pr: makePR(),
    branchChanged: true,
    githubAssigned: false,
    takenOverFrom: [],
  });

  const result = await backfillUncoveredPRs(deps, makeParams());

  expect(result).toBe(true);
  // Only 2 CHANGES_REQUESTED PRs were spawned (rate-limit hit on 3rd)
  expect(mockSessionManager.spawn).toHaveBeenCalledTimes(2);
  expect(mockSessionManager.claimPR).toHaveBeenCalledTimes(2);
  // 3rd CR-PR was skipped
  expect(mockSessionManager.claimPR).toHaveBeenLastCalledWith("new-2", "302");
});
```

- [ ] **Step 2: Run the rate-limit test**

Run: `pnpm --filter @jleechanorg/ao-core test -- backfill-extensions.test.ts -t "rate-limit" -v`
Expected: FAIL — rate-limit counter not implemented yet

---

## Task 4: Implement tmux liveness pass + CR context fetch + rate-limit in backfill-extensions.ts

**Files:**
- Modify: `packages/core/src/backfill-extensions.ts`

- [ ] **Step 1: Add imports for `hasSession` and `TERMINAL_STATUSES`**

After the existing imports at the top of `backfill-extensions.ts`, add:

```typescript
import { hasSession } from "./tmux.js";
import { TERMINAL_STATUSES } from "./types.js";
```

- [ ] **Step 2: Add module-level rate-limit counter and reset function**

Add after the existing `lastBackfillTime` state (around line 49-55):

```typescript
let changesRequestedRespawnCount = 0;
const MAX_CHANGES_REQUESTED_RESPAWNS_PER_CYCLE = 2;

/** Expose rate-limit counter reset for testing. */
export function _resetCrRespawnCounter(): void {
  changesRequestedRespawnCount = 0;
}
```

- [ ] **Step 3: Reset counter at top of `backfillUncoveredPRs()`**

Add at the very start of the function body, after `const { registry, sessionManager, observer } = deps`:

```typescript
changesRequestedRespawnCount = 0;
```

- [ ] **Step 4: Add tmux liveness pass after building covered sets**

Find the existing block that builds `coveredPRs` and `coveredBranches`. After the `for (const s of activeSessions)` loop, add:

```typescript
// Prune dead-agent sessions from covered sets so they become "uncovered".
// Sessions with agentDead=true are still in the session list but have no live
// tmux session — they block backfill from noticing their PRs.
for (const session of activeSessions) {
  if (TERMINAL_STATUSES.has(session.status)) continue;
  if (!session.runtimeHandle) continue; // non-tmux runtime — skip
  const live = await hasSession(session.runtimeHandle.id).catch(() => true);
  if (!live) {
    if (session.pr?.number) coveredPRs.delete(session.pr.number);
    if (session.branch) coveredBranches.delete(session.branch);
  }
}
```

**Important:** `session.runtimeHandle.id` is the tmux session name — verify this matches what `tmux.ts` `hasSession` expects. If the runtime handle uses a different field, adjust accordingly. Check `packages/core/src/types.ts` for `RuntimeHandle` type definition.

- [ ] **Step 5: Add CR context fetch after filtering uncovered PRs**

After the `if (uncovered.length === 0) return false;` block, add:

```typescript
// Fetch reviewDecision for each uncovered PR to identify CHANGES_REQUESTED ones.
const prReviewDecisions = await Promise.allSettled(
  uncovered.map(async (pr) => {
    const decision = await scm!.getReviewDecision(pr);
    return { pr, decision };
  }),
);

// Separate CHANGES_REQUESTED from others.
// Fail-open: if getReviewDecision fails, treat as non-CHANGES_REQUESTED.
const crPRs: typeof uncovered = [];
const nonCrUncovered: typeof uncovered = [];
for (const result of prReviewDecisions) {
  if (result.status === "fulfilled" && result.value.decision === "changes_requested") {
    crPRs.push(result.value.pr);
  } else {
    // Take the first matching uncovered PR in document order
    const found = uncovered.find((p) =>
      result.status === "fulfilled" ? p.number === result.value.pr.number : p.number === uncovered[nonCrUncovered.length + crPRs.length]?.number
    );
    if (found) nonCrUncovered.push(found);
  }
}

// Fetch CR review body for each CHANGES_REQUESTED PR.
// Fail-open: if getReviews fails, proceed without context.
const crContextMap = new Map<number, string>();
for (const pr of crPRs) {
  try {
    const reviews = await scm!.getReviews(pr);
    const sorted = [...reviews]
      .filter((r) => String(r.author ?? "").endsWith("coderabbitai[bot]"))
      .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
    const crReview = sorted.find((r) => r.state === "changes_requested");
    if (crReview?.body) {
      crContextMap.set(pr.number, crReview.body);
    }
  } catch {
    // No CR reviews — proceed without context
  }
}

// Prioritize CHANGES_REQUESTED PRs (with context first), then others.
const sortedUncovered = [
  ...crPRs.filter((pr) => crContextMap.has(pr.number)),
  ...crPRs.filter((pr) => !crContextMap.has(pr.number)),
  ...nonCrUncovered,
];
```

**Note:** The logic above is complex — a simpler approach is to keep `uncovered` as-is, iterate it once, fetch `getReviewDecision` for each, and build the context map inline:

```typescript
// Simpler approach: iterate uncovered once, fetch decision + context
let crRespawnIdx = 0; // tracks which CR-PR we're on in sorted order

for (const pr of uncovered) {
  let decision = "pending";
  let crBody: string | undefined;

  try {
    decision = await scm!.getReviewDecision(pr);
  } catch { /* fail-open */ }

  if (decision === "changes_requested") {
    // Check rate-limit before fetching CR context
    if (crRespawnIdx >= MAX_CHANGES_REQUESTED_RESPAWNS_PER_CYCLE) {
      crRespawnIdx++;
      continue; // skip this CR-PR, rate-limited
    }

    try {
      const reviews = await scm!.getReviews(pr);
      const sorted = [...reviews]
        .filter((r) => String(r.author ?? "").endsWith("coderabbitai[bot]"))
        .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
      crBody = sorted.find((r) => r.state === "changes_requested")?.body;
    } catch { /* fail-open */ }
  }

  // Build spawn prompt
  let prompt: string;
  if (decision === "changes_requested" && crBody) {
    prompt = `CodeRabbit posted CHANGES_REQUESTED on PR #${pr.number} (${pr.url}).
The review comments are:
---
${crBody}
---
Fix exactly these items, commit with [agento], and push.`;
  } else {
    const escapedTitle = pr.title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    prompt = `Continue working on PR #${pr.number}: [PR title: "${escapedTitle}"]. Check PR status, fix any blockers (CI failures, review comments, merge conflicts), and drive it to 6-green.`;
  }

  // ... spawn logic (existing) ...
  crRespawnIdx++;
}
```

Use the simpler inline approach — it's easier to test and less error-prone.

- [ ] **Step 6: Wire the new prompt into the spawn call**

In the existing spawn block (around line 143), replace the hardcoded prompt:

```typescript
// OLD (around line 147):
prompt: `Continue working on PR #${pr.number}: [PR title: "${escapedTitle}"]...`,
```

With the variable `prompt` built above.

- [ ] **Step 7: Run all tests**

Run: `pnpm --filter @jleechanorg/ao-core test -- backfill-extensions.test.ts -v`
Expected: PASS

If failures, debug and fix.

- [ ] **Step 8: Run full test suite**

Run: `pnpm --filter @jleechanorg/ao-core test`
Expected: PASS (no regressions)

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/backfill-extensions.ts packages/core/src/__tests__/backfill-extensions.test.ts
git commit -m "$(cat <<'EOF'
feat(lifecycle): backfill spawns workers for dead-agent CHANGES_REQUESTED PRs

- Add tmux liveness pass to backfill: sessions whose tmux session is
  dead are pruned from the covered set, making their PRs "uncovered"
- Fetch CR review context (via getReviewDecision + getReviews) for each
  uncovered PR; inject the review body into the spawn prompt when
  CR posted CHANGES_REQUESTED
- Rate-limit: max 2 CHANGES_REQUESTED respawns per backfill cycle
- Fail-open throughout: tmux errors, API errors, no CR reviews — all
  fall back to generic prompt

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Verify types and linter

- [ ] **Step 1: Run TypeScript check**

Run: `pnpm --filter @jleechanorg/ao-core typecheck`
Expected: PASS (no type errors)

If errors, fix them.

- [ ] **Step 2: Run ESLint**

Run: `pnpm --filter @jleechanorg/ao-core lint`
Expected: PASS (no lint errors)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/backfill-extensions.ts packages/core/src/__tests__/backfill-extensions.test.ts
git commit -m "$(cat <<'EOF'
chore: typecheck + lint fixes

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Push and create PR

- [ ] **Step 1: Push branch**

Run: `git push origin feat/orch-bxf`

- [ ] **Step 2: Create PR**

Run:
```bash
gh pr create --repo jleechanorg/agent-orchestrator \
  --title "feat(lifecycle): backfill spawns workers for dead-agent CHANGES_REQUESTED PRs" \
  --body "$(cat <<'EOF'
## Summary
- Tmux liveness pass in backfill: dead-agent sessions pruned from covered set
- CR review context injected into spawn prompt for CHANGES_REQUESTED PRs
- Rate-limit: max 2 CR respawns per backfill cycle

## Test plan
- [x] Unit tests for tmux liveness behavior
- [x] Unit tests for CR context injection
- [x] Unit tests for rate-limit
- [x] pnpm test passes

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Verification Checklist

- [ ] `pnpm --filter @jleechanorg/ao-core test` passes
- [ ] `pnpm --filter @jleechanorg/ao-core typecheck` passes
- [ ] `pnpm --filter @jleechanorg/ao-core lint` passes
- [ ] PR created against `jleechanorg/agent-orchestrator`
- [ ] CI passes
