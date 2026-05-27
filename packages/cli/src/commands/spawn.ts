import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { resolve } from "node:path";
import {
  loadConfig,
  decompose,
  getLeaves,
  getSiblings,
  formatPlanTree,
  isTerminalSession,
  enqueueSpawnRequest,
  resolveSpawnQueueConfig,
  expandHome,
  recordActivityEvent,
  type OrchestratorConfig,
  type DecomposerConfig,
  DEFAULT_DECOMPOSER_CONFIG,
} from "@jleechanorg/ao-core";
import { exec } from "../lib/shell.js";
import { banner } from "../lib/format.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { ensureLifecycleWorker } from "../lib/lifecycle-service.js";
import { preflight } from "../lib/preflight.js";
import { getRunning } from "../lib/running-state.js";

/**
 * Auto-detect the project ID from the config.
 * - If only one project exists, use it.
 * - If multiple projects exist, match cwd against project paths.
 * - Falls back to AO_PROJECT_ID env var (set when called from an agent session).
 */
function autoDetectProject(config: OrchestratorConfig): string {
  const projectIds = Object.keys(config.projects);
  if (projectIds.length === 0) {
    throw new Error("No projects configured. Run 'ao start' first.");
  }
  if (projectIds.length === 1) {
    return projectIds[0];
  }

  // Try AO_PROJECT_ID env var (set by AO when spawning agent sessions)
  const envProject = process.env.AO_PROJECT_ID;
  if (envProject && config.projects[envProject]) {
    return envProject;
  }

  // Try matching cwd to a project path
  const cwd = resolve(process.cwd());
  for (const [id, project] of Object.entries(config.projects)) {
    if (project.path && resolve(expandHome(project.path)) === cwd) {
      return id;
    }
  }

  throw new Error(
    `Multiple projects configured. Specify one: ${projectIds.join(", ")}\n` +
      `Or run from within a project directory.`,
  );
}

/**
 * Resolve project for spawn/batch-spawn: explicit `-p` / `--project` wins, else auto-detect.
 */
function resolveSpawnProjectId(
  config: OrchestratorConfig,
  explicitProjectId?: string,
): string {
  if (explicitProjectId) {
    if (!config.projects[explicitProjectId]) {
      throw new Error(
        `Unknown project: ${explicitProjectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
      );
    }
    return explicitProjectId;
  }
  return autoDetectProject(config);
}

/**
 * Refuse to spawn if no `ao start` is running, or if the running instance is
 * not polling this project. Without an active daemon, sessions get worktrees
 * and tmux panes but no lifecycle reactions (CI-failure routing, review
 * comments, revive transitions, event log). That silent blackout is a
 * worse failure mode than creating no session at all — so fail fast with
 * an actionable error.
 */
async function ensureAOPollingProject(projectId: string): Promise<void> {
  const running = await getRunning();
  if (!running) {
    throw new Error(
      `AO is not running — lifecycle polling is inactive. Run \`ao start\` before spawning sessions so they get CI/review routing and state advancement.`,
    );
  }
  if (!running.projects.includes(projectId)) {
    throw new Error(
      `The running AO instance (pid ${running.pid}) is not polling project "${projectId}". Run \`ao start ${projectId}\` before spawning so sessions get tracked.`,
    );
  }
}

interface SpawnClaimOptions {
  claimPr?: string;
  assignOnGithub?: boolean;
  runtime?: string;
}

/**
 * Run pre-flight checks for a project once, before any sessions are spawned.
 * Validates runtime and tracker prerequisites so failures surface immediately
 * rather than repeating per-session in a batch.
 */
async function runSpawnPreflight(
  config: OrchestratorConfig,
  projectId: string,
  options?: SpawnClaimOptions,
): Promise<void> {
  const project = config.projects[projectId];
  const runtime = options?.runtime ?? project?.runtime ?? config.defaults.runtime;
  if (runtime === "tmux") {
    await preflight.checkTmux();
  }
  const needsGitHubAuth =
    project?.tracker?.plugin === "github" ||
    (options?.claimPr && project?.scm?.plugin === "github");
  if (needsGitHubAuth) {
    await preflight.checkGhAuth();
  }
}

async function spawnSession(
  config: OrchestratorConfig,
  projectId: string,
  issueId?: string,
  openTab?: boolean,
  agent?: string,
  claimOptions?: SpawnClaimOptions,
  prompt?: string,
): Promise<string> {
  const runtime = claimOptions?.runtime;
  const spinner = ora("Creating session").start();
  recordActivityEvent({
    projectId,
    source: "cli",
    kind: "cli.spawn_command",
    summary: `spawn command invoked for project ${projectId}`,
    data: { issueId, agent, prompt: prompt ? prompt.slice(0, 100) : undefined },
  });

  try {
    const sm = await getSessionManager(config);

    const listedSessions = await sm.list(projectId);
    const activeSessions = listedSessions.filter((session) => !isTerminalSession(session));
    const queueConfig = resolveSpawnQueueConfig(config.projects[projectId]);

    // Validate and sanitize prompt before any branch (strip newlines to prevent metadata injection)
    const sanitizedPrompt = prompt?.replace(/[\r\n]/g, " ").trim() || undefined;
    if (sanitizedPrompt && sanitizedPrompt.length > 4096) {
      throw new Error("Prompt must be at most 4096 characters");
    }

    // Storm prevention: hard cap applies regardless of queue.enabled.
    // When queue is enabled the cap routes to the queue; when disabled it rejects immediately.
    if (activeSessions.length >= queueConfig.maxActiveSessions) {
      if (queueConfig.enabled) {
        const queued = enqueueSpawnRequest(config.configPath, projectId, {
          issueId,
          agent,
          runtimeOverride: runtime,
          prompt: sanitizedPrompt,
          claimPr: claimOptions?.claimPr,
          assignOnGithub: claimOptions?.assignOnGithub,
        });

        spinner.succeed(`Session request queued at position ${queued.position}`);
        console.log(`  Reason:   ${chalk.dim(`${activeSessions.length} active sessions >= cap ${queueConfig.maxActiveSessions}`)}`);
        console.log(`  Request:  ${chalk.dim(queued.requestId)}`);
        if (claimOptions?.claimPr) console.log(`  PR:       ${chalk.dim(claimOptions.claimPr)}`);
        console.log();
        console.log(`REQUEST=${queued.requestId}`);
        return queued.requestId;
      } else {
        spinner.fail(
          `Spawn rejected: ${activeSessions.length} active sessions >= cap (${queueConfig.maxActiveSessions}). Wait for sessions to complete.`,
        );
        process.exit(1);
      }
    }

    spinner.text = "Spawning session via core";

    const session = await sm.spawn({
      projectId,
      issueId,
      agent,
      runtimeOverride: runtime,
      prompt: sanitizedPrompt,
    });

    let branchStr = session.branch ?? "";
    let claimedPrUrl: string | null = null;

    if (claimOptions?.claimPr) {
      spinner.text = `Claiming PR ${claimOptions.claimPr}`;
      try {
        const claimResult = await sm.claimPR(session.id, claimOptions.claimPr, {
          assignOnGithub: claimOptions.assignOnGithub,
          sendInitialMessage: true,
        });
        branchStr = claimResult.pr.branch;
        claimedPrUrl = claimResult.pr.url;
      } catch (err) {
        throw new Error(
          `Session ${session.id} was created, but failed to claim PR ${claimOptions.claimPr}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }

    spinner.succeed(
      claimedPrUrl
        ? `Session ${chalk.green(session.id)} created and claimed PR`
        : `Session ${chalk.green(session.id)} created`,
    );

    console.log(`  Worktree: ${chalk.dim(session.workspacePath ?? "-")}`);
    if (branchStr) console.log(`  Branch:   ${chalk.dim(branchStr)}`);
    if (claimedPrUrl) console.log(`  PR:       ${chalk.dim(claimedPrUrl)}`);

    // Show the tmux name for attaching (stored in metadata or runtimeHandle)
    const tmuxTarget = session.runtimeHandle?.id ?? session.id;
    console.log(`  Attach:   ${chalk.dim(`tmux attach -t ${tmuxTarget}`)}`);
    console.log();

    // Open terminal tab if requested
    if (openTab) {
      try {
        await exec("open-iterm-tab", [tmuxTarget]);
      } catch {
        // Terminal plugin not available
      }
    }

    // Output for scripting
    console.log(`SESSION=${session.id}`);
    return session.id;
  } catch (err) {
    spinner.fail("Failed to create or initialize session");
    recordActivityEvent({
      projectId,
      source: "cli",
      kind: "cli.spawn_failed",
      level: "error",
      summary: `spawn command failed for project ${projectId}`,
      data: { reason: err instanceof Error ? err.message : String(err), issueId },
    });
    throw err;
  }
}

export function registerSpawn(program: Command): void {
  program
    .command("spawn")
    .summary("Spawn a single agent session")
    .description(
      [
        "Spawn a single agent session.",
        "",
        "Examples:",
        '  ao spawn "fix the flaky retry path"',
        "  ao spawn 123",
        "  ao spawn -p agent-orchestrator bd-1234",
        "  ao spawn --project agent-orchestrator --claim-pr 456",
        '  ao spawn --agent codex "investigate the failing integration test"',
        "",
        "Project resolution:",
        "  - If only one project is configured, AO uses it automatically.",
        "  - Otherwise AO matches cwd, then AO_PROJECT_ID, then requires -p/--project.",
      ].join("\n"),
    )
    .argument("[first]", "Issue identifier (project is auto-detected)")
    .argument("[second]", "", /* hidden second arg to catch old two-arg usage */)
    .option("--open", "Open session in terminal tab")
    .option("--agent <name>", "Override the agent plugin (e.g. codex, claude-code)")
    .option("--claim-pr <pr>", "Immediately claim an existing PR for the spawned session")
    .option("--assign-on-github", "Assign the claimed PR to the authenticated GitHub user")
    .option("--decompose", "Decompose issue into subtasks before spawning")
    .option("--max-depth <n>", "Max decomposition depth (default: 3)")
    .option(
      "--runtime <name>",
      "Override the runtime plugin (e.g. antigravity, tmux). Falls back to project config → global default.",
    )
    .option(
      "-p, --project <id>",
      "Explicit project ID (use when multiple projects are configured and cwd does not match)",
    )
    .action(
      async (
        first: string | undefined,
        second: string | undefined,
        opts: {
          open?: boolean;
          agent?: string;
          claimPr?: string;
          assignOnGithub?: boolean;
          decompose?: boolean;
          maxDepth?: string;
          project?: string;
          runtime?: string;
        },
      ) => {
        // Catch old two-arg usage: ao spawn <project> <issue>
        if (first && second) {
          console.warn(
            chalk.yellow(
              `⚠ 'ao spawn <project> <issue>' is no longer supported.\n` +
                `  Use an explicit project flag instead:\n\n` +
                `    ao spawn -p ${first} ${second}\n` +
                `  Or auto-detect project (cwd / single project / AO_PROJECT_ID) and pass only the issue:\n\n` +
                `    ao spawn ${second}\n` +
                `    ao spawn              # no issue id\n`,
            ),
          );
          process.exit(1);
        }

        const config = loadConfig();
        let projectId: string;
        const issueId: string | undefined = first;

        try {
          projectId = resolveSpawnProjectId(config, opts.project);
        } catch (err) {
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }

        if (!opts.claimPr && opts.assignOnGithub) {
          console.error(chalk.red("--assign-on-github requires --claim-pr on `ao spawn`."));
          process.exit(1);
        }

        const claimOptions: SpawnClaimOptions = {
          claimPr: opts.claimPr,
          assignOnGithub: opts.assignOnGithub,
          runtime: opts.runtime,
        };

        try {
          await runSpawnPreflight(config, projectId, claimOptions);
          await ensureAOPollingProject(projectId);
          await ensureLifecycleWorker(config, projectId);

          if (opts.decompose && issueId) {
            // Decompose the issue before spawning
            const project = config.projects[projectId];
            const decompConfig: DecomposerConfig = {
              ...DEFAULT_DECOMPOSER_CONFIG,
              ...(project.decomposer ?? {}),
              maxDepth: opts.maxDepth
                ? parseInt(opts.maxDepth, 10)
                : (project.decomposer?.maxDepth ?? 3),
            };

            const spinner = ora("Decomposing task...").start();
            const issueTitle = issueId;

            const plan = await decompose(issueTitle, decompConfig);
            const leaves = getLeaves(plan.tree);
            spinner.succeed(`Decomposed into ${chalk.bold(String(leaves.length))} subtasks`);

            console.log();
            console.log(chalk.dim(formatPlanTree(plan.tree)));
            console.log();

            if (leaves.length <= 1) {
              console.log(chalk.yellow("Task is atomic — spawning directly."));
              await spawnSession(config, projectId, issueId, opts.open, opts.agent, claimOptions);
            } else {
              // Create child issues and spawn sessions with lineage context
              const sm = await getSessionManager(config);
              console.log(chalk.bold(`Spawning ${leaves.length} sessions with lineage context...`));
              console.log();

              const queueCfg = resolveSpawnQueueConfig(config.projects[projectId]);

              for (const leaf of leaves) {
                const siblings = getSiblings(plan.tree, leaf.id);
                const leafPrompt = leaf.description.replace(/[\r\n]/g, " ").trim();
                if (leafPrompt.length > 4096) {
                  console.error(chalk.red(`  ✗ ${leaf.description.slice(0, 40)} — prompt exceeds 4096 chars`));
                  continue;
                }
                const leafSpawnConfig = {
                  projectId,
                  issueId,
                  lineage: leaf.lineage,
                  siblings,
                  agent: opts.agent,
                  runtimeOverride: opts.runtime,
                  prompt: leafPrompt,
                };
                try {
                  // Storm prevention: check cap before each decomposed spawn.
                  const currentSessions = await sm.list(projectId);
                  const currentActive = currentSessions.filter((s) => !isTerminalSession(s));
                  if (currentActive.length >= queueCfg.maxActiveSessions) {
                    if (queueCfg.enabled) {
                      const queued = enqueueSpawnRequest(config.configPath, projectId, leafSpawnConfig);
                      console.log(
                        chalk.yellow(
                          `  ⏳ Queued ${leaf.description.slice(0, 40)}… — request ${queued.requestId}`,
                        ),
                      );
                      continue;
                    } else {
                      console.error(
                        chalk.red(
                          `  ✗ Spawn rejected: ${currentActive.length} active sessions >= cap (${queueCfg.maxActiveSessions}). Remaining subtasks skipped.`,
                        ),
                      );
                      break;
                    }
                  }

                  const session = await sm.spawn(leafSpawnConfig);
                  console.log(`  ${chalk.green("✓")} ${session.id} — ${leaf.description}`);
                } catch (err) {
                  console.error(
                    `  ${chalk.red("✗")} ${leaf.description} — ${err instanceof Error ? err.message : err}`,
                  );
                }
                await new Promise((r) => setTimeout(r, 500));
              }
            }
          } else {
            await spawnSession(config, projectId, issueId, opts.open, opts.agent, claimOptions);
          }
        } catch (err) {
          console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
          process.exit(1);
        }
      },
    );
}

export function registerBatchSpawn(program: Command): void {
  program
    .command("batch-spawn")
    .description("Spawn sessions for multiple issues with duplicate detection")
    .argument("<issues...>", "Issue identifiers (project is auto-detected)")
    .option("--open", "Open sessions in terminal tabs")
    .option(
      "-p, --project <id>",
      "Explicit project ID (use when multiple projects are configured and cwd does not match)",
    )
    .action(async (issues: string[], opts: { open?: boolean; project?: string }) => {
      const config = loadConfig();
      let projectId: string;

      try {
        projectId = resolveSpawnProjectId(config, opts.project);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      if (!config.projects[projectId]) {
        console.error(
          chalk.red(
            `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
          ),
        );
        process.exit(1);
      }

      console.log(banner("BATCH SESSION SPAWNER"));
      console.log();
      console.log(`  Project: ${chalk.bold(projectId)}`);
      console.log(`  Issues:  ${issues.join(", ")}`);
      console.log();

      // Pre-flight once before the loop so a missing prerequisite fails fast
      try {
        await runSpawnPreflight(config, projectId);
        await ensureAOPollingProject(projectId);
        await ensureLifecycleWorker(config, projectId);
      } catch (err) {
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }

      const sm = await getSessionManager(config);
      const created: Array<{ session: string; issue: string }> = [];
      const skipped: Array<{ issue: string; existing: string }> = [];
      const failed: Array<{ issue: string; error: string }> = [];
      const spawnedIssues = new Set<string>();

      // Load existing sessions once before the loop to avoid repeated reads + enrichment.
      // Exclude terminal sessions so completed/merged sessions don't block respawning
      // (e.g. when an issue is reopened after its PR was merged).
      const existingSessions = await sm.list(projectId);
      const existingIssueMap = new Map(
        existingSessions
          .filter((s) => s.issueId && !isTerminalSession(s))
          .map((s) => [(s.issueId as string).toLowerCase(), s.id]),
      );

      for (const issue of issues) {
        // Duplicate detection — check both existing sessions and same-run duplicates
        if (spawnedIssues.has(issue.toLowerCase())) {
          console.log(chalk.yellow(`  Skip ${issue} — duplicate in this batch`));
          skipped.push({ issue, existing: "(this batch)" });
          continue;
        }

        // Check existing sessions (pre-loaded before loop)
      const existingSessionId = existingIssueMap.get(issue.toLowerCase());
      if (existingSessionId) {
        console.log(chalk.yellow(`  Skip ${issue} — already has session ${existingSessionId}`));
        skipped.push({ issue, existing: existingSessionId });
        continue;
      }

      try {
        const activeSessions = (await sm.list(projectId)).filter(
          (session) => !isTerminalSession(session),
        );
        const queueConfig = resolveSpawnQueueConfig(config.projects[projectId]);
        // Storm prevention: hard cap applies regardless of queue.enabled.
        if (activeSessions.length >= queueConfig.maxActiveSessions) {
          if (queueConfig.enabled) {
            const queued = enqueueSpawnRequest(config.configPath, projectId, { issueId: issue });
            console.log(
              chalk.yellow(
                `  Queue ${issue} — active sessions ${activeSessions.length}/${queueConfig.maxActiveSessions}, request ${queued.requestId}`,
              ),
            );
            spawnedIssues.add(issue.toLowerCase());
            skipped.push({ issue, existing: queued.requestId });
          } else {
            console.error(
              chalk.red(
                `  ✗ Spawn rejected for ${issue}: ${activeSessions.length} active sessions >= cap (${queueConfig.maxActiveSessions}). Remaining issues skipped.`,
              ),
            );
            break;
          }
          continue;
        }

        const session = await sm.spawn({ projectId, issueId: issue });
        created.push({ session: session.id, issue });
        spawnedIssues.add(issue.toLowerCase());
          console.log(chalk.green(`  Created ${session.id} for ${issue}`));

          if (opts.open) {
            try {
              const tmuxTarget = session.runtimeHandle?.id ?? session.id;
              await exec("open-iterm-tab", [tmuxTarget]);
            } catch {
              // best effort
            }
          }
        } catch (err) {
          failed.push({
            issue,
            error: err instanceof Error ? err.message : String(err),
          });
          console.log(
            chalk.red(`  Failed ${issue} — ${err instanceof Error ? err.message : String(err)}`),
          );
        }
      }

      console.log();
      if (created.length > 0) {
        console.log(chalk.green(`Created ${created.length} sessions:`));
        for (const item of created) console.log(`  ${item.session} ← ${item.issue}`);
      }
      if (skipped.length > 0) {
        console.log(chalk.yellow(`Skipped ${skipped.length} issues:`));
        for (const item of skipped) console.log(`  ${item.issue} (existing: ${item.existing})`);
      }
      if (failed.length > 0) {
        console.log(chalk.red(`Failed ${failed.length} issues:`));
        for (const item of failed) console.log(`  ${item.issue}: ${item.error}`);
      }
      console.log();
    });
}
