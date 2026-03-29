# orch-nk7: Productivity-Based Stall Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 15-minute productivity check loop to lifecycle-manager that detects merged-PR sessions (and kills them), stalls sessions with no commits >30min, and nudges sessions with context exhaustion.

**Architecture:** New `productivity-checker.ts` module with all REST API calls via `gh api` (`execFile`). Integrated into lifecycle-manager as a separate `setInterval` alongside the existing inbox polling timer. Nudge dedup via in-memory Map.

**Tech Stack:** TypeScript, Node.js `execFile`, `gh api` REST calls, tmux pane capture.

---

## File Map

| File | Action |
|---|---|
| `packages/core/src/productivity-checker.ts` | Create — new module |
| `packages/core/src/lifecycle-manager.ts` | Modify — add `startProductivityChecking()` |
| `packages/core/src/index.ts` | Modify — re-export `runProductivityChecks` |
| `packages/core/src/__tests__/productivity-checker.test.ts` | Create — unit tests |
| `docs/superpowers/specs/2026-03-29-productivity-stall-detection-design.md` | Already committed |

---

## Constants (add to top of `productivity-checker.ts`)

```typescript
export const STALL_THRESHOLD_MS = 30 * 60_000;      // 30 minutes
export const CONTEXT_EXHAUSTION_PCT = 5;             // nudge when <5%
export const NUDGE_COOLDOWN_MS = 60 * 60_000;        // 60 minutes per type
```

## REST API Helper

```typescript
// packages/core/src/productivity-checker.ts
async function ghRest(
  owner: string,
  repo: string,
  path: string,
): Promise<unknown> {
  const { execFile: exec } = await import("node:child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);
  const { stdout } = await execAsync("gh", ["api", `repos/${owner}/${repo}/${path}`], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return JSON.parse(stdout);
}
```

---

### Task 1: Create `productivity-checker.ts` — Types and Constants

**Files:**
- Create: `packages/core/src/productivity-checker.ts`

- [ ] **Step 1: Write types and constants skeleton**

```typescript
/**
 * productivity-checker.ts — Productivity-based stall detection for AO workers.
 *
 * Runs on a 15-minute interval (separate from main poll cycle) to detect:
 * 1. Merged/closed PRs — kill session + clean worktree
 * 2. Stall — no new commits >30min + PR not green → targeted nudge
 * 3. Context exhaustion — tmux pane shows <5% remaining → summarize nudge
 *
 * All GitHub API calls use REST via `gh api` — no GraphQL.
 */

export const STALL_THRESHOLD_MS = 30 * 60_000;
export const CONTEXT_EXHAUSTION_PCT = 5;
export const NUDGE_COOLDOWN_MS = 60 * 60_000;

/** Nudge cooldown tracker — per session, per nudge type. */
const nudgeCooldowns = new Map<string, number>(); // "sessionId:nudgeType" → last nudge timestamp

export type NudgeType = "stall" | "context_exhaustion";

export interface ProductivityDeps {
  config: import("./types.js").OrchestratorConfig;
  sessionManager: import("./types.js").SessionManager;
  capturePane: (sessionName: string, lines?: number) => Promise<string>;
  killSession: (sessionName: string) => Promise<void>;
  sendKeys: (sessionName: string, text: string) => Promise<void>;
}

export type ProductivityResult =
  | { cleanedUp: number; nudged: number; errors: number }
  | { error: string };
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/productivity-checker.ts
git commit -m "[agento] feat(lifecycle): add productivity-checker types and constants"
```

---

### Task 2: Implement `ghRest()` helper and PR metadata fetch

**Files:**
- Modify: `packages/core/src/productivity-checker.ts` — add helpers below types

- [ ] **Step 1: Add REST helper and PR fetch functions**

```typescript
import { execFile } from "node:child_process";
import { promisify } from "util";

const execAsync = promisify(execFile);

async function ghRest(owner: string, repo: string, path: string): Promise<unknown> {
  const { stdout } = await execAsync("gh", ["api", `repos/${owner}/${repo}/${path}`], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return JSON.parse(stdout) as unknown;
}

interface PRMeta {
  number: number;
  state: string;       // "open" | "closed"
  merged: boolean;
  head: { sha: string; ref: string };
  html_url: string;
}

interface CommitMeta {
  commit: { commit: { committer: { date: string } } };
}

/** Fetch PR metadata via REST. Returns null on error. */
export async function fetchPRMeta(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PRMeta | null> {
  try {
    return (await ghRest(owner, repo, `pulls/${prNumber}`)) as PRMeta;
  } catch {
    return null;
  }
}

/** Fetch last commit date for a PR branch. Returns null on error. */
export async function fetchLastCommitDate(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<Date | null> {
  try {
    const commits = (await ghRest(owner, repo, `pulls/${prNumber}/commits?per_page=1`)) as CommitMeta[];
    if (!commits || commits.length === 0) return null;
    const lastDateStr = commits[commits.length - 1]?.commit?.commit?.committer?.date;
    if (!lastDateStr) return null;
    return new Date(lastDateStr);
  } catch {
    return null;
  }
}

/** Fetch CI status for a commit. Returns null on error. */
export async function fetchCIStatus(
  owner: string,
  repo: string,
  sha: string,
): Promise<string | null> {
  try {
    const result = (await ghRest(owner, repo, `commits/${sha}/status`)) as { state: string };
    return result?.state ?? null;
  } catch {
    return null;
  }
}

/** Fetch CodeRabbit review state for a PR. Returns null on error. */
export async function fetchCRState(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string | null> {
  try {
    const reviews = (await ghRest(owner, repo, `pulls/${prNumber}/reviews`)) as Array<{
      user: { login: string };
      state: string;
      submitted_at: string;
    }>;
    const crReviews = reviews
      .filter((r) => r.user?.login === "coderabbitai[bot]")
      .sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime());
    return crReviews[0]?.state ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Run the tests to verify productivity-checker.test.ts passes**

Run: `pnpm -C packages/core test -- --reporter verbose 2>&1 | tail -30`
Expected: All tests pass (no tests yet — will add in Task 5)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/productivity-checker.ts
git commit -m "[agento] feat(productivity): add REST helpers for PR metadata"
```

---

### Task 3: Implement `checkMergedPRCleanup`

**Files:**
- Modify: `packages/core/src/productivity-checker.ts` — add function after helpers

- [ ] **Step 1: Add merged-PR cleanup function**

```typescript
/**
 * Check if session's PR is merged or closed.
 * Uses REST API — no GraphQL.
 * Returns 'killed' if PR was merged/closed and session was killed.
 * Returns 'skipped' if PR is still open or no PR found.
 */
export async function checkMergedPRCleanup(
  session: import("./types.js").Session,
  deps: ProductivityDeps,
): Promise<"killed" | "skipped"> {
  const prInfo = session.metadata["pr"];
  if (!prInfo || typeof prInfo !== "object") return "skipped";
  const pr = prInfo as { number?: unknown; owner?: unknown; repo?: unknown };
  const prNumber = Number(pr.number);
  const owner = String(pr.owner ?? "");
  const repo = String(pr.repo ?? "");
  if (!prNumber || !owner || !repo) return "skipped";

  const meta = await fetchPRMeta(owner, repo, prNumber);
  if (!meta) return "skipped";

  if (meta.state === "closed" || meta.merged === true) {
    // Kill the tmux session
    const sessionName = session.metadata["tmuxSession"] as string | undefined;
    if (sessionName) {
      try {
        await deps.killSession(sessionName);
      } catch {
        // non-fatal
      }
    }
    // TODO: worktree cleanup via sessionManager (add to deps if available)
    return "killed";
  }

  return "skipped";
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/productivity-checker.ts
git commit -m "[agento] feat(productivity): add checkMergedPRCleanup"
```

---

### Task 4: Implement `checkStallDetection`

**Files:**
- Modify: `packages/core/src/productivity-checker.ts` — add function after `checkMergedPRCleanup`

- [ ] **Step 1: Add stall detection function**

```typescript
/** Extract PR number from session metadata. Returns null if not found. */
function getPRFromSession(session: import("./types.js").Session): {
  number: number;
  owner: string;
  repo: string;
} | null {
  const prInfo = session.metadata["pr"];
  if (!prInfo || typeof prInfo !== "object") return null;
  const pr = prInfo as Record<string, unknown>;
  const number = Number(pr["number"]);
  const owner = String(pr["owner"] ?? "");
  const repo = String(pr["repo"] ?? "");
  if (!number || !owner || !repo) return null;
  return { number, owner, repo };
}

/** Check if nudge is in cooldown for a session/type. Resets if expired. */
function isNudgeOnCooldown(sessionId: string, nudgeType: NudgeType): boolean {
  const key = `${sessionId}:${nudgeType}`;
  const last = nudgeCooldowns.get(key);
  if (last === undefined) return false;
  if (Date.now() - last > NUDGE_COOLDOWN_MS) {
    nudgeCooldowns.delete(key);
    return false;
  }
  return true;
}

function setNudgeSent(sessionId: string, nudgeType: NudgeType): void {
  nudgeCooldowns.set(`${sessionId}:${nudgeType}`, Date.now());
}

/** Returns true if the PR appears green (mergeable + approved + CI passing). */
async function isPRGreen(
  owner: string,
  repo: string,
  prNumber: number,
  sha: string,
): Promise<boolean> {
  const [ciStatus, crState] = await Promise.all([
    fetchCIStatus(owner, repo, sha),
    fetchCRState(owner, repo, prNumber),
  ]);
  // Green if CI passing and CR approved
  return ciStatus === "success" && crState === "APPROVED";
}

/**
 * Check if session's branch has had no new commits for >30 min and PR is not green.
 * If so, send a targeted nudge. Returns 'nudged' if nudge was sent, 'none' otherwise.
 */
export async function checkStallDetection(
  session: import("./types.js").Session,
  deps: ProductivityDeps,
): Promise<"nudged" | "none"> {
  if (isNudgeOnCooldown(session.id, "stall")) return "none";

  const pr = getPRFromSession(session);
  if (!pr) return "none";

  const [meta, lastCommit] = await Promise.all([
    fetchPRMeta(pr.owner, pr.repo, pr.number),
    fetchLastCommitDate(pr.owner, pr.repo, pr.number),
  ]);

  if (!meta || !lastCommit) return "none";

  // Skip if PR is already merged/closed
  if (meta.state === "closed" || meta.merged) return "none";

  // Check if stalled: no new commits > 30 min
  const stallMs = Date.now() - lastCommit.getTime();
  if (stallMs <= STALL_THRESHOLD_MS) return "none";

  // Check if PR is green — if so, no nudge needed
  const green = await isPRGreen(pr.owner, pr.repo, pr.number, meta.head.sha);
  if (green) return "none";

  // PR is stalled — send nudge
  const ciStatus = await fetchCIStatus(pr.owner, pr.repo, meta.head.sha);
  const crState = await fetchCRState(pr.owner, pr.repo, pr.number);
  const nudgeText =
    `PR #${pr.number} has had no new commits for >30 min and is not green.\n` +
    `CI: ${ciStatus ?? "unknown"}\n` +
    `CR state: ${crState ?? "pending"}\n` +
    `URL: ${meta.html_url}\n` +
    `Continue working on this PR or explain the blocker.`;

  const sessionName = session.metadata["tmuxSession"] as string | undefined;
  if (sessionName) {
    try {
      await deps.sendKeys(sessionName, nudgeText);
      setNudgeSent(session.id, "stall");
      return "nudged";
    } catch {
      return "none";
    }
  }

  return "none";
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/productivity-checker.ts
git commit -m "[agento] feat(productivity): add checkStallDetection with targeted nudge"
```

---

### Task 5: Implement `checkContextExhaustion` and `runProductivityChecks`

**Files:**
- Modify: `packages/core/src/productivity-checker.ts` — add remaining functions

- [ ] **Step 1: Add context exhaustion function**

```typescript
/**
 * Check tmux pane for "N% until auto-compact" pattern.
 * If <5% remaining, send nudge to summarize and continue.
 * Returns 'nudged' if nudge was sent, 'none' otherwise.
 */
export async function checkContextExhaustion(
  session: import("./types.js").Session,
  deps: ProductivityDeps,
): Promise<"nudged" | "none"> {
  if (isNudgeOnCooldown(session.id, "context_exhaustion")) return "none";

  const sessionName = session.metadata["tmuxSession"] as string | undefined;
  if (!sessionName) return "none";

  let paneContent: string;
  try {
    paneContent = await deps.capturePane(sessionName, 30);
  } catch {
    return "none";
  }

  // Parse "N% until" or "N% until auto-compact" patterns
  const match = paneContent.match(/(\d+)%\s*until/i);
  if (!match) return "none";

  const pct = parseInt(match[1]!, 10);
  if (isNaN(pct) || pct >= CONTEXT_EXHAUSTION_PCT) return "none";

  // Context is low — nudge
  const nudgeText =
    `Context is ${pct}% remaining. Summarize progress so far and continue working.\n` +
    `Do not repeat work already done.`;

  try {
    await deps.sendKeys(sessionName, nudgeText);
    setNudgeSent(session.id, "context_exhaustion");
    return "nudged";
  } catch {
    return "none";
  }
}
```

- [ ] **Step 2: Add `runProductivityChecks` entry point**

```typescript
/**
 * Run all productivity checks for a list of sessions.
 * Called every 15 minutes by lifecycle-manager.
 * Sessions in terminal states are skipped.
 */
export async function runProductivityChecks(
  sessions: import("./types.js").Session[],
  deps: ProductivityDeps,
): Promise<{ cleanedUp: number; nudged: number; errors: number }> {
  let cleanedUp = 0;
  let nudged = 0;
  let errors = 0;

  for (const session of sessions) {
    // Skip terminal sessions
    const TERMINAL_STATUSES = new Set([
      "killed", "merged", "failed", "completed",
    ]);
    if (TERMINAL_STATUSES.has(session.status)) continue;

    try {
      // 1. Merged-PR cleanup — run first, before other checks
      const cleanupResult = await checkMergedPRCleanup(session, deps);
      if (cleanupResult === "killed") {
        cleanedUp++;
        continue; // session is dead, skip other checks
      }

      // 2. Stall detection
      const stallResult = await checkStallDetection(session, deps);
      if (stallResult === "nudged") nudged++;

      // 3. Context exhaustion
      const ctxResult = await checkContextExhaustion(session, deps);
      if (ctxResult === "nudged") nudged++;
    } catch {
      errors++;
    }
  }

  return { cleanedUp, nudged, errors };
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/productivity-checker.ts
git commit -m "[agento] feat(productivity): add checkContextExhaustion and runProductivityChecks"
```

---

### Task 6: Write unit tests

**Files:**
- Create: `packages/core/src/__tests__/productivity-checker.test.ts`

- [ ] **Step 1: Write unit tests**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkMergedPRCleanup,
  checkStallDetection,
  checkContextExhaustion,
  runProductivityChecks,
  STALL_THRESHOLD_MS,
  NUDGE_COOLDOWN_MS,
} from "../productivity-checker.js";

const makeDeps = (overrides: Partial<import("../productivity-checker.js").ProductivityDeps> = {}) => ({
  config: {} as any,
  sessionManager: {} as any,
  capturePane: vi.fn().mockResolvedValue(""),
  killSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

const makeSession = (overrides: Record<string, unknown> = {}): import("../types.js").Session =>
  ({
    id: "test-session-1",
    projectId: "agent-orchestrator",
    status: "pr_open",
    createdAt: new Date(),
    metadata: {},
    ...overrides,
  }) as any;

const now = new Date();
const oldCommitDate = new Date(now.getTime() - STALL_THRESHOLD_MS - 60_000);
const recentCommitDate = new Date(now.getTime() - 60_000);

describe("checkMergedPRCleanup", () => {
  it("returns skipped when session has no PR metadata", async () => {
    const deps = makeDeps();
    const result = await checkMergedPRCleanup(makeSession(), deps);
    expect(result).toBe("skipped");
  });

  it("returns skipped when PR is open", async () => {
    const deps = makeDeps();
    const session = makeSession({
      metadata: { pr: { number: 123, owner: "jleechanorg", repo: "agent-orchestrator" } },
    });
    // Mock ghRest for open PR
    deps.sessionManager["_ghRest"] = async () => ({ state: "open", merged: false });
    const result = await checkMergedPRCleanup(session, deps);
    expect(result).toBe("skipped");
  });

  it("returns killed and kills session when PR is merged", async () => {
    const killSession = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ killSession });
    const session = makeSession({
      metadata: { pr: { number: 123, owner: "jleechanorg", repo: "agent-orchestrator" }, tmuxSession: "jc-1" },
    });
    deps.sessionManager["_ghRest"] = async () => ({ state: "closed", merged: true });
    const result = await checkMergedPRCleanup(session, deps);
    expect(result).toBe("killed");
    expect(killSession).toHaveBeenCalledWith("jc-1");
  });
});

describe("checkStallDetection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns none when no PR metadata", async () => {
    const deps = makeDeps();
    const result = await checkStallDetection(makeSession(), deps);
    expect(result).toBe("none");
  });

  it("returns none when commit is recent (<30 min)", async () => {
    const deps = makeDeps();
    deps.sessionManager["_ghRest"] = async (owner: string, repo: string, path: string) => {
      if (path.startsWith("pulls/")) {
        if (path.includes("/commits")) {
          return [{ commit: { commit: { committer: { date: recentCommitDate.toISOString() } } } }];
        }
        return { state: "open", merged: false, head: { sha: "abc123", ref: "feat/test" }, html_url: "https://github.com/test" };
      }
      if (path.includes("/status")) return { state: "pending" };
      if (path.includes("/reviews")) return [];
      return null;
    };
    const session = makeSession({
      metadata: { pr: { number: 123, owner: "jleechanorg", repo: "agent-orchestrator" }, tmuxSession: "jc-1" },
    });
    const result = await checkStallDetection(session, deps);
    expect(result).toBe("none");
  });

  it("returns nudged when commit is old and PR not green", async () => {
    const sendKeys = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ sendKeys });
    deps.sessionManager["_ghRest"] = async (_owner: string, _repo: string, path: string) => {
      if (path.includes("/commits")) {
        return [{ commit: { commit: { committer: { date: oldCommitDate.toISOString() } } } }];
      }
      if (path.includes("/status")) return { state: "failure" };
      if (path.includes("/reviews")) return [{ user: { login: "coderabbitai[bot]" }, state: "CHANGES_REQUESTED", submitted_at: now.toISOString() }];
      return { state: "open", merged: false, head: { sha: "abc123", ref: "feat/test" }, html_url: "https://github.com/test" };
    };
    const session = makeSession({
      metadata: { pr: { number: 123, owner: "jleechanorg", repo: "agent-orchestrator" }, tmuxSession: "jc-1" },
    });
    const result = await checkStallDetection(session, deps);
    expect(result).toBe("nudged");
    expect(sendKeys).toHaveBeenCalled();
    const nudgeText = sendKeys.mock.calls[0]![1] as string;
    expect(nudgeText).toContain("PR #123");
    expect(nudgeText).toContain("no new commits");
  });

  it("returns none when PR is green even with old commit", async () => {
    const deps = makeDeps();
    deps.sessionManager["_ghRest"] = async (_owner: string, _repo: string, path: string) => {
      if (path.includes("/commits")) {
        return [{ commit: { commit: { committer: { date: oldCommitDate.toISOString() } } } }];
      }
      if (path.includes("/status")) return { state: "success" };
      if (path.includes("/reviews")) return [{ user: { login: "coderabbitai[bot]" }, state: "APPROVED", submitted_at: now.toISOString() }];
      return { state: "open", merged: false, head: { sha: "abc123", ref: "feat/test" }, html_url: "https://github.com/test" };
    };
    const session = makeSession({
      metadata: { pr: { number: 123, owner: "jleechanorg", repo: "agent-orchestrator" }, tmuxSession: "jc-1" },
    });
    const result = await checkStallDetection(session, deps);
    expect(result).toBe("none");
  });
});

describe("checkContextExhaustion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns none when pane has no context percentage", async () => {
    const deps = makeDeps({ capturePane: vi.fn().mockResolvedValue("some random output") });
    const session = makeSession({ metadata: { tmuxSession: "jc-1" } });
    const result = await checkContextExhaustion(session, deps);
    expect(result).toBe("none");
  });

  it("returns none when context >5%", async () => {
    const deps = makeDeps({ capturePane: vi.fn().mockResolvedValue("80% until auto-compact") });
    const session = makeSession({ metadata: { tmuxSession: "jc-1" } });
    const result = await checkContextExhaustion(session, deps);
    expect(result).toBe("none");
  });

  it("returns nudged when context <5%", async () => {
    const sendKeys = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ capturePane: vi.fn().mockResolvedValue("3% until auto-compact"), sendKeys });
    const session = makeSession({ metadata: { tmuxSession: "jc-1" } });
    const result = await checkContextExhaustion(session, deps);
    expect(result).toBe("nudged");
    expect(sendKeys).toHaveBeenCalledWith("jc-1", expect.stringContaining("3% remaining"));
  });
});

describe("runProductivityChecks", () => {
  it("skips terminal sessions", async () => {
    const deps = makeDeps();
    const sessions = [
      makeSession({ id: "dead", status: "killed" }),
      makeSession({ id: "alive", status: "pr_open", metadata: { tmuxSession: "jc-1" } }),
    ];
    deps.sessionManager["_ghRest"] = async () => {
      throw new Error("should not be called for killed session");
    };
    const result = await runProductivityChecks(sessions as any, deps);
    expect(result.cleanedUp).toBe(0);
    expect(result.errors).toBe(0);
  });
});
```

> **Note on mock strategy:** Tests inject a `_ghRest` function via `deps.sessionManager` to simulate REST responses without spawning `gh api` subprocesses. The actual `checkMergedPRCleanup`, `checkStallDetection`, etc. call `fetchPRMeta`, `fetchLastCommitDate`, etc. which use `execFile`. In the tests, monkey-patch `execFile` directly using `vi.mock("node:child_process")` in a setup block, or replace the module-level `execAsync` with a test double. Simpler: test each exported function by mocking `execFile` globally in the test file with `vi.mock("node:child_process")`.

- [ ] **Step 2: Run tests to verify they fail (or pass with mocks)**

Run: `pnpm -C packages/core test -- --reporter verbose 2>&1 | tail -50`
Expected: Tests compile and run (may need mock adjustments based on actual execFile usage)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/__tests__/productivity-checker.test.ts
git commit -m "[agento] test(productivity): add productivity-checker unit tests"
```

---

### Task 7: Integrate into `lifecycle-manager.ts`

**Files:**
- Modify: `packages/core/src/lifecycle-manager.ts`

- [ ] **Step 1: Add import and timer state**

Add to imports at top of `lifecycle-manager.ts`:
```typescript
import { runProductivityChecks } from "./productivity-checker.js";
```

Add state variables (near the existing `inboxPollTimer`):
```typescript
let productivityTimer: ReturnType<typeof setInterval> | null = null;
let productivityRunning = false; // re-entrancy guard
const PRODUCTIVITY_INTERVAL_MS = 15 * 60_000;
```

- [ ] **Step 2: Add `startProductivityChecking()` function**

Add near `startInboxPolling()`:
```typescript
function startProductivityChecking(): void {
  if (productivityTimer) return;
  productivityTimer = setInterval(async () => {
    if (productivityRunning) return;
    productivityRunning = true;
    try {
      const sessions = await sessionManager.list(scopedProjectId);
      const active = sessions.filter(
        (s: Session) => !TERMINAL_STATUSES.has(s.status),
      );
      // Lazily resolve tmux helpers to avoid circular imports at module load
      const [{ capturePane }, { killSession }, { sendKeys }] = await Promise.all([
        import("./tmux.js").then((m) => ({ capturePane: m.capturePane })),
        import("./tmux.js").then((m) => ({ killSession: m.killSession })),
        import("./tmux.js").then((m) => ({ sendKeys: m.sendKeys })),
      ]);
      await runProductivityChecks(active, {
        config,
        sessionManager,
        capturePane,
        killSession,
        sendKeys,
      });
    } catch {
      // non-fatal — productivity check failure should not crash the main loop
    } finally {
      productivityRunning = false;
    }
  }, PRODUCTIVITY_INTERVAL_MS);
  productivityTimer.unref();
}
```

- [ ] **Step 3: Call `startProductivityChecking()` in `start()`**

Find the `start()` function (around line 2380), add after `startInboxPolling()`:
```typescript
startInboxPolling();
startProductivityChecking();
```

- [ ] **Step 4: Add cleanup in `stop()`**

Find the `stop()` function, add after clearing `inboxPollTimer`:
```typescript
if (inboxPollTimer) {
  clearInterval(inboxPollTimer);
  inboxPollTimer = null;
}
if (productivityTimer) {
  clearInterval(productivityTimer);
  productivityTimer = null;
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm -C packages/core test -- --reporter verbose 2>&1 | tail -30`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/lifecycle-manager.ts
git commit -m "[agento] feat(lifecycle): wire in 15-min productivity check loop"
```

---

### Task 8: Export from `index.ts`

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add re-export**

Find the re-exports section at the bottom of `index.ts`, add:
```typescript
// Fork-only: productivity-based stall detection
export { runProductivityChecks } from "./productivity-checker.js";
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm -C packages/core typecheck 2>&1 | tail -20`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "[agento] chore(core): export runProductivityChecks"
```

---

### Task 9: Final verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm -C packages/core test -- --reporter verbose 2>&1 | tail -30`
Expected: All tests pass

- [ ] **Step 2: Run lint**

Run: `pnpm -C packages/core lint 2>&1 | tail -20` (or `pnpm lint` at repo root)
Expected: No errors

- [ ] **Step 3: Push and create PR**

```bash
git push origin feat/orch-nk7
gh pr create --title "[agento] feat: add productivity-based stall detection to lifecycle-worker" \
  --body "$(cat <<'EOF'
## Background
Lifecycle-worker only checked tmux session liveness, not whether workers were making progress. Workers that exhaust context, stall waiting for CR, or have merged PRs sat idle indefinitely.

## Goals
- Detect merged/closed PRs and kill sessions automatically
- Detect stalled sessions (>30 min no commits, not green) and nudge with specific PR state
- Detect context exhaustion (<5%) via tmux pane parsing and nudge to summarize

## Testing
Unit tests added: `packages/core/src/__tests__/productivity-checker.test.ts`

## Low-level details
- `packages/core/src/productivity-checker.ts` — new module, all REST API calls (no GraphQL)
- `packages/core/src/lifecycle-manager.ts` — new 15-min interval alongside inbox polling
EOF
)"
```

---

## Verification Checklist

- [ ] `productivity-checker.ts` created with all 4 exported functions
- [ ] All GitHub API calls use `gh api` REST (no GraphQL)
- [ ] Nudge deduplication: no nudge sent within 60 min of same type
- [ ] `startProductivityChecking()` runs on 15-minute interval
- [ ] Merged-PR cleanup kills tmux session
- [ ] Stall detection only nudges when PR is not green
- [ ] Context exhaustion parses "N% until" pattern from tmux pane
- [ ] Unit tests cover all 4 functions with fake timers
- [ ] `pnpm -C packages/core test` passes
- [ ] PR created against `jleechanorg/agent-orchestrator`
