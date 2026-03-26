/**
 * stuck-worker-detector.ts — Detect and remediate stuck AO workers in tmux sessions.
 *
 * Problem: `tmux has-session` returns true even when the agent CLI has exited because
 * the parent bash shell stays alive. Workers can be stuck waiting for user feedback or
 * have exited without creating PRs, causing monitoring loops to log idle forever.
 *
 * Solution: After 3+ consecutive idle poll cycles with no new PRs, capture pane content
 * via `tmux capture-pane` and analyze it:
 *  - Shell prompt visible + no Unicode activity indicators → agent exited → kill session
 *  - "Waiting for user feedback" or permission prompts → stuck → send nudge
 *  - "Exiting" or goodbye → done → kill session
 *  - Activity indicators present → agent still working → no action
 *
 * Fork-only logic — not upstreamed to ComposioHQ.
 */

// ─── Patterns ────────────────────────────────────────────────────────────────

/**
 * Shell prompt patterns indicating the agent CLI exited and bash took over.
 * Mirrors SHELL_PROMPT_PATTERNS from runtime-tmux/agent-liveness.ts.
 */
const SHELL_PROMPT_PATTERNS: RegExp[] = [
  /(?:^|[\s\w@~.-])\$\s*$/, // bash: "user@host:~/dir$ "
  /%\s*$/,                   // zsh: ends with "% "
  /❯\s*$/,                   // starship / oh-my-zsh: ends with "❯ "
  /(?:^|\s)>\s*$/,           // fish: space before "> "
  /#\s*$/,                   // root bash: ends with "# "
];

/**
 * Unicode tokens that indicate the agent CLI is alive and processing.
 * Mirrors AGENT_ALIVE_PATTERNS from runtime-tmux/agent-liveness.ts.
 */
const AGENT_ALIVE_PATTERNS: RegExp[] = [
  /✻/,  // Claude Code "thinking" spinner
  /✶/,  // Claude Code alternative spinner
  /✳/,  // Claude Code spinner variant
  /✽/,  // Claude Code spinner variant
  /✾/,  // Claude Code spinner variant
  /●/,  // Claude Code tool use / progress
  /◆/,  // Claude Code tool indicator
  /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/, // Braille spinner (codex / generic)
];

/** Patterns that indicate the agent is waiting for user input. */
const WAITING_PATTERNS: RegExp[] = [
  /Waiting for user/i,
  /Do you want to proceed\?/i,
  /\(Y\)es.*\(N\)o/i,
  /bypass.*permissions/i,
  /approval required/i,
  /\[y\/n\]/i,
  /\[yes\/no\]/i,
  /confirm\?/i,
];

/** Patterns that indicate the agent has finished and is exiting. */
const EXITING_PATTERNS: RegExp[] = [
  /^Exiting\b/im,
  /\bExiting\.\.\./i,
  /\bgoodbye\b/i,
  /session ended/i,
];

// ─── Types ───────────────────────────────────────────────────────────────────

export type StuckAction = "kill" | "nudge" | "none";

export interface StuckWorkerVerdict {
  action: StuckAction;
  reason: string;
  /** Text to send as a nudge when action is "nudge". */
  nudgeText?: string;
}

export interface IdleCycleState {
  /** Number of consecutive idle cycles with 0 new PRs. */
  count: number;
  /** Timestamp when the first idle cycle in the current run was recorded. */
  firstIdleAt: Date;
}

// ─── Idle cycle tracking ─────────────────────────────────────────────────────

/** Default number of idle cycles before deep pane inspection triggers. */
export const DEFAULT_IDLE_CYCLE_THRESHOLD = 3;

/** Default nudge message sent to agents waiting for input. */
export const DEFAULT_NUDGE_TEXT = "Continue working on the task. If you need clarification, describe what you need and proceed with your best judgment.";

/** Per-session idle cycle counters. Keyed by session ID. */
const idleCycles = new Map<string, IdleCycleState>();

/**
 * Record an idle cycle for a session. If the session produced new PRs,
 * the counter resets to 0.
 *
 * @returns The updated idle cycle count.
 */
export function recordIdleCycle(sessionId: string, hasNewPRs: boolean): number {
  if (hasNewPRs) {
    idleCycles.delete(sessionId);
    return 0;
  }
  const existing = idleCycles.get(sessionId);
  if (existing) {
    existing.count++;
    idleCycles.set(sessionId, existing);
    return existing.count;
  }
  const state: IdleCycleState = { count: 1, firstIdleAt: new Date() };
  idleCycles.set(sessionId, state);
  return 1;
}

/** Get the current idle cycle state for a session (or null if not tracked). */
export function getIdleCycleState(sessionId: string): IdleCycleState | null {
  return idleCycles.get(sessionId) ?? null;
}

/** Reset idle cycle counter for a session (e.g., after killing or nudging). */
export function resetIdleCycles(sessionId: string): void {
  idleCycles.delete(sessionId);
}

/** Clear all idle cycle counters (e.g., on lifecycle-manager restart). */
export function resetAllIdleCycles(): void {
  idleCycles.clear();
}

// ─── Pane analysis ───────────────────────────────────────────────────────────

/**
 * Analyze tmux pane content to determine if a worker is stuck and what action to take.
 *
 * Detection priority (order matters):
 *  1. Exiting patterns → kill (agent is done)
 *  2. Waiting/permission patterns → nudge (agent needs input)
 *  3. Shell prompt + no activity indicators → kill (agent CLI exited)
 *  4. Activity indicators present → none (agent is working)
 *  5. No conclusive signal → none (conservative default)
 */
export function analyzePaneContent(paneContent: string): StuckWorkerVerdict {
  const lines = paneContent.split("\n").filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    return { action: "kill", reason: "empty pane output — no agent activity" };
  }

  const lastLine = lines[lines.length - 1] ?? "";
  const recentLines = lines.slice(-10);
  const recentText = recentLines.join("\n");

  // 1. Check for exiting patterns (agent is done)
  for (const pattern of EXITING_PATTERNS) {
    if (pattern.test(recentText)) {
      return { action: "kill", reason: "agent has exited or is exiting" };
    }
  }

  // 2. Check for waiting/permission patterns (agent needs input)
  for (const pattern of WAITING_PATTERNS) {
    if (pattern.test(recentText)) {
      return {
        action: "nudge",
        reason: "agent waiting for user feedback or permission",
        nudgeText: DEFAULT_NUDGE_TEXT,
      };
    }
  }

  // 3. Check for shell prompt with no activity indicators
  const hasShellPrompt = SHELL_PROMPT_PATTERNS.some((p) => p.test(lastLine));
  const hasActivityIndicator = AGENT_ALIVE_PATTERNS.some((p) =>
    recentLines.some((l) => p.test(l)),
  );

  if (hasShellPrompt && !hasActivityIndicator) {
    return {
      action: "kill",
      reason: "agent CLI exited — shell prompt visible with no activity indicators",
    };
  }

  // 4. Activity indicators present — agent is working
  if (hasActivityIndicator) {
    return { action: "none", reason: "agent activity indicators detected — still working" };
  }

  // 5. Shell prompt with activity indicators — ambiguous, skip
  if (hasShellPrompt && hasActivityIndicator) {
    return {
      action: "none",
      reason: "shell prompt visible but activity indicators present — ambiguous state",
    };
  }

  // 6. No conclusive signal — conservative default
  return { action: "none", reason: "no conclusive stuck indicator — assuming agent is working" };
}

// ─── High-level API ──────────────────────────────────────────────────────────

export interface CheckStuckWorkerOptions {
  /** tmux session name */
  sessionName: string;
  /** Session ID (for idle cycle tracking) */
  sessionId: string;
  /** Whether the session produced new PRs in the latest cycle */
  hasNewPRs: boolean;
  /** Number of idle cycles before triggering deep inspection (default: 3) */
  idleCycleThreshold?: number;
  /**
   * Function to capture tmux pane content. Injectable for testing.
   * Signature: (sessionName: string, lines?: number) => Promise<string>
   */
  capturePane?: (sessionName: string, lines?: number) => Promise<string>;
  /**
   * Function to kill a tmux session. Injectable for testing.
   * Signature: (sessionName: string) => Promise<void>
   */
  killSession?: (sessionName: string) => Promise<void>;
  /**
   * Function to send keys to a tmux session. Injectable for testing.
   * Signature: (sessionName: string, text: string) => Promise<void>
   */
  sendKeys?: (sessionName: string, text: string) => Promise<void>;
}

export interface CheckStuckWorkerResult {
  /** Whether the idle cycle threshold was reached and deep inspection was performed. */
  inspected: boolean;
  /** The verdict from pane analysis (null if threshold not reached). */
  verdict: StuckWorkerVerdict | null;
  /** Whether an action was taken (kill or nudge). */
  actionTaken: boolean;
  /** Current idle cycle count after this check. */
  idleCycleCount: number;
}

/**
 * Check a worker session for stuck state and take appropriate action.
 *
 * Call this on each poll cycle. It tracks consecutive idle cycles internally
 * and only performs deep pane inspection after the threshold is reached.
 *
 * When the threshold is reached:
 *  - If agent exited: kills the tmux session
 *  - If agent waiting for input: sends a nudge message
 *  - If agent still working: no action
 *
 * @returns Result describing what was found and what action was taken.
 */
export async function checkStuckWorker(
  opts: CheckStuckWorkerOptions,
): Promise<CheckStuckWorkerResult> {
  const threshold = opts.idleCycleThreshold ?? DEFAULT_IDLE_CYCLE_THRESHOLD;
  const idleCycleCount = recordIdleCycle(opts.sessionId, opts.hasNewPRs);

  // Not enough idle cycles yet — skip deep inspection
  if (idleCycleCount < threshold) {
    return {
      inspected: false,
      verdict: null,
      actionTaken: false,
      idleCycleCount,
    };
  }

  // Threshold reached — capture pane and analyze
  const captureFn = opts.capturePane ?? (await loadDefaultCapture());
  let paneContent: string;
  try {
    paneContent = await captureFn(opts.sessionName, 30);
  } catch {
    // Can't capture pane — session may be dead
    resetIdleCycles(opts.sessionId);
    return {
      inspected: true,
      verdict: { action: "kill", reason: "failed to capture pane — session may be dead" },
      actionTaken: false,
      idleCycleCount,
    };
  }

  const verdict = analyzePaneContent(paneContent);

  let actionTaken = false;

  if (verdict.action === "kill" && opts.killSession) {
    try {
      await opts.killSession(opts.sessionName);
      actionTaken = true;
      resetIdleCycles(opts.sessionId);
    } catch {
      // Kill failed — session may already be dead
    }
  } else if (verdict.action === "nudge" && opts.sendKeys) {
    try {
      await opts.sendKeys(opts.sessionName, verdict.nudgeText ?? DEFAULT_NUDGE_TEXT);
      actionTaken = true;
      // Reset cycles after nudge so we wait another threshold before re-nudging
      resetIdleCycles(opts.sessionId);
    } catch {
      // Send failed — session may be dead
    }
  }

  return {
    inspected: true,
    verdict,
    actionTaken,
    idleCycleCount,
  };
}

/** Lazy-load the default capturePane from tmux.ts to avoid circular imports at module load. */
async function loadDefaultCapture(): Promise<(sessionName: string, lines?: number) => Promise<string>> {
  const { capturePane } = await import("./tmux.js");
  return capturePane;
}
