import chalk from "chalk";
import type { Command } from "commander";
import {
  type Agent,
  type SCM,
  type OrchestratorConfig,
  type Session,
  type RuntimeHandle,
  type ProjectConfig,
  type PRInfo,
  type CIStatus,
  type ReviewDecision,
  type ActivityState,
  loadConfig,
  getSessionsDir,
} from "@composio/ao-core";
import { git, getTmuxSessions, getTmuxActivity } from "../lib/shell.js";
import { readMetadata } from "../lib/metadata.js";
import {
  banner,
  header,
  formatAge,
  activityIcon,
  ciStatusIcon,
  reviewDecisionIcon,
  padCol,
} from "../lib/format.js";
import { getAgent, getAgentByName, getSCM } from "../lib/plugins.js";
import { matchesPrefix } from "../lib/session-utils.js";

interface SessionInfo {
  name: string;
  branch: string | null;
  status: string | null;
  summary: string | null;
  claudeSummary: string | null;
  pr: string | null;
  prNumber: number | null;
  issue: string | null;
  lastActivity: string;
  project: string | null;
  ciStatus: CIStatus | null;
  reviewDecision: ReviewDecision | null;
  pendingThreads: number | null;
  activity: ActivityState | null;
}

/**
 * Build a minimal Session object for agent.getSessionInfo() and SCM.detectPR().
 * Only runtimeHandle and workspacePath are needed by the introspection logic.
 */
function buildSessionForIntrospect(
  sessionName: string,
  workspacePath?: string,
  branch?: string | null,
): Session {
  const handle: RuntimeHandle = {
    id: sessionName,
    runtimeName: "tmux",
    data: {},
  };
  return {
    id: sessionName,
    projectId: "",
    status: "working",
    activity: "idle",
    branch: branch ?? null,
    issueId: null,
    pr: null,
    workspacePath: workspacePath || null,
    runtimeHandle: handle,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
  };
}

async function gatherSessionInfo(
  sessionName: string,
  sessionDir: string,
  agent: Agent,
  scm: SCM,
  projectConfig: ProjectConfig,
): Promise<SessionInfo> {
  const metaFile = `${sessionDir}/${sessionName}`;
  const meta = readMetadata(metaFile);

  let branch = meta?.branch ?? null;
  const status = meta?.status ?? null;
  const summary = meta?.summary ?? null;
  const prUrl = meta?.pr ?? null;
  const issue = meta?.issue ?? null;
  const project = meta?.project ?? null;

  // Get live branch from worktree if available
  const worktree = meta?.worktree;
  if (worktree) {
    const liveBranch = await git(["branch", "--show-current"], worktree);
    if (liveBranch) branch = liveBranch;
  }

  // Get last activity time
  const activityTs = await getTmuxActivity(sessionName);
  const lastActivity = activityTs ? formatAge(activityTs) : "-";

  // Get agent's auto-generated summary and activity via introspection
  let claudeSummary: string | null = null;
  let activity: ActivityState | null = null;
  try {
    const session = buildSessionForIntrospect(sessionName, worktree, branch);
    const introspection = await agent.getSessionInfo(session);
    claudeSummary = introspection?.summary ?? null;

    // Detect activity from agent's last message type
    const msgType = introspection?.lastMessageType;
    if (msgType === "summary" || msgType === "assistant" || msgType === "result") {
      activity = "idle";
    } else if (msgType === "tool_use" || msgType === "user") {
      activity = "active";
    }
  } catch {
    // Introspection failed — not critical
  }

  // Fall back to metadata status for activity when introspection is unavailable
  if (activity === null && status) {
    const statusToActivity: Record<string, ActivityState> = {
      working: "active",
      idle: "idle",
      stuck: "blocked",
      errored: "blocked",
    };
    activity = statusToActivity[status] ?? null;
  }

  // Fetch PR, CI, and review data from SCM
  let prNumber: number | null = null;
  let ciStatus: CIStatus | null = null;
  let reviewDecision: ReviewDecision | null = null;
  let pendingThreads: number | null = null;

  // Extract PR number from metadata URL as fallback
  if (prUrl) {
    const prMatch = /\/pull\/(\d+)/.exec(prUrl);
    if (prMatch) {
      prNumber = parseInt(prMatch[1], 10);
    }
  }

  if (branch) {
    try {
      const session = buildSessionForIntrospect(sessionName, worktree, branch);
      const prInfo: PRInfo | null = await scm.detectPR(session, projectConfig);
      if (prInfo) {
        prNumber = prInfo.number;

        // Fetch CI, reviews, and threads in parallel
        const [ci, review, threads] = await Promise.all([
          scm.getCISummary(prInfo).catch(() => null),
          scm.getReviewDecision(prInfo).catch(() => null),
          scm.getPendingComments(prInfo).catch(() => null),
        ]);

        ciStatus = ci;
        reviewDecision = review;
        pendingThreads = threads !== null ? threads.length : null;
      }
    } catch {
      // SCM lookup failed — not critical, we still show what we have
    }
  }

  return {
    name: sessionName,
    branch,
    status,
    summary,
    claudeSummary,
    pr: prUrl,
    prNumber,
    issue,
    lastActivity,
    project,
    ciStatus,
    reviewDecision,
    pendingThreads,
    activity,
  };
}

// Column widths for the table
const COL = {
  session: 14,
  branch: 24,
  pr: 6,
  ci: 6,
  review: 6,
  threads: 4,
  activity: 9,
  age: 8,
};

function printTableHeader(): void {
  const hdr =
    padCol("Session", COL.session) +
    padCol("Branch", COL.branch) +
    padCol("PR", COL.pr) +
    padCol("CI", COL.ci) +
    padCol("Rev", COL.review) +
    padCol("Thr", COL.threads) +
    padCol("Activity", COL.activity) +
    "Age";
  console.log(chalk.dim(`  ${hdr}`));
  const totalWidth =
    COL.session + COL.branch + COL.pr + COL.ci + COL.review + COL.threads + COL.activity + 3;
  console.log(chalk.dim(`  ${"─".repeat(totalWidth)}`));
}

function printSessionRow(info: SessionInfo): void {
  const prStr = info.prNumber ? `#${info.prNumber}` : "-";

  const row =
    padCol(chalk.green(info.name), COL.session) +
    padCol(info.branch ? chalk.cyan(info.branch) : chalk.dim("-"), COL.branch) +
    padCol(info.prNumber ? chalk.blue(prStr) : chalk.dim(prStr), COL.pr) +
    padCol(ciStatusIcon(info.ciStatus), COL.ci) +
    padCol(reviewDecisionIcon(info.reviewDecision), COL.review) +
    padCol(
      info.pendingThreads !== null && info.pendingThreads > 0
        ? chalk.yellow(String(info.pendingThreads))
        : chalk.dim(info.pendingThreads !== null ? "0" : "-"),
      COL.threads,
    ) +
    padCol(activityIcon(info.activity), COL.activity) +
    chalk.dim(info.lastActivity);

  console.log(`  ${row}`);

  // Show summary on a second line if available
  const displaySummary = info.claudeSummary || info.summary;
  if (displaySummary) {
    console.log(`  ${" ".repeat(COL.session)}${chalk.dim(displaySummary.slice(0, 60))}`);
  }
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show all sessions with branch, activity, PR, and CI status")
    .option("-p, --project <id>", "Filter by project ID")
    .option("--json", "Output as JSON")
    .action(async (opts: { project?: string; json?: boolean }) => {
      let config: OrchestratorConfig;
      try {
        config = loadConfig();
      } catch {
        console.log(chalk.yellow("No config found. Run `ao init` first."));
        console.log(chalk.dim("Falling back to session discovery...\n"));
        await showFallbackStatus();
        return;
      }

      if (opts.project && !config.projects[opts.project]) {
        console.error(chalk.red(`Unknown project: ${opts.project}`));
        process.exit(1);
      }

      const allTmux = await getTmuxSessions();
      const projects = opts.project
        ? { [opts.project]: config.projects[opts.project] }
        : config.projects;

      if (!opts.json) {
        console.log(banner("AGENT ORCHESTRATOR STATUS"));
        console.log();
      }

      let totalSessions = 0;
      const jsonOutput: SessionInfo[] = [];

      for (const [projectId, projectConfig] of Object.entries(projects)) {
        const prefix = projectConfig.sessionPrefix || projectId;
        const projectSessions = allTmux.filter((s) => matchesPrefix(s, prefix));
        const sessionsDir = getSessionsDir(config.configPath, projectConfig.path);

        // Resolve plugins for this project
        const agent = getAgent(config, projectId);
        const scm = getSCM(config, projectId);

        if (!opts.json) {
          console.log(header(projectConfig.name || projectId));
        }

        if (projectSessions.length === 0) {
          if (!opts.json) {
            console.log(chalk.dim("  (no active sessions)"));
            console.log();
          }
          continue;
        }

        totalSessions += projectSessions.length;

        if (!opts.json) {
          printTableHeader();
        }

        // Gather all session info in parallel
        const infoPromises = projectSessions
          .sort()
          .map((session) => gatherSessionInfo(session, sessionsDir, agent, scm, projectConfig));
        const sessionInfos = await Promise.all(infoPromises);

        for (const info of sessionInfos) {
          if (opts.json) {
            jsonOutput.push(info);
          } else {
            printSessionRow(info);
          }
        }

        if (!opts.json) {
          console.log();
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(jsonOutput, null, 2));
      } else {
        console.log(
          chalk.dim(
            `  ${totalSessions} active session${totalSessions !== 1 ? "s" : ""} across ${Object.keys(projects).length} project${Object.keys(projects).length !== 1 ? "s" : ""}`,
          ),
        );
        console.log();
      }
    });
}

async function showFallbackStatus(): Promise<void> {
  const allTmux = await getTmuxSessions();
  if (allTmux.length === 0) {
    console.log(chalk.dim("No tmux sessions found."));
    return;
  }

  console.log(banner("AGENT ORCHESTRATOR STATUS"));
  console.log();
  console.log(
    chalk.dim(`  ${allTmux.length} tmux session${allTmux.length !== 1 ? "s" : ""} found\n`),
  );

  // Use claude-code as default agent for fallback introspection
  const agent = getAgentByName("claude-code");

  for (const session of allTmux.sort()) {
    const activityTs = await getTmuxActivity(session);
    const lastActivity = activityTs ? formatAge(activityTs) : "-";
    console.log(`  ${chalk.green(session)} ${chalk.dim(`(${lastActivity})`)}`);

    // Try introspection even without config
    try {
      const sessionObj = buildSessionForIntrospect(session);
      const introspection = await agent.getSessionInfo(sessionObj);
      if (introspection?.summary) {
        console.log(`     ${chalk.dim("Claude:")} ${introspection.summary.slice(0, 65)}`);
      }
    } catch {
      // Not critical
    }
  }
  console.log();
}
