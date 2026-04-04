/**
 * stalled-worker-auditor.ts — AO worker that audits stalled workers and eloop coverage.
 *
 * Purpose:
 * 1. Detect stalled/stuck AO workers across all projects using stuck-worker-detector.ts
 * 2. Audit whether each stalled worker's project has agent-stuck reactions configured
 * 3. Alert when the eloop is NOT handling a stalled worker (gap between detection and remediation)
 *
 * Run via: ao spawn -- perl -e 'use FindBin; require "$FindBin::Bin/../src/stalled-worker-auditor.ts"'
 *
 * Or invoked from the lifecycle-manager poll loop as a periodic health check.
 */

import { capturePane, killSession, sendKeys, listSessions } from "./tmux.js";
import { parseTmuxName } from "./paths.js";
import {
  checkStuckWorker,
  recordIdleCycle,
  resetIdleCycles,
  analyzePaneContent,
  type StuckWorkerVerdict,
  DEFAULT_IDLE_CYCLE_THRESHOLD,
} from "./stuck-worker-detector.js";
import type { SessionManager, ProjectConfig } from "./types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StalledWorkerRecord {
  sessionId: string;
  tmuxName: string;
  projectId: string;
  projectPath: string;
  verdict: StuckWorkerVerdict;
  /** Whether the project's agent-stuck reaction is configured */
  hasEloopReaction: boolean;
  /** Whether the eloop is actively handling this stalled worker (reaction armed + threshold met) */
  eloopHandling: boolean;
  panePreview: string;
  ageMs: number;
}

export interface EloopCoverageReport {
  scannedAt: Date;
  totalSessions: number;
  aoManagedSessions: number;
  stalledWorkers: StalledWorkerRecord[];
  /** Sessions where eloop has no reaction configured */
  unhandledGaps: StalledWorkerRecord[];
  /** All workers checked */
  allRecords: StalledWorkerRecord[];
  projectsWithoutReaction: string[];
}

export interface StalledWorkerAuditorDeps {
  sessionManager: SessionManager;
  /** Map of projectId → ProjectConfig */
  projects: Map<string, ProjectConfig>;
  /** Threshold for idle cycles before calling a worker stalled (default: 3) */
  idleCycleThreshold?: number;
  /** Custom nudge text override */
  nudgeText?: string;
  /** Dry-run mode (default: false — only reports, doesn't act) */
  dryRun?: boolean;
  /** Log function */
  log?: (msg: string) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Check if a project has a live agent-stuck reaction configured.
 * A "live" reaction has auto=true and a valid threshold.
 */
function hasLiveAgentStuckReaction(project: ProjectConfig): boolean {
  const reaction = project.reactions?.["agent-stuck"];
  if (!reaction) return false;
  // Must be auto-enabled and have a threshold
  if (reaction.auto === false) return false;
  if (!reaction.threshold) return false;
  return true;
}

/**
 * Get a short preview of pane content (last 5 non-empty lines).
 */
function panePreview(content: string, maxLines = 5): string {
  const lines = content.split("\n").filter((l) => l.trim()).slice(-maxLines);
  return lines.join("\n");
}

// ─── Core auditor ─────────────────────────────────────────────────────────────

/**
 * Audit all AO-managed tmux sessions for stalled workers and eloop coverage.
 *
 * @param deps   - Dependency injection (sessionManager, projects, options)
 * @param hasNewPRsFn - (sessionId: string) => boolean — returns true if session produced new PRs
 *                      in the latest poll cycle. If omitted, always treats sessions as idle.
 * @returns EloopCoverageReport describing what was found
 */
export async function auditStalledWorkers(
  deps: StalledWorkerAuditorDeps,
  hasNewPRsFn?: (sessionId: string) => boolean,
): Promise<EloopCoverageReport> {
  const threshold = deps.idleCycleThreshold ?? DEFAULT_IDLE_CYCLE_THRESHOLD;
  const logFn = deps.log ?? ((_msg: string) => {});
  const dryRun = deps.dryRun ?? false;

  const allTmuxSessions = await listSessions();
  const now = new Date();

  const stalledWorkers: StalledWorkerRecord[] = [];
  const unhandledGaps: StalledWorkerRecord[] = [];
  const projectsWithoutReaction = new Set<string>();

  for (const tmuxSession of allTmuxSessions) {
    // Skip attached sessions (someone is using them)
    if (tmuxSession.attached) continue;

    // Try to parse as AO-managed session
    const parsed = parseTmuxName(tmuxSession.name);
    if (!parsed) continue;

    // Get the AO session from the session manager
    const sessionId = `${parsed.prefix}-${parsed.num}`;
    const session = await deps.sessionManager.get(sessionId);
    if (!session) {
      logFn(`[stalled-auditor] tmux session ${tmuxSession.name} not found in AO DB — skipping`);
      continue;
    }

    const project = deps.projects.get(session.projectId ?? "");
    const hasEloopReaction = project ? hasLiveAgentStuckReaction(project) : false;

    if (!hasEloopReaction && project) {
      projectsWithoutReaction.add(session.projectId ?? "");
    }

    // Determine if session produced new PRs in latest cycle
    const hasNewPRs = hasNewPRsFn ? hasNewPRsFn(sessionId) : false;

    // Use stuck-worker-detector to check if stalled
    const result = await checkStuckWorker({
      sessionName: tmuxSession.name,
      sessionId,
      hasNewPRs,
      idleCycleThreshold: threshold,
      capturePane,
      killSession: dryRun ? async () => {} : killSession,
      sendKeys: dryRun ? async () => {} : sendKeys,
    });

    // Capture pane preview for reporting (even if not yet at threshold)
    let preview = "";
    try {
      const content = await capturePane(tmuxSession.name, 30);
      preview = panePreview(content);
    } catch {
      preview = "(could not capture pane)";
    }

    // Compute session age
    const createdMs = session.createdAt
      ? now.getTime() - new Date(session.createdAt).getTime()
      : 0;

    if (result.inspected) {
      const record: StalledWorkerRecord = {
        sessionId,
        tmuxName: tmuxSession.name,
        projectId: session.projectId ?? "unknown",
        projectPath: project?.path ?? "unknown",
        verdict: result.verdict!,
        hasEloopReaction,
        eloopHandling: hasEloopReaction && result.actionTaken,
        panePreview: preview,
        ageMs: createdMs,
      };

      stalledWorkers.push(record);

      // Gap: stalled but eloop not handling it
      if (!hasEloopReaction || (!result.actionTaken && result.verdict?.action !== "none")) {
        unhandledGaps.push(record);
      }
    } else {
      // Not yet stalled — still record for completeness
      const verdict: StuckWorkerVerdict = {
        action: "none",
        reason: `idle cycle ${result.idleCycleCount}/${threshold} — not yet stalled`,
      };
      const record: StalledWorkerRecord = {
        sessionId,
        tmuxName: tmuxSession.name,
        projectId: session.projectId ?? "unknown",
        projectPath: project?.path ?? "unknown",
        verdict,
        hasEloopReaction,
        eloopHandling: false,
        panePreview: preview,
        ageMs: createdMs,
      };
      stalledWorkers.push(record);
    }
  }

  return {
    scannedAt: now,
    totalSessions: allTmuxSessions.length,
    aoManagedSessions: stalledWorkers.length,
    stalledWorkers: stalledWorkers.filter((r) => r.verdict.action !== "none"),
    unhandledGaps,
    allRecords: stalledWorkers,
    projectsWithoutReaction: Array.from(projectsWithoutReaction),
  };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/**
 * Format a coverage report as a human-readable string for Slack/MCP mail.
 */
export function formatEloopCoverageReport(report: EloopCoverageReport): string {
  const lines: string[] = [];

  lines.push(`## Stalled Worker Audit — ${report.scannedAt.toISOString()}`);
  lines.push("");
  lines.push(`**Scanned:** ${report.aoManagedSessions} AO-managed tmux sessions (of ${report.totalSessions} total)`);

  if (report.projectsWithoutReaction.length > 0) {
    lines.push(`**⚠️ Projects WITHOUT agent-stuck reaction:** ${report.projectsWithoutReaction.join(", ")}`);
  }

  const stalled = report.stalledWorkers;
  const gaps = report.unhandledGaps;

  if (stalled.length === 0) {
    lines.push("**✅ No stalled workers detected.**");
  } else {
    lines.push(`**🔴 Stalled workers: ${stalled.length}**`);
    for (const w of stalled) {
      const handling = w.eloopHandling ? "✅ eloop handling" : "⚠️ eloop NOT handling";
      const action = w.verdict.action === "kill" ? "🔴 kill" : w.verdict.action === "nudge" ? "🟡 nudge" : "❓ none";
      lines.push(`  - ${w.sessionId} (${w.projectId}) — ${action} — ${w.verdict.reason} — ${handling}`);
      if (w.panePreview) {
        lines.push(`    Last pane: ${w.panePreview.split("\n").slice(-2).join(" | ")}`);
      }
    }
  }

  if (gaps.length > 0) {
    lines.push("");
    lines.push(`**🚨 Eloop gaps: ${gaps.length} stalled workers NOT being handled**`);
    for (const g of gaps) {
      lines.push(`  - ${g.sessionId} (${g.projectId}) — ${g.verdict.action}: ${g.verdict.reason}`);
      if (!g.hasEloopReaction) {
        lines.push(`    → No agent-stuck reaction configured for project ${g.projectId}`);
      } else {
        lines.push(`    → Reaction configured but NOT actioned (check threshold settings)`);
      }
    }
  } else {
    lines.push("");
    lines.push("**✅ Eloop coverage complete — all stalled workers are being handled.**");
  }

  return lines.join("\n");
}

// ─── MCP mail helper ──────────────────────────────────────────────────────────

export interface SendMcpMailOptions {
  subject: string;
  body: string;
  projectKey?: string;
}

/**
 * Send an MCP mail alert. Injectable for testing.
 */
export type SendMcpMailFn = (opts: SendMcpMailOptions) => Promise<void>;

export async function sendGapAlert(
  report: EloopCoverageReport,
  sendMail: SendMcpMailFn,
): Promise<void> {
  if (report.unhandledGaps.length === 0) return;

  const body = formatEloopCoverageReport(report);
  await sendMail({
    subject: `[ALERT] Stalled worker gap — ${report.unhandledGaps.length} unhandled`,
    body,
    projectKey: "jleechanclaw",
  });
}

// ─── Run as standalone CLI ────────────────────────────────────────────────────

/**
 * Main entry point when run as a standalone AO worker:
 *   ao spawn -- node --loader tsx src/stalled-worker-auditor.ts
 *
 * Or from lifecycle-manager:
 *   import { runStalledWorkerAuditor } from "./stalled-worker-auditor.js";
 */
export async function runStalledWorkerAuditor(
  deps: StalledWorkerAuditorDeps,
  sendMail: SendMcpMailFn,
): Promise<EloopCoverageReport> {
  const logFn = deps.log ?? console.log;

  logFn("[stalled-auditor] Starting stalled worker audit...");

  const report = await auditStalledWorkers(deps);

  const summary = formatEloopCoverageReport(report);
  logFn("\n" + summary);

  // Alert on gaps
  if (report.unhandledGaps.length > 0) {
    logFn(`\n[stalled-auditor] 🚨 Sending gap alert for ${report.unhandledGaps.length} unhandled stalled workers...`);
    await sendGapAlert(report, sendMail);
  } else {
    logFn("\n[stalled-auditor] ✅ No gaps — eloop is handling all stalled workers.");
  }

  return report;
}
