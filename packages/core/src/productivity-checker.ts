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

import { execFile as _execFile } from "node:child_process";
import { promisify } from "util";
import type { OrchestratorConfig, Session } from "./types.js";

const execAsync = promisify(_execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const STALL_THRESHOLD_MS = 30 * 60_000;     // 30 minutes
export const CONTEXT_EXHAUSTION_PCT = 5;            // nudge when <5%
export const NUDGE_COOLDOWN_MS = 60 * 60_000;      // 60 minutes per nudge type

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NudgeType = "stall" | "context_exhaustion";

export interface ProductivityDeps {
  config: OrchestratorConfig;
  sessionManager: unknown; // SessionManager — used for future worktree cleanup
  capturePane: (sessionName: string, lines?: number) => Promise<string>;
  killSession: (sessionName: string) => Promise<void>;
  sendKeys: (sessionName: string, text: string) => Promise<void>;
  /**
   * Optional injectable for the REST API helper.
   * Allows tests to inject a fake without needing to mock node:child_process.
   * When omitted, the real `gh api` implementation is used.
   */
  ghRest?: (owner: string, repo: string, path: string) => Promise<unknown>;
}

export type ProductivityResult =
  | { cleanedUp: number; nudged: number; errors: number }
  | { error: string };

// ---------------------------------------------------------------------------
// Nudge cooldown tracking
// ---------------------------------------------------------------------------

/** Per-session, per-nudge-type cooldown. Key: "sessionId:nudgeType" → timestamp */
const nudgeCooldowns = new Map<string, number>();

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

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

/** Default ghRest — calls `gh api repos/{owner}/{repo}/{path}`. Injectable for testing. */
async function defaultGhRest(owner: string, repo: string, path: string): Promise<unknown> {
  const { stdout } = await execAsync(
    "gh",
    ["api", `repos/${owner}/${repo}/${path}`],
    { encoding: "utf8", timeout: 30_000 },
  );
  return JSON.parse(stdout) as unknown;
}

interface PRMeta {
  number: number;
  state: string;
  merged: boolean;
  head: { sha: string; ref: string };
  html_url: string;
}

interface CommitMeta {
  commit: { commit: { committer: { date: string } } };
}

interface CIStatusMeta {
  state: string;
}

interface ReviewMeta {
  user: { login: string };
  state: string;
  submitted_at: string;
}

/** Fetch PR metadata via REST. Returns null on error. */
export async function fetchPRMeta(
  owner: string,
  repo: string,
  prNumber: number,
  ghRest = defaultGhRest,
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
  ghRest = defaultGhRest,
): Promise<Date | null> {
  try {
    const commits = (await ghRest(
      owner,
      repo,
      `pulls/${prNumber}/commits?per_page=1`,
    )) as CommitMeta[];
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
  ghRest = defaultGhRest,
): Promise<string | null> {
  try {
    const result = (await ghRest(owner, repo, `commits/${sha}/status`)) as CIStatusMeta;
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
  ghRest = defaultGhRest,
): Promise<string | null> {
  try {
    const reviews = (await ghRest(owner, repo, `pulls/${prNumber}/reviews`)) as ReviewMeta[];
    const crReviews = reviews
      .filter((r) => r.user?.login === "coderabbitai[bot]")
      .sort(
        (a, b) =>
          new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime(),
      );
    return crReviews[0]?.state ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session PR metadata helpers
// ---------------------------------------------------------------------------

interface PRRef {
  number: number;
  owner: string;
  repo: string;
}

/** Extract PR ref from session metadata. Returns null if not found. */
function getPRFromSession(session: Session): PRRef | null {
  const prInfo = session.metadata["pr"];
  if (!prInfo || typeof prInfo !== "object") return null;
  const pr = prInfo as Record<string, unknown>;
  const number = Number(pr["number"]);
  const owner = String(pr["owner"] ?? "");
  const repo = String(pr["repo"] ?? "");
  if (!number || !owner || !repo) return null;
  return { number, owner, repo };
}

/** Returns true if PR is green (CI passing + CR APPROVED). */
async function isPRGreen(
  owner: string,
  repo: string,
  prNumber: number,
  sha: string,
  ghRest = defaultGhRest,
): Promise<boolean> {
  const [ciStatus, crState] = await Promise.all([
    fetchCIStatus(owner, repo, sha, ghRest),
    fetchCRState(owner, repo, prNumber, ghRest),
  ]);
  return ciStatus === "success" && crState === "APPROVED";
}

// ---------------------------------------------------------------------------
// Check functions
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(["killed", "merged", "failed", "completed"]);

/** Resolve ghRest from deps, falling back to the real implementation. */
function resolveGhRest(deps: ProductivityDeps) {
  return deps.ghRest ?? defaultGhRest;
}

/**
 * Check if session's PR is merged or closed.
 * Uses REST API — no GraphQL.
 * Returns 'killed' if PR was merged/closed and session was killed.
 * Returns 'skipped' if PR is still open or no PR found.
 */
export async function checkMergedPRCleanup(
  session: Session,
  deps: ProductivityDeps,
): Promise<"killed" | "skipped"> {
  const pr = getPRFromSession(session);
  if (!pr) return "skipped";
  const ghRest = resolveGhRest(deps);
  const meta = await fetchPRMeta(pr.owner, pr.repo, pr.number, ghRest);
  if (!meta) return "skipped";

  if (meta.state === "closed" || meta.merged === true) {
    const sessionName = session.metadata["tmuxSession"] as string | undefined;
    if (sessionName) {
      try {
        await deps.killSession(sessionName);
      } catch {
        // non-fatal
      }
    }
    return "killed";
  }

  return "skipped";
}

/**
 * Check if session's branch has had no new commits for >30 min and PR is not green.
 * If so, send a targeted nudge. Returns 'nudged' if nudge was sent, 'none' otherwise.
 */
export async function checkStallDetection(
  session: Session,
  deps: ProductivityDeps,
): Promise<"nudged" | "none"> {
  if (isNudgeOnCooldown(session.id, "stall")) return "none";
  if (TERMINAL_STATUSES.has(session.status)) return "none";

  const pr = getPRFromSession(session);
  if (!pr) return "none";

  const ghRest = resolveGhRest(deps);
  const [meta, lastCommit] = await Promise.all([
    fetchPRMeta(pr.owner, pr.repo, pr.number, ghRest),
    fetchLastCommitDate(pr.owner, pr.repo, pr.number, ghRest),
  ]);

  if (!meta || !lastCommit) return "none";
  if (meta.state === "closed" || meta.merged) return "none";

  const stallMs = Date.now() - lastCommit.getTime();
  if (stallMs <= STALL_THRESHOLD_MS) return "none";

  const green = await isPRGreen(pr.owner, pr.repo, pr.number, meta.head.sha, ghRest);
  if (green) return "none";

  const [ciStatus, crState] = await Promise.all([
    fetchCIStatus(pr.owner, pr.repo, meta.head.sha, ghRest),
    fetchCRState(pr.owner, pr.repo, pr.number, ghRest),
  ]);

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

/**
 * Check tmux pane for "N% until auto-compact" pattern.
 * If <5% remaining, send nudge to summarize and continue.
 * Returns 'nudged' if nudge was sent, 'none' otherwise.
 */
export async function checkContextExhaustion(
  session: Session,
  deps: ProductivityDeps,
): Promise<"nudged" | "none"> {
  if (isNudgeOnCooldown(session.id, "context_exhaustion")) return "none";
  if (TERMINAL_STATUSES.has(session.status)) return "none";

  const sessionName = session.metadata["tmuxSession"] as string | undefined;
  if (!sessionName) return "none";

  let paneContent: string;
  try {
    paneContent = await deps.capturePane(sessionName, 30);
  } catch {
    return "none";
  }

  const match = paneContent.match(/(\d+)%\s*until/i);
  if (!match) return "none";

  const pct = parseInt(match[1]!, 10);
  if (isNaN(pct) || pct >= CONTEXT_EXHAUSTION_PCT) return "none";

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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run all productivity checks for a list of sessions.
 * Called every 15 minutes by lifecycle-manager.
 * Terminal sessions are skipped.
 */
export async function runProductivityChecks(
  sessions: Session[],
  deps: ProductivityDeps,
): Promise<{ cleanedUp: number; nudged: number; errors: number }> {
  let cleanedUp = 0;
  let nudged = 0;
  let errors = 0;

  for (const session of sessions) {
    if (TERMINAL_STATUSES.has(session.status)) continue;

    try {
      // 1. Merged-PR cleanup — run first, before other checks
      const cleanupResult = await checkMergedPRCleanup(session, deps);
      if (cleanupResult === "killed") {
        cleanedUp++;
        continue; // session is dead, skip remaining checks
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
