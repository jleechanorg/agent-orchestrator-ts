import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { resolve } from "node:path";
import {
  loadConfig,
  resolveSpawnTarget,
  TERMINAL_STATUSES,
  enqueueSpawnRequest,
  resolveSpawnQueueConfig,
  expandHome,
  type OrchestratorConfig,
} from "@jleechanorg/ao-core";
import { DEFAULT_PORT } from "../lib/constants.js";
import { exec } from "../lib/shell.js";
import { banner } from "../lib/format.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { ensureLifecycleWorker } from "../lib/lifecycle-service.js";
import { preflight } from "../lib/preflight.js";
import { findProjectForDirectory } from "../lib/project-resolution.js";
import { getRunning } from "../lib/running-state.js";
import { projectSessionUrl } from "../lib/routes.js";

function autoDetectProject(config: OrchestratorConfig): string {
  const projectIds = Object.keys(config.projects);
  if (projectIds.length === 0) {
    throw new Error("No projects configured. Run 'ao start' first.");
  }
  if (projectIds.length === 1) {
    return projectIds[0];
  }

  const envProject = process.env.AO_PROJECT_ID;
  if (envProject && config.projects[envProject]) {
    return envProject;
  }

  const cwd = resolve(process.cwd());
  const matchedProjectId = findProjectForDirectory(config.projects, cwd);
  if (matchedProjectId) {
    return matchedProjectId;
  }

  throw new Error(
    `Multiple projects configured. Specify one: ${projectIds.join(", ")}\n` +
      `Or run from within a project directory.`,
  );
}

function tryAutoDetectProject(config: OrchestratorConfig): string | null {
  try {
    return autoDetectProject(config);
  } catch {
    return null;
  }
}

function resolveProjectAndIssue(
  config: OrchestratorConfig,
  issue: string | undefined,
): { projectId: string; issueId?: string } {
  const fallback = tryAutoDetectProject(config);
  if (issue) {
    const target = resolveSpawnTarget(config.projects, issue, fallback ?? undefined);
    if (target) return { projectId: target.projectId, issueId: target.issueId };
    autoDetectProject(config);
    throw new Error("unreachable");
  }
  if (!fallback) {
    autoDetectProject(config);
    throw new Error("unreachable");
  }
  return { projectId: fallback };
}

interface SpawnClaimOptions {
  claimPr?: string;
  assignOnGithub?: boolean;
  runtime?: string;
}

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

  try {
    const sm = await getSessionManager(config);

    const listedSessions = await sm.list(projectId);
    const activeSessions = listedSessions.filter((session) => !TERMINAL_STATUSES.has(session.status));
    const queueConfig = resolveSpawnQueueConfig(config.projects[projectId]);

    const sanitizedPrompt = prompt?.replace(/[\r\n]/g, " ").trim() || undefined;
    if (sanitizedPrompt && sanitizedPrompt.length > 4096) {
      throw new Error("Prompt must be at most 4096 characters");
    }

    if (queueConfig.enabled && activeSessions.length >= queueConfig.maxActiveSessions) {
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

    const issueLabel = issueId ? ` for issue #${issueId}` : "";
    const claimLabel = claimedPrUrl ? ` (claimed ${claimedPrUrl})` : "";
    const port = config.port ?? DEFAULT_PORT;
    spinner.succeed(
      `Session ${chalk.green(session.id)} spawned${issueLabel}${claimLabel}`,
    );
    console.log(`  View:     ${chalk.dim(projectSessionUrl(port, projectId, session.id))}`);
    if (branchStr) console.log(`  Branch:   ${chalk.dim(branchStr)}`);

    const tmuxTarget = session.runtimeHandle?.id ?? session.id;
    console.log(`  Attach:   ${chalk.dim(`tmux attach -t ${tmuxTarget}`)}`);
    console.log();

    if (openTab) {
      try {
        await exec("open-iterm-tab", [tmuxTarget]);
      } catch {
      }
    }

    console.log(`SESSION=${session.id}`);
    return session.id;
  } catch (err) {
    spinner.fail("Failed to create or initialize session");
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
        "  ao spawn xid/42",
        "  ao spawn x402-identity/42",
        "  ao spawn -p agent-orchestrator bd-1234",
        "  ao spawn --project agent-orchestrator --claim-pr 456",
        '  ao spawn --agent codex "investigate the failing integration test"',
        '  ao spawn --prompt "implement fibonacci"',
        "",
        "Project resolution:",
        "  - Prefixed issues (xid/42) target a specific project by sessionPrefix.",
        "  - If only one project is configured, AO uses it automatically.",
        "  - Otherwise AO matches cwd, then AO_PROJECT_ID, then requires -p/--project.",
      ].join("\n"),
    )
    .argument(
      "[issue]",
      "Issue identifier. Accepts bare ids (42, INT-100) or prefixed forms (x402-identity/42, xid/42) to target a specific project by id or sessionPrefix.",
    )
    .allowExcessArguments()
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
    .option("--prompt <text>", "Initial prompt/instructions for the agent (use instead of an issue)")
    .action(
      async (
        issue: string | undefined,
        opts: {
          open?: boolean;
          agent?: string;
          claimPr?: string;
          assignOnGithub?: boolean;
          decompose?: boolean;
          maxDepth?: string;
          project?: string;
          runtime?: string;
          prompt?: string;
        },
        command: Command,
      ) => {
        if (command.args.length > 1) {
          console.error(
            chalk.red(
              `✗ \`ao spawn\` accepts at most 1 argument, but ${command.args.length} were provided.\n\n` +
                `Use:\n` +
                `  ao spawn [issue]`,
            ),
          );
          process.exit(1);
        }

        const config = loadConfig();
        let projectId: string;
        let issueId: string | undefined;

        if (opts.project) {
          if (!config.projects[opts.project]) {
            console.error(
              chalk.red(
                `Unknown project: ${opts.project}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
              ),
            );
            process.exit(1);
          }
          projectId = opts.project;
          issueId = issue;
        } else {
          try {
            ({ projectId, issueId } = resolveProjectAndIssue(config, issue));
          } catch (err) {
            console.error(chalk.red(err instanceof Error ? err.message : String(err)));
            process.exit(1);
          }
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
          await ensureLifecycleWorker(config, projectId);
          await ensureAOPollingProject(projectId);

          if (opts.decompose && issueId) {
            const aoCore = await import("@jleechanorg/ao-core");
            const {
              decompose,
              getLeaves,
              getSiblings,
              formatPlanTree,
              DEFAULT_DECOMPOSER_CONFIG,
            } = aoCore;
            type DecomposerConfig = import("@jleechanorg/ao-core").DecomposerConfig;

            const project = config.projects[projectId];
            const decompConfig: DecomposerConfig = {
              ...DEFAULT_DECOMPOSER_CONFIG,
              ...(project.decomposer ?? {}),
              maxDepth: opts.maxDepth
                ? parseInt(opts.maxDepth, 10)
                : (project.decomposer?.maxDepth ?? 3),
            };

            const decompSpinner = ora("Decomposing task...").start();

            const plan = await decompose(issueId, decompConfig);
            const leaves = getLeaves(plan.tree);
            decompSpinner.succeed(`Decomposed into ${chalk.bold(String(leaves.length))} subtasks`);

            console.log();
            console.log(chalk.dim(formatPlanTree(plan.tree)));
            console.log();

            if (leaves.length <= 1) {
              console.log(chalk.yellow("Task is atomic — spawning directly."));
              await spawnSession(config, projectId, issueId, opts.open, opts.agent, claimOptions, opts.prompt);
            } else {
              const sm = await getSessionManager(config);
              console.log(chalk.bold(`Spawning ${leaves.length} sessions with lineage context...`));
              console.log();

              for (const leaf of leaves) {
                const siblings = getSiblings(plan.tree, leaf.id);
                try {
                  const session = await sm.spawn({
                    projectId,
                    issueId,
                    lineage: leaf.lineage,
                    siblings,
                    agent: opts.agent,
                    runtimeOverride: opts.runtime,
                  });
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
            await spawnSession(config, projectId, issueId, opts.open, opts.agent, claimOptions, opts.prompt);
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
    .argument(
      "<issues...>",
      "Issue identifiers. Accepts bare ids or prefixed forms (x402-identity/42, xid/42); mixed projects are grouped automatically.",
    )
    .option("--open", "Open sessions in terminal tabs")
    .option(
      "-p, --project <id>",
      "Explicit project ID (use when multiple projects are configured and cwd does not match)",
    )
    .action(async (issues: string[], opts: { open?: boolean; project?: string }) => {
      const config = loadConfig();

      let fallbackProjectId: string | null = null;
      const needsFallback = issues.some(
        (issue) => resolveSpawnTarget(config.projects, issue) === null,
      );
      if (needsFallback) {
        if (opts.project) {
          if (!config.projects[opts.project]) {
            console.error(
              chalk.red(
                `Unknown project: ${opts.project}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
              ),
            );
            process.exit(1);
          }
          fallbackProjectId = opts.project;
        } else {
          try {
            fallbackProjectId = autoDetectProject(config);
          } catch (err) {
            console.error(chalk.red(err instanceof Error ? err.message : String(err)));
            process.exit(1);
          }
        }
      }

      const groups = new Map<string, Array<{ original: string; resolved: string }>>();
      for (const issue of issues) {
        const target = resolveSpawnTarget(config.projects, issue, fallbackProjectId ?? undefined);
        if (!target) {
          console.error(chalk.red(`Could not resolve project for issue: ${issue}`));
          process.exit(1);
        }
        if (!config.projects[target.projectId]) {
          console.error(
            chalk.red(
              `Unknown project: ${target.projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
            ),
          );
          process.exit(1);
        }
        if (!groups.has(target.projectId)) groups.set(target.projectId, []);
        groups.get(target.projectId)!.push({ original: issue, resolved: target.issueId });
      }

      console.log(banner("BATCH SESSION SPAWNER"));
      console.log();
      for (const [pid, items] of groups) {
        console.log(
          `  ${chalk.bold(pid)}: ${items.map((i) => i.original).join(", ")}`,
        );
      }
      console.log();

      const created: Array<{ session: string; issue: string }> = [];
      const skipped: Array<{ issue: string; existing: string }> = [];
      const failed: Array<{ issue: string; error: string }> = [];

      const sm = await getSessionManager(config);

      for (const [groupProjectId, items] of groups) {
        try {
          await runSpawnPreflight(config, groupProjectId);
          await ensureLifecycleWorker(config, groupProjectId);
          await ensureAOPollingProject(groupProjectId);
        } catch (err) {
          console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
          process.exit(1);
        }

        const existingSessions = await sm.list(groupProjectId);
        const existingIssueMap = new Map(
          existingSessions
            .filter((s) => s.issueId && !TERMINAL_STATUSES.has(s.status))
            .map((s) => [s.issueId!.toLowerCase(), s.id]),
        );
        const spawnedIssues = new Set<string>();

        for (const { original, resolved } of items) {
          if (spawnedIssues.has(resolved.toLowerCase())) {
            console.log(chalk.yellow(`  Skip ${original} — duplicate in this batch`));
            skipped.push({ issue: original, existing: "(this batch)" });
            continue;
          }

          const existingSessionId = existingIssueMap.get(resolved.toLowerCase());
          if (existingSessionId) {
            console.log(
              chalk.yellow(`  Skip ${original} — already has session ${existingSessionId}`),
            );
            skipped.push({ issue: original, existing: existingSessionId });
            continue;
          }

          try {
            const activeSessions = (await sm.list(groupProjectId)).filter(
              (session) => !TERMINAL_STATUSES.has(session.status),
            );
            const queueConfig = resolveSpawnQueueConfig(config.projects[groupProjectId]);
            if (queueConfig.enabled && activeSessions.length >= queueConfig.maxActiveSessions) {
              const queued = enqueueSpawnRequest(config.configPath, groupProjectId, { issueId: resolved });
              console.log(
                chalk.yellow(
                  `  Queue ${original} — active sessions ${activeSessions.length}/${queueConfig.maxActiveSessions}, request ${queued.requestId}`,
                ),
              );
              skipped.push({ issue: original, existing: queued.requestId });
              continue;
            }

            const session = await sm.spawn({ projectId: groupProjectId, issueId: resolved });
            created.push({ session: session.id, issue: original });
            spawnedIssues.add(resolved.toLowerCase());
            console.log(chalk.green(`  Created ${session.id} for ${original}`));

            if (opts.open) {
              try {
                const tmuxTarget = session.runtimeHandle?.id ?? session.id;
                await exec("open-iterm-tab", [tmuxTarget]);
              } catch {
              }
            }
          } catch (err) {
            failed.push({
              issue: original,
              error: err instanceof Error ? err.message : String(err),
            });
            console.log(
              chalk.red(
                `  Failed ${original} — ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          }
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
