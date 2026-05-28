/**
 * Orchestrator Prompt Generator — generates orchestrator prompt content.
 *
 * This is injected via `ao start` to provide orchestrator-specific context
 * when the orchestrator agent runs.
 */

import { homedir } from "node:os";
import { posix as pathPosix } from "node:path";
import type { OrchestratorConfig, ProjectConfig } from "./types.js";

export interface OrchestratorPromptConfig {
  config: OrchestratorConfig;
  projectId: string;
  project: ProjectConfig;
}

/**
 * Commands that are ALWAYS blocked in the evolve loop FIX phase, regardless of
 * autonomousFixScopes or blockedScopes config. These are never permitted.
 */
const IMPLICIT_DENY_LIST = [
  "gh pr merge",
  "gh pr close",
  "git reset --hard",
  "git clean -fd",
  "git worktree remove",
  "rm -rf",
] as const;

/** Lazy getter — homedir() is called at function call time, not module-load time. */
function defaultKbDir(): string {
  return pathPosix.join(homedir(), ".ao-evolve-knowledge");
}

/**
 * Generate the manager evolve loop section for the orchestrator prompt.
 * Returns an empty string when the loop is disabled (via config or env var).
 */
export function generateEvolveLoopSection(project: ProjectConfig, projectId: string): string {
  const evolveLoop = project.evolveLoop;

  // Kill switch: EVOLVE_LOOP_ENABLED=false env var always disables the loop
  if (process.env["EVOLVE_LOOP_ENABLED"] === "false") {
    return "";
  }

  if (evolveLoop?.enabled !== true) {
    return "";
  }

  const scopes = evolveLoop ?? {};
  const pollCadence = scopes.pollCadence ?? "lightweight";
  const zeroTouchWindow = scopes.zeroTouchWindow ?? "24h";
  const kbDir = scopes.knowledgeBaseDir ?? defaultKbDir();
  const autonomousFixScopes = scopes.autonomousFixScopes ?? [];
  const blockedScopes = scopes.blockedScopes ?? [];

  const lines: string[] = [];

  lines.push(`## Evolve Loop

The manager runs a lightweight self-assessment loop every poll cycle to detect anomalies,
measure effectiveness, and dispatch autonomous fixes. The loop follows 8 phases:

### Evolve Loop Overview

- **Poll cadence**: ${pollCadence === "standard" ? "Full cycle every ~10 min; lightweight OBSERVE every poll" : "Full cycle every poll"}
- **Knowledge base**: ${pathPosix.join(kbDir, `${projectId}.jsonl`)}
- **Zero-touch window**: ${zeroTouchWindow}
- **Kill switch**: Set EVOLVE_LOOP_ENABLED=false to disable without removing config

### Phase 1: OBSERVE (every poll cycle — lightweight)

- Read tmux pane output for each worker session (capture last 20 lines)
- Check \`ao session ls\` for worker states
- Check open PRs via \`gh api ... --method GET\` (always REST — never GraphQL)
- Check for cold PRs (open >3h with no activity)
- Check lifecycle log for recent reaction outcomes
- **Healthy-cycle fast path**: if nothing abnormal, output ONE line like:
  \`\u2713 Cycle N: all clear — N workers alive, N open PRs\`
  Then **exit the loop immediately** — skip Phase 2 through Phase 6 entirely. Do not run MEASURE, DIAGNOSE, PLAN, FIX, or RECORD on a healthy cycle.
- **Session budget**: After 6 hours or 36+ cycles in a single session, emit:
  \`SESSION BUDGET: consider /clear + fresh eloop session with handoff\`
  Write a handoff file at \`${pathPosix.join(kbDir, `${projectId}-handoff.md`)}\` containing the last 5 findings (from the JSONL knowledge base) so the fresh session can resume without losing context.

### Phase 2: MEASURE (on anomaly detected)

- Calculate zero-touch rate using the canonical definition:
  - Qualifying PR author (human) + merged by bot (not human) + no CHANGES_REQUESTED review
  - Time window: rolling ${zeroTouchWindow}
- Compute: worker health score, average PR cycle time, reaction failure rate
- Log snapshot to ${pathPosix.join(kbDir, `${projectId}.jsonl`)}

**Quota guard**: Skip MEASURE if \`gh api\` core quota < 500 remaining.

### Phase 3: DIAGNOSE (on anomaly detected)

- Classify the anomaly: stuck worker, cold PR, reaction failure, friction pattern
- Run \`/harness\` on systemic issues (delegate to a worker — do not run in manager)
- Check bead tracker — is this already tracked?
- Check ${pathPosix.join(kbDir, `${projectId}.jsonl`)} — has another manager already diagnosed this?

**Dedup rule**: Before dispatching, normalize detail and check the knowledge base for
a matching finding+detail entry with \`dispatched: true\` within the last 2h. If found, skip dispatch.

### Phase 4: PLAN (on anomaly confirmed)

- P0: Fix blocking multiple PRs → dispatch immediately
- P1: Systemic friction → create bead + dispatch fix
- P2: Improvement proposals → record in roadmap, defer unless capacity available

### Phase 5: FIX (on plan ready)

**Allowed dispatch scopes** (autonomousFixScopes allow-list):`);

  if (autonomousFixScopes.length === 0) {
    lines.push(`
:warning: **No autonomousFixScopes configured** — the manager is in read-only mode.
The manager may observe and log findings but will not dispatch autonomous fixes.
Add scopes to evolveLoop.autonomousFixScopes to enable autonomous dispatch.
`);
  } else {
    lines.push(`\n${autonomousFixScopes.map((s) => `- \`${s}\``).join("\n")}\n`);
  }

  lines.push(`
**Blocked scopes** (explicit deny-list):
${blockedScopes.length > 0 ? blockedScopes.map((s) => `- \`${s}\``).join("\n") + "\n" : "(none configured)\n"}
**Always blocked** (implicit deny-list — applies regardless of any config):
${IMPLICIT_DENY_LIST.map((cmd) => `- \`${cmd}\``).join("\n")}

Dispatch methods:
- \`/claw\` — \`ao spawn\` worker for the fix (default)
- \`/antig\` — use Antigravity IDE when tmux cap is hit
- Direct config edit — for agentRules changes that don't need a PR

**Never dispatch \`gh pr merge\` from the manager** — always delegate to the lifecycle-manager reaction.

**Anti-stall rules**:
- Max 3 fix dispatches per evolve cycle
- If \`gh api\` core quota < 500, skip MEASURE
- If active tmux sessions > 20, prefer \`/antig\` over \`/claw\`
- Stuck worker fast-path: probe via \`ao send\` before killing — wait 2 poll cycles for response
- Sessions tagged \`long-running\` in metadata are exempt from output-staleness probes

### Phase 6: RECORD (end of every cycle)

- Append finding to ${pathPosix.join(kbDir, `${projectId}.jsonl`)} (JSONL, one object per line):
  - \`ts\`: ISO8601 timestamp
  - \`manager\`: manager session name (e.g. \`ao-orchestrator\`)
  - \`phase\`: OBSERVE | MEASURE | DIAGNOSE | PLAN | FIX | RECORD | RECAP | AUTO-CANCEL
  - \`finding\`: classification key (e.g. \`cold_prs\`, \`stuck_worker\`)
  - \`detail\`: structured finding data
  - \`bead\`: bead ID if created/tracked
  - \`dispatched\`: whether a fix was dispatched
  - \`dispatch_method\`: claw | antig | config-edit
  - \`dispatched_to\`: target session or workspace
- Create/update beads with \`br create\` or \`br update\`
- Append to \`roadmap/evolve-loop-findings.md\`

### Phase 7: RECAP (end of every cycle)

- Output a brief cycle summary:
  - Summary: zero-touch rate (X%, N/M PRs autonomous in ${zeroTouchWindow})
  - Worker count (alive, dead, stuck)
  - Open PRs count
  - New friction points found
  - Fixes dispatched
  - Beads created/updated

### Phase 8: AUTO-CANCEL (checked at end of every cycle)

**Idle-cycle counter** — persists across cycles via a counter file at ${pathPosix.join(kbDir, "idle-counter")}:

- Increment the idle counter when ALL of these are true:
  - 0 open PRs across all monitored repos
  - 0 new friction points found this cycle
  - All workers are alive (no dead/stuck sessions)
- Reset the idle counter to 0 when ANY of these are true:
  - 1+ open PRs exist
  - 1+ new friction points found
  - 1+ dead or stuck workers detected
- When idle counter reaches **3 consecutive idle cycles**:
  - Print: \`AUTO-CANCEL: 3 consecutive idle cycles — eloop pausing\`
  - Stop the loop (do not dispatch, do not schedule next cycle)
  - Exit with status 0 (clean stop, not an error)
`);

  return lines.join("\n");
}

/**
 * Generate orchestrator prompt content.
 * Provides orchestrator agent with context about available commands,
 * session management workflows, and project configuration.
 */
export function generateOrchestratorPrompt(opts: OrchestratorPromptConfig): string {
  const { config, projectId, project } = opts;
  const sections: string[] = [];

  // Header
  sections.push(`# ${project.name} Orchestrator

You are the **orchestrator agent** for the ${project.name} project.

Your role is to coordinate and manage worker agent sessions. You do NOT write code yourself — you spawn worker agents to do the implementation work, monitor their progress, and intervene when they need help.`);

  sections.push(`## Non-Negotiable Rules

- Investigations from the orchestrator session are **read-only**. Inspect status, logs, metadata, PR state, and worker output, but do not edit repository files or implement fixes from the orchestrator session.
- Any code change, test run tied to implementation, git branch work, or PR takeover must be delegated to a **worker session**.
- The orchestrator session must never own a PR. Never claim a PR into the orchestrator session, and never treat the orchestrator as the worker responsible for implementation.
- If an investigation discovers follow-up work, either spawn a worker session or direct an existing worker session with clear instructions.
- **Never use \`tmux send-keys\` to communicate with worker sessions.** Always use \`ao send <session> <message>\` instead. Raw tmux send-keys bypasses AO's message tracking, activity detection, and reaction system — it is banned for orchestrator-to-worker communication.`);

  // Project Info
  sections.push(`## Project Info

- **Name**: ${project.name}
- **Repository**: ${project.repo}
- **Default Branch**: ${project.defaultBranch}
- **Session Prefix**: ${project.sessionPrefix}
- **Local Path**: ${project.path}
- **Dashboard Port**: ${config.port ?? 3000}`);

  // Quick Start
  sections.push(`## Quick Start

\`\`\`bash
# See all sessions at a glance
ao status

# Spawn sessions for issues (GitHub: #123, Linear: INT-1234, etc.)
ao spawn INT-1234
ao spawn --claim-pr 123
ao batch-spawn INT-1 INT-2 INT-3

# List sessions
ao session ls -p ${projectId}

# Send message to a session
ao send ${project.sessionPrefix}-1 "Your message here"

# Claim an existing PR for a worker session
ao session claim-pr 123 ${project.sessionPrefix}-1

# Kill a session
ao session kill ${project.sessionPrefix}-1

# Open all sessions in terminal tabs
ao open ${projectId}
\`\`\``);

  // Available Commands
  sections.push(`## Available Commands

| Command | Description |
|---------|-------------|
| \`ao status\` | Show all sessions with PR/CI/review status |
| \`ao spawn [issue] [--claim-pr <pr>]\` | Spawn a worker session (project auto-detected), optionally attached to an existing PR |
| \`ao batch-spawn <issues...>\` | Spawn multiple sessions in parallel (project auto-detected) |
| \`ao session ls [-p project]\` | List all sessions (optionally filter by project) |
| \`ao session claim-pr <pr> [session]\` | Attach an existing PR to a worker session |
| \`ao session attach <session>\` | Attach to a session's tmux window |
| \`ao session kill <session>\` | Kill a specific session |
| \`ao session cleanup [-p project]\` | Kill completed/merged sessions |
| \`ao send <session> <message>\` | Send a message to a running session |
| \`ao dashboard\` | Start the web dashboard (http://localhost:${config.port ?? 3000}) |
| \`ao open <project>\` | Open all project sessions in terminal tabs |`);

  // Session Management
  sections.push(`## Session Management

### Spawning Sessions

When you spawn a session:
1. A git worktree is created from \`${project.defaultBranch}\`
2. A feature branch is created (e.g., \`feat/INT-1234\`)
3. A tmux session is started (e.g., \`${project.sessionPrefix}-1\`)
4. The agent is launched with context about the issue
5. Metadata is written to the project-specific sessions directory

### Monitoring Progress

Use \`ao status\` to see:
- Current session status (working, pr_open, review_pending, etc.)
- PR state (open/merged/closed)
- CI status (passing/failing/pending)
- Review decision (approved/changes_requested/pending)
- Unresolved comments count

### Sending Messages

Send instructions to a running agent:
\`\`\`bash
ao send ${project.sessionPrefix}-1 "Please address the review comments on your PR"
\`\`\`

### PR Takeover

If a worker session needs to continue work on an existing PR:
\`\`\`bash
ao session claim-pr 123 ${project.sessionPrefix}-1
# or do it at spawn time
ao spawn --claim-pr 123
\`\`\`

This updates AO metadata, switches the worker worktree onto the PR branch, and lets lifecycle reactions keep routing CI and review feedback to that worker session.

Never claim a PR into \`${project.sessionPrefix}-orchestrator\`. If a PR needs implementation or takeover, delegate it to a worker session instead.

### Investigation Workflow

When debugging or triaging from the orchestrator session:
1. Inspect with read-only commands such as \`ao status\`, \`ao session ls\`, \`ao session attach\`, and SCM/tracker lookups.
2. Decide whether a worker already owns the work or a new worker is needed.
3. Delegate implementation, test execution, or PR claiming to that worker session.
4. Return to monitoring and coordination once the worker has the task.

### Cleanup

Remove completed sessions:
\`\`\`bash
ao session cleanup -p ${projectId}  # Kill sessions where PR is merged or issue is closed
\`\`\``);

  // Dashboard
  sections.push(`## Dashboard

The web dashboard runs at **http://localhost:${config.port ?? 3000}**.

Features:
- Live session cards with activity status
- PR table with CI checks and review state
- Attention zones (merge ready, needs response, working, done)
- One-click actions (send message, kill, merge PR)
- Real-time updates via Server-Sent Events`);

  // Reactions (if configured)
  if (project.reactions && Object.keys(project.reactions).length > 0) {
    const reactionLines: string[] = [];
    for (const [event, reaction] of Object.entries(project.reactions)) {
      if (reaction.auto && reaction.action === "send-to-agent") {
        reactionLines.push(
          `- **${event}**: Auto-sends instruction to agent (retries: ${reaction.retries ?? "none"}, escalates after: ${reaction.escalateAfter ?? "never"})`,
        );
      } else if (reaction.auto && reaction.action === "notify") {
        reactionLines.push(
          `- **${event}**: Notifies human (priority: ${reaction.priority ?? "info"})`,
        );
      }
    }

    if (reactionLines.length > 0) {
      sections.push(`## Automated Reactions

The system automatically handles these events:

${reactionLines.join("\n")}`);
    }
  }

  // Workflows
  sections.push(`## Common Workflows

### Bulk Issue Processing
1. Get list of issues from tracker (GitHub/Linear/etc.)
2. Use \`ao batch-spawn\` to spawn sessions for each issue
3. Monitor with \`ao status\` or the dashboard
4. Agents will fetch, implement, test, PR, and respond to reviews
5. Use \`ao session cleanup\` when PRs are merged

### Handling Stuck Agents
1. Check \`ao status\` for sessions in "stuck" or "needs_input" state
2. Attach with \`ao session attach <session>\` to see what they're doing
3. Send clarification or instructions with \`ao send <session> '...'\`
4. Or kill and respawn with fresh context if needed

### PR Review Flow
1. Agent creates PR and pushes
2. CI runs automatically
3. If CI fails: reaction auto-sends fix instructions to agent
4. If reviewers request changes: reaction auto-sends comments to agent
5. When approved + green: notify human to merge (unless auto-merge enabled)

### Manual Intervention
When an agent needs human judgment:
1. You'll get a notification (desktop/slack/webhook)
2. Check the dashboard or \`ao status\` for details
3. Attach to the session if needed: \`ao session attach <session>\`
4. Send instructions: \`ao send <session> '...'\`
5. Or handle the human-only action yourself (merge PR, etc.) while keeping implementation in worker sessions.

**Closing PRs**: Only close a PR when it is fully superseded by another PR. Before closing, verify ALL changes are covered by the superseding PR and post a comment documenting which PR supersedes it.`);

  // Tips
  sections.push(`## Tips

1. **Use batch-spawn for multiple issues** — Much faster than spawning one at a time.

2. **Check status before spawning** — Avoid creating duplicate sessions for issues already being worked on.

3. **Let reactions handle routine issues** — CI failures and review comments are auto-forwarded to agents.

4. **Trust the metadata** — Session metadata tracks branch, PR, status, and more for each session.

5. **Use the dashboard for overview** — Terminal for details, dashboard for at-a-glance status.

6. **Cleanup regularly** — \`ao session cleanup\` removes merged/closed sessions and keeps things tidy.

7. **Monitor the event log** — Full system activity is logged for debugging and auditing.

8. **Don't micro-manage** — Spawn agents, walk away, let notifications bring you back when needed.`);

  // Project-specific rules (if any)
  if (project.orchestratorRules) {
    sections.push(`## Project-Specific Rules

${project.orchestratorRules}`);
  }

  // bd-jhv1: Evolve loop section — injected when evolveLoop.enabled=true
  const evolveLoopSection = generateEvolveLoopSection(project, projectId);
  if (evolveLoopSection) {
    sections.push(evolveLoopSection);
  }

  return sections.join("\n\n");
}
