/**
 * `ao start` and `ao stop` commands — unified orchestrator startup.
 *
 * Supports two modes:
 *   1. `ao start [project]` — start from existing config
 *   2. `ao start <url>` — clone repo, auto-generate config, then start
 *
 * The orchestrator prompt is passed to the agent via --append-system-prompt
 * (or equivalent flag) at launch time — no file writing required.
 */

import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, basename, join } from "node:path";
import { cwd } from "node:process";
import { resolveProjectByCwd } from "../lib/resolve-project-cwd.js";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import {
  loadConfig,
  generateOrchestratorPrompt,
  generateSessionPrefix,
  findConfigFile,
  isRepoUrl,
  parseRepoUrl,
  resolveCloneTarget,
  isRepoAlreadyCloned,
  generateConfigFromUrl,
  configToYaml,
  getManagedConfigPath,
  validateManagedConfigTopology,
  normalizeOrchestratorSessionStrategy,
  ConfigNotFoundError,
  isWindows,
  spawnManagedDaemonChild,
  sweepDaemonChildren,
  type OrchestratorConfig,
  type ProjectConfig,
  type ParsedRepoUrl,
} from "@jleechanorg/ao-core";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { exec, execSilent, git } from "../lib/shell.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { ensureLifecycleWorker, stopLifecycleWorker } from "../lib/lifecycle-service.js";
import {
  findWebDir,
  buildDashboardEnv,
  waitForPortAndOpen,
  isPortAvailable,
  findFreePort,
  MAX_PORT_SCAN,
} from "../lib/web-dir.js";
import { cleanNextCache } from "../lib/dashboard-rebuild.js";
import { preflight } from "../lib/preflight.js";
import {
  register,
  isAlreadyRunning,
  getRunning,
  writeLastStop,
} from "../lib/running-state.js";
import { killExistingDaemon } from "../lib/daemon.js";
import { isHumanCaller, promptSelect } from "../lib/caller-context.js";
import { detectEnvironment } from "../lib/detect-env.js";
import { detectDefaultBranch } from "../lib/git-utils.js";
import {
  detectProjectType,
  generateRulesFromTemplates,
  formatProjectTypeForDisplay,
} from "../lib/project-detection.js";

const DEFAULT_PORT = 3000;

// =============================================================================
// HELPERS
// =============================================================================

function ensureConfigDirectory(configPath: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
}

function formatTopologyProblems(
  problems: ReturnType<typeof validateManagedConfigTopology>,
): string {
  return problems.map((p) => `  - ${p.issue}: ${p.detail}`).join("\n");
}

function prepareStagingConfigPath(): string {
  const stagingPath = getManagedConfigPath("staging");
  const problems = validateManagedConfigTopology();
  const repairableIssues = new Set(["staging_symlinked", "staging_prod_same_target"]);
  const blockingProblems = problems.filter((problem) => !repairableIssues.has(problem.issue));
  if (blockingProblems.length > 0) {
    throw new Error(
      `Invalid managed config topology — cannot seed staging config:\n${formatTopologyProblems(blockingProblems)}`,
    );
  }

  if (problems.length > 0 && existsSync(stagingPath)) {
    rmSync(stagingPath, { force: true });
    console.log(chalk.yellow(`  Repaired invalid staging config: ${stagingPath}`));
  }

  ensureConfigDirectory(stagingPath);

  if (existsSync(stagingPath)) {
    return stagingPath;
  }

  const productionPath = getManagedConfigPath("production");
  if (existsSync(productionPath)) {
    ensureConfigDirectory(stagingPath);
    writeFileSync(stagingPath, readFileSync(productionPath, "utf-8"), { mode: 0o600 });
    console.log(chalk.yellow(`  Seeded staging config from production: ${stagingPath}`));
  }

  return stagingPath;
}

function migrateRepoLocalConfig(sourcePath: string, stagingConfigPath: string): OrchestratorConfig {
  const config = writeYamlConfig(stagingConfigPath, readFileSync(sourcePath, "utf-8"));
  try {
    rmSync(sourcePath);
  } catch (error) {
    console.warn(
      chalk.yellow(
        `  Warning: migrated config but could not remove repo-local shadow file ${sourcePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
  }
  return config;
}

function writeYamlConfig(configPath: string, yamlContent: string): OrchestratorConfig {
  ensureConfigDirectory(configPath);
  writeFileSync(configPath, yamlContent, { mode: 0o600 });
  return loadConfig(configPath);
}

function resolveLocalPathConfigPath(): string | undefined {
  const explicitConfigPath = process.env["AO_CONFIG_PATH"];
  if (explicitConfigPath && existsSync(explicitConfigPath)) {
    return explicitConfigPath;
  }

  const stagingConfigPath = prepareStagingConfigPath();
  if (existsSync(stagingConfigPath)) {
    return stagingConfigPath;
  }

  return undefined;
}

/**
 * Resolve project from config.
 * If projectArg is provided, use it. If only one project exists, use that.
 * Otherwise, error with helpful message.
 */
function resolveProject(
  config: OrchestratorConfig,
  projectArg?: string,
): { projectId: string; project: ProjectConfig } {
  const projectIds = Object.keys(config.projects);

  if (projectIds.length === 0) {
    throw new Error("No projects configured. Add a project to agent-orchestrator.yaml.");
  }

  // Explicit project argument
  if (projectArg) {
    const project = config.projects[projectArg];
    if (!project) {
      throw new Error(
        `Project "${projectArg}" not found. Available projects:\n  ${projectIds.join(", ")}`,
      );
    }
    return { projectId: projectArg, project };
  }

  // Only one project — use it
  if (projectIds.length === 1) {
    const projectId = projectIds[0];
    return { projectId, project: config.projects[projectId] };
  }

  // Multiple projects — try matching cwd to a project path (exact or subdir)
  // Note: loadConfig() already expands ~ in project paths via expandPaths()
  const cwdMatch = resolveProjectByCwd({ config, currentDir: cwd() });
  if (cwdMatch) return cwdMatch;

  // No match — error with helpful message
  throw new Error(
    `Multiple projects configured. Specify which one to start:\n  ${projectIds.map((id) => `ao start ${id}`).join("\n  ")}`,
  );
}

/**
 * Resolve project from config by matching against a repo URL's ownerRepo.
 * Used when `ao start <url>` loads an existing multi-project config — the user
 * can't pass both a URL and a project name since they share the same arg slot.
 *
 * Falls back to `resolveProject` (which handles single-project configs or
 * errors with a helpful message for ambiguous multi-project cases).
 */
function resolveProjectByRepo(
  config: OrchestratorConfig,
  parsed: ParsedRepoUrl,
): { projectId: string; project: ProjectConfig } {
  const projectIds = Object.keys(config.projects);

  // Try to match by repo field (e.g. "owner/repo")
  for (const id of projectIds) {
    const project = config.projects[id];
    if (project.repo === parsed.ownerRepo) {
      return { projectId: id, project };
    }
  }

  // No repo match — fall back to standard resolution (works for single-project)
  return resolveProject(config);
}

/**
 * Clone a repo with authentication support.
 *
 * Strategy:
 *   1. Try `gh repo clone owner/repo target -- --depth 1` — handles GitHub auth
 *      for private repos via the user's `gh auth` token.
 *   2. Fall back to `git clone --depth 1` with SSH URL — works for users with
 *      SSH keys configured (common for private repos without gh).
 *   3. Final fallback to `git clone --depth 1` with HTTPS URL — works for
 *      public repos without any auth setup.
 */
async function cloneRepo(parsed: ParsedRepoUrl, targetDir: string, cwd: string): Promise<void> {
  // 1. Try gh repo clone (handles GitHub auth automatically)
  if (parsed.host === "github.com") {
    const ghAvailable = (await execSilent("gh", ["auth", "status"])) !== null;
    if (ghAvailable) {
      try {
        await exec("gh", ["repo", "clone", parsed.ownerRepo, targetDir, "--", "--depth", "1"], {
          cwd,
        });
        return;
      } catch {
        // gh clone failed — fall through to git clone with SSH
      }
    }
  }

  // 2. Try git clone with SSH URL (works with SSH keys for private repos)
  const sshUrl = `git@${parsed.host}:${parsed.ownerRepo}.git`;
  try {
    await exec("git", ["clone", "--depth", "1", sshUrl, targetDir], { cwd });
    return;
  } catch {
    // SSH failed — fall through to HTTPS
  }

  // 3. Final fallback: HTTPS (works for public repos)
  await exec("git", ["clone", "--depth", "1", parsed.cloneUrl, targetDir], { cwd });
}

/**
 * Handle `ao start <url>` — clone repo, generate config, return loaded config.
 * Also returns the parsed URL so the caller can match by repo when the config
 * contains multiple projects.
 */
async function handleUrlStart(
  url: string,
): Promise<{ config: OrchestratorConfig; parsed: ParsedRepoUrl; autoGenerated: boolean }> {
  const spinner = ora();

  // 1. Parse URL
  spinner.start("Parsing repository URL");
  const parsed = parseRepoUrl(url);
  spinner.succeed(`Repository: ${chalk.cyan(parsed.ownerRepo)} (${parsed.host})`);

  // 2. Determine target directory
  const cwd = process.cwd();
  const targetDir = resolveCloneTarget(parsed, cwd);

  // Guard: refuse to operate on the main repo — use a worktree instead.
  // Must check before cloning or writing any config.
  const mainRepoPath = getMainRepoPath();
  let resolvedTargetDir: string;
  try {
    resolvedTargetDir = realpathSync.native(targetDir);
  } catch {
    resolvedTargetDir = targetDir;
  }
  guardMainRepo(resolvedTargetDir, mainRepoPath);

  const alreadyCloned = isRepoAlreadyCloned(targetDir, parsed.cloneUrl);

  // 3. Clone or reuse
  if (alreadyCloned) {
    console.log(chalk.green(`  Reusing existing clone at ${targetDir}`));
  } else {
    spinner.start(`Cloning ${parsed.ownerRepo}`);
    try {
      await cloneRepo(parsed, targetDir, cwd);
      spinner.succeed(`Cloned to ${targetDir}`);
    } catch (err) {
      spinner.fail("Clone failed");
      throw new Error(
        `Failed to clone ${parsed.ownerRepo}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  const stagingConfigPath = prepareStagingConfigPath();

  if (existsSync(stagingConfigPath)) {
    const config = loadConfig(stagingConfigPath);
    const existingEntry = Object.entries(config.projects).find(
      ([, project]) =>
        project.repo === parsed.ownerRepo ||
        resolve(project.path.replace(/^~/, process.env["HOME"] || "")) === targetDir,
    );

    if (existingEntry) {
      console.log(chalk.green(`  Using managed staging config: ${stagingConfigPath}`));
      return { config, parsed, autoGenerated: false };
    }

    console.log(
      chalk.green(`  Adding ${parsed.ownerRepo} to staging config: ${stagingConfigPath}`),
    );
    await addProjectToConfig(config, targetDir);
    return { config: loadConfig(stagingConfigPath), parsed, autoGenerated: false };
  }

  // 4. Check for existing repo-local config and migrate it into staging
  const configPath = resolve(targetDir, "agent-orchestrator.yaml");
  const configPathAlt = resolve(targetDir, "agent-orchestrator.yml");

  if (existsSync(configPath)) {
    console.log(chalk.yellow(`  Migrating repo-local config into staging: ${stagingConfigPath}`));
    return {
      config: migrateRepoLocalConfig(configPath, stagingConfigPath),
      parsed,
      autoGenerated: false,
    };
  }

  if (existsSync(configPathAlt)) {
    console.log(chalk.yellow(`  Migrating repo-local config into staging: ${stagingConfigPath}`));
    return {
      config: migrateRepoLocalConfig(configPathAlt, stagingConfigPath),
      parsed,
      autoGenerated: false,
    };
  }

  // 5. Auto-generate config in the managed staging location
  spinner.start("Generating config");
  const freePort = await findFreePort(DEFAULT_PORT);
  const rawConfig = generateConfigFromUrl({
    parsed,
    repoPath: targetDir,
    port: freePort ?? DEFAULT_PORT,
  });

  const yamlContent = configToYaml(rawConfig);
  const config = writeYamlConfig(stagingConfigPath, yamlContent);
  spinner.succeed(`Config generated: ${stagingConfigPath}`);

  return { config, parsed, autoGenerated: true };
}

/**
 * Auto-create agent-orchestrator.yaml when no config exists.
 * Detects environment, project type, and generates config with smart defaults.
 * Returns the loaded config.
 */
export async function autoCreateConfig(workingDir: string): Promise<OrchestratorConfig> {
  console.log(chalk.bold.cyan("\n  Agent Orchestrator — First Run Setup\n"));
  console.log(chalk.dim("  Detecting project and generating config...\n"));

  const env = await detectEnvironment(workingDir);
  const projectType = detectProjectType(workingDir);

  // Show detection results
  if (env.isGitRepo) {
    console.log(chalk.green("  ✓ Git repository detected"));
    if (env.ownerRepo) {
      console.log(chalk.dim(`    Remote: ${env.ownerRepo}`));
    }
    if (env.currentBranch) {
      console.log(chalk.dim(`    Branch: ${env.currentBranch}`));
    }
  }

  if (projectType && (projectType.languages.length > 0 || projectType.frameworks.length > 0)) {
    console.log(chalk.green("  ✓ Project type detected"));
    const formattedType = formatProjectTypeForDisplay(projectType);
    formattedType.split("\n").forEach((line) => {
      console.log(chalk.dim(`    ${line}`));
    });
  }

  console.log();

  const agentRules = generateRulesFromTemplates(projectType);

  // Build config with smart defaults
  const projectId = env.isGitRepo ? basename(workingDir) : "my-project";
  const repo = env.ownerRepo || "owner/repo";
  const path = env.isGitRepo ? workingDir : `~/${projectId}`;
  const defaultBranch = env.defaultBranch || "main";

  const agent = "codex";
  console.log(chalk.green(`  ✓ Agent runtime: ${agent}`));

  const port = await findFreePort(DEFAULT_PORT);
  if (port !== null && port !== DEFAULT_PORT) {
    console.log(chalk.yellow(`  ⚠ Port ${DEFAULT_PORT} is busy — using ${port} instead.`));
  }

  const config: Record<string, unknown> = {
    $schema:
      "https://raw.githubusercontent.com/ComposioHQ/agent-orchestrator/main/schema/config.schema.json",
    port: port ?? DEFAULT_PORT,
    defaults: {
      runtime: "tmux",
      agent,
      workspace: "worktree",
      notifiers: [],
      modelByCli: {
        codex: { model: "gpt-5.4" },
      },
    },
    projects: {
      [projectId]: {
        name: projectId,
        sessionPrefix: generateSessionPrefix(projectId),
        repo,
        path,
        defaultBranch,
        ...(agentRules ? { agentRules } : {}),
      },
    },
  };

  const outputPath = join(workingDir, "agent-orchestrator.yaml");
  if (existsSync(outputPath)) {
    console.log(chalk.yellow(`⚠ Config already exists: ${outputPath}`));
    console.log(chalk.dim("  Use 'ao start' to start with the existing config.\n"));
    return loadConfig(outputPath);
  }
  const yamlContent = yamlStringify(config, { indent: 2 });
  ensureConfigDirectory(outputPath);
  writeFileSync(outputPath, yamlContent, { mode: 0o600 });

  console.log(chalk.green(`✓ Config created: ${outputPath}\n`));

  if (repo === "owner/repo") {
    console.log(chalk.yellow("⚠ Could not detect GitHub remote."));
    console.log(chalk.dim("  Update the 'repo' field in the config before spawning agents.\n"));
  }

  if (!env.hasTmux) {
    console.log(chalk.yellow("⚠ tmux not found — install with: brew install tmux"));
  }
  if (!env.ghAuthed && env.hasGh) {
    console.log(chalk.yellow("⚠ GitHub CLI not authenticated — run: gh auth login"));
  }

  return loadConfig(outputPath);
}

/**
 * Add a new project to an existing config.
 * Detects git info, project type, generates rules, appends to config YAML.
 * Returns the project ID that was added.
 */
async function addProjectToConfig(
  config: OrchestratorConfig,
  projectPath: string,
): Promise<{ projectId: string; project: ProjectConfig }> {
  const resolvedPath = resolve(projectPath.replace(/^~/, process.env["HOME"] || ""));
  let projectId = basename(resolvedPath);

  // Avoid overwriting an existing project with the same directory name
  if (config.projects[projectId]) {
    let i = 2;
    while (config.projects[`${projectId}-${i}`]) i++;
    const newId = `${projectId}-${i}`;
    console.log(
      chalk.yellow(`  ⚠ Project "${projectId}" already exists — using "${newId}" instead.`),
    );
    projectId = newId;
  }

  console.log(chalk.dim(`\n  Adding project "${projectId}"...\n`));

  // Validate git repo
  const isGitRepo = (await git(["rev-parse", "--git-dir"], resolvedPath)) !== null;
  if (!isGitRepo) {
    throw new Error(`"${resolvedPath}" is not a git repository.`);
  }

  // Detect git remote
  let ownerRepo: string | null = null;
  const gitRemote = await git(["remote", "get-url", "origin"], resolvedPath);
  if (gitRemote) {
    const match = gitRemote.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/);
    if (match) ownerRepo = match[1];
  }

  const defaultBranch = await detectDefaultBranch(resolvedPath, ownerRepo);

  // Generate unique session prefix
  let prefix = generateSessionPrefix(projectId);
  const existingPrefixes = new Set(
    Object.values(config.projects).map(
      (p) => p.sessionPrefix || generateSessionPrefix(basename(p.path)),
    ),
  );
  if (existingPrefixes.has(prefix)) {
    let i = 2;
    while (existingPrefixes.has(`${prefix}${i}`)) i++;
    prefix = `${prefix}${i}`;
  }

  // Detect project type and generate rules
  const projectType = detectProjectType(resolvedPath);
  const agentRules = generateRulesFromTemplates(projectType);

  // Show what was detected
  console.log(chalk.green(`  ✓ Git repository`));
  if (ownerRepo) {
    console.log(chalk.dim(`    Remote: ${ownerRepo}`));
  }
  console.log(chalk.dim(`    Default branch: ${defaultBranch}`));
  console.log(chalk.dim(`    Session prefix: ${prefix}`));

  if (projectType && (projectType.languages.length > 0 || projectType.frameworks.length > 0)) {
    console.log(chalk.green("  ✓ Project type detected"));
    const formattedType = formatProjectTypeForDisplay(projectType);
    formattedType.split("\n").forEach((line) => {
      console.log(chalk.dim(`    ${line}`));
    });
  }

  // Load raw YAML, append project, rewrite
  const rawYaml = readFileSync(config.configPath, "utf-8");
  const rawConfig = yamlParse(rawYaml);
  if (!rawConfig.projects) rawConfig.projects = {};

  rawConfig.projects[projectId] = {
    name: projectId,
    repo: ownerRepo || "owner/repo",
    path: resolvedPath,
    defaultBranch,
    sessionPrefix: prefix,
    ...(agentRules ? { agentRules } : {}),
  };

  writeFileSync(config.configPath, yamlStringify(rawConfig, { indent: 2 }));
  console.log(chalk.green(`\n✓ Added "${projectId}" to ${config.configPath}\n`));

  if (!ownerRepo) {
    console.log(chalk.yellow("⚠ Could not detect GitHub remote."));
    console.log(chalk.dim("  Update the 'repo' field in the config before spawning agents.\n"));
  }

  // If this is a global registry config, also write a minimal repo-local config
  const globalConfigPath = process.env["AO_GLOBAL_CONFIG"];
  if (globalConfigPath && globalConfigPath === config.configPath) {
    const localConfigPath = join(resolvedPath, "agent-orchestrator.yaml");
    if (!existsSync(localConfigPath)) {
      writeFileSync(localConfigPath, "agent: claude-code\n");
    }
    console.log(chalk.dim(`  registered in the global config`));
  }

  const addedProject = rawConfig.projects[projectId] as ProjectConfig;
  return { projectId, project: addedProject };
}

/**
 * Create config without starting dashboard/orchestrator.
 * Used by deprecated `ao init` wrapper.
 */
export async function createConfigOnly(): Promise<void> {
  await autoCreateConfig(cwd());
}

/**
 * Start dashboard server in the background.
 * Returns the child process handle for cleanup.
 */
async function startDashboard(
  port: number,
  webDir: string,
  configPath: string | null,
  terminalPort?: number,
  directTerminalPort?: number,
): Promise<ChildProcess> {
  const env = await buildDashboardEnv(port, configPath, terminalPort, directTerminalPort);

  // Detect dev vs production: the `server/` source directory only exists in the
  // monorepo. Published npm packages only have `dist-server/`.
  const isDevMode = existsSync(resolve(webDir, "server"));

  let child: ChildProcess;
  if (isDevMode) {
    // Monorepo development: use pnpm run dev (tsx, HMR, etc.)
    child = spawnManagedDaemonChild("dashboard", "pnpm", ["run", "dev"], {
      cwd: webDir,
      stdio: "inherit",
      detached: !isWindows(),
      env,
    });
  } else {
    // Production (installed from npm): use pre-built start-all script
    child = spawnManagedDaemonChild(
      "dashboard",
      "node",
      [resolve(webDir, "dist-server", "start-all.js")],
      {
        cwd: webDir,
        stdio: "inherit",
        detached: !isWindows(),
        env,
      },
    );
  }

  child.on("error", (err) => {
    console.error(chalk.red("Dashboard failed to start:"), err.message);
    // Emit synthetic exit so callers listening on "exit" can clean up
    child.emit("exit", 1, null);
  });

  return child;
}

/**
 * Shared startup logic: launch dashboard + orchestrator session, print summary.
 * Used by both normal and URL-based start flows.
 */
/**
 * bd-8gld (PR #296): Path for the main agent-orchestrator fork.
 *
 * AO agents must operate in worktrees, never directly in the main clone.
 * Guarding here prevents any codepath (spawn, preflight hooks, etc.) from
 * accidentally writing to the main repo's working tree.
 *
 * Configurable via AO_MAIN_REPO env var for non-default installations.
 * Path comparison uses realpath to canonicalize symlinks, ensuring the guard
 * works even when project.path contains home-dir aliases or relative paths.
 */

// bd-8gld: Resolve the main repo path, with realpath to canonicalize symlinks.
// AO_MAIN_REPO env var overrides the default for custom installations.
// realpathSync.native() resolves symlinks so that e.g. /Users/jleechan →
// /Users/jleechan.chan (if symlinked) matches correctly.
function getMainRepoPath(): string {
  const configured =
    process.env["AO_MAIN_REPO"] || `${homedir()}/project_agento/agent-orchestrator`;
  try {
    // realpathSync.native resolves symlinks on all platforms; falls back to the
    // input path if resolution fails (ENOENT, permission errors, etc.)
    return realpathSync.native(configured);
  } catch {
    return configured;
  }
}

/**
 * Throw if resolvedPath is the main repo or a subdirectory of it.
 * Guard fires before config writes to prevent the main clone from ever
 * being added as an AO project.
 */
function guardMainRepo(resolvedPath: string, mainRepoPath: string): void {
  if (
    resolvedPath === mainRepoPath ||
    resolvedPath.startsWith(mainRepoPath + (process.platform === "win32" ? "\\" : "/"))
  ) {
    throw new Error(
      `Refusing to operate on the main repo (${resolvedPath}). ` +
        `AO agents must run in git worktrees. Create a worktree first with: ` +
        `git worktree add ~/.worktrees/agent-orchestrator/<name> origin/main`,
    );
  }
}

async function runStartup(
  config: OrchestratorConfig,
  projectId: string,
  project: ProjectConfig,
  opts?: { dashboard?: boolean; orchestrator?: boolean; rebuild?: boolean },
): Promise<number> {
  const mainRepoPath = getMainRepoPath();

  // Guard: refuse to operate directly on the main repo — use a worktree instead.
  // realpathSync.native resolves ~/ and any symlinks so the comparison is reliable.
  const projectPath = project.path.replace(/^~\//, `${process.env["HOME"] || ""}/`);
  let resolvedProjectPath: string;
  try {
    resolvedProjectPath = realpathSync.native(projectPath);
  } catch {
    resolvedProjectPath = resolve(projectPath);
  }

  guardMainRepo(resolvedProjectPath, mainRepoPath);

  const sessionId = `${project.sessionPrefix}-orchestrator`;
  const shouldStartLifecycle = opts?.dashboard !== false || opts?.orchestrator !== false;
  let lifecycleStatus: Awaited<ReturnType<typeof ensureLifecycleWorker>> | null = null;
  let port = config.port ?? DEFAULT_PORT;
  const orchestratorSessionStrategy = normalizeOrchestratorSessionStrategy(
    project.orchestratorSessionStrategy,
  );

  console.log(chalk.bold(`\nStarting orchestrator for ${chalk.cyan(project.name)}\n`));

  const spinner = ora();
  let dashboardProcess: ChildProcess | null = null;
  let reused = false;

  // Start dashboard (unless --no-dashboard)
  if (opts?.dashboard !== false) {
    if (!(await isPortAvailable(port))) {
      const newPort = await findFreePort(port + 1);
      if (newPort === null) {
        throw new Error(
          `Port ${port} is busy and no free port found in range ${port + 1}–${port + MAX_PORT_SCAN}. Free port ${port} or set a different 'port' in agent-orchestrator.yaml.`,
        );
      }
      console.log(chalk.yellow(`Port ${port} is busy — using ${newPort} instead.`));
      port = newPort;
    }
    const webDir = findWebDir(); // throws with install-specific guidance if not found
    await preflight.checkBuilt(webDir);

    if (opts?.rebuild) {
      await cleanNextCache(webDir);
    }

    spinner.start("Starting dashboard");
    dashboardProcess = await startDashboard(
      port,
      webDir,
      config.configPath,
      config.terminalPort,
      config.directTerminalPort,
    );
    spinner.succeed(`Dashboard starting on http://localhost:${port}`);
    console.log(chalk.dim("  (Dashboard will be ready in a few seconds)\n"));
  }

  if (shouldStartLifecycle) {
    try {
      spinner.start("Starting lifecycle worker");
      lifecycleStatus = await ensureLifecycleWorker(config, projectId);
      spinner.succeed(
        lifecycleStatus.started
          ? `Lifecycle worker started${lifecycleStatus.pid ? ` (PID ${lifecycleStatus.pid})` : ""}`
          : `Lifecycle worker already running${lifecycleStatus.pid ? ` (PID ${lifecycleStatus.pid})` : ""}`,
      );
    } catch (err) {
      spinner.fail("Lifecycle worker failed to start");
      if (dashboardProcess) {
        dashboardProcess.kill();
      }
      throw new Error(
        `Failed to start lifecycle worker: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  // Create orchestrator session (unless --no-orchestrator or already exists)
  let tmuxTarget = sessionId;
  if (opts?.orchestrator !== false) {
    const sm = await getSessionManager(config);

    try {
      spinner.start("Creating orchestrator session");
      const systemPrompt = generateOrchestratorPrompt({ config, projectId, project });
      const session = await sm.spawnOrchestrator({ projectId, systemPrompt });
      if (session?.runtimeHandle?.id) {
        tmuxTarget = session.runtimeHandle.id;
      }
      reused =
        orchestratorSessionStrategy === "reuse" &&
        session?.metadata?.["orchestratorSessionReused"] === "true";
      spinner.succeed(reused ? "Orchestrator session reused" : "Orchestrator session created");
    } catch (err) {
      spinner.fail("Orchestrator setup failed");
      if (dashboardProcess) {
        dashboardProcess.kill();
      }
      throw new Error(
        `Failed to setup orchestrator: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  // Print summary
  console.log(chalk.bold.green("\n✓ Startup complete\n"));

  if (opts?.dashboard !== false) {
    console.log(chalk.cyan("Dashboard:"), `http://localhost:${port}`);
  }

  if (shouldStartLifecycle && lifecycleStatus) {
    const lifecycleLabel = lifecycleStatus.started ? "started" : "already running";
    const lifecycleTarget = lifecycleStatus.pid
      ? `${lifecycleLabel} (PID ${lifecycleStatus.pid})`
      : lifecycleLabel;
    console.log(chalk.cyan("Lifecycle:"), lifecycleTarget);
  }

  if (opts?.orchestrator !== false && !reused) {
    console.log(chalk.cyan("Orchestrator:"), `tmux attach -t ${tmuxTarget}`);
  } else if (reused) {
    console.log(chalk.cyan("Orchestrator:"), `reused existing session (${sessionId})`);
  }

  console.log(chalk.dim(`Config: ${config.configPath}`));

  // Show next step hint
  const projectIds = Object.keys(config.projects);
  if (projectIds.length > 0) {
    console.log(chalk.bold("\nNext step:\n"));
    console.log(`  Spawn an agent session:`);
    console.log(chalk.cyan(`     ao spawn <issue-number>\n`));
  }

  // Auto-open browser to orchestrator session page once the server is accepting connections.
  // Polls the port instead of using a fixed delay — deterministic and works regardless of
  // how long Next.js takes to compile. AbortController cancels polling on early exit.
  let openAbort: AbortController | undefined;
  if (opts?.dashboard !== false) {
    openAbort = new AbortController();
    const orchestratorUrl = `http://localhost:${port}/sessions/${sessionId}`;
    void waitForPortAndOpen(port, orchestratorUrl, openAbort.signal);
  }

  // Keep dashboard process alive if it was started
  if (dashboardProcess) {
    dashboardProcess.on("exit", (code) => {
      if (openAbort) openAbort.abort();
      if (code !== 0 && code !== null) {
        console.error(chalk.red(`Dashboard exited with code ${code}`));
      }
      process.exit(code ?? 0);
    });
  }

  // When --no-dashboard is used but lifecycle is started, keep the process alive
  // so the monitoring loop in start-all.sh does not see a premature exit.
  // Without this, the process exits immediately (code 0) after spawning the detached
  // lifecycle worker, causing the wrapper to kill all workers and launchd to not restart.
  // Use a timer with unref() so the process can still exit cleanly on signals.
  if (opts?.dashboard === false && shouldStartLifecycle) {
    const keepAlive = setInterval(() => {}, 1 << 30);
    const shutdown = async (): Promise<void> => {
      clearInterval(keepAlive);
      try {
        if (lifecycleStatus?.started) {
          await stopLifecycleWorker(config, projectId);
        }
      } finally {
        process.exit(0);
      }
    };
    process.once("SIGTERM", () => {
      void shutdown();
    });
    process.once("SIGINT", () => {
      void shutdown();
    });
  }

  return port;
}

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerStart(program: Command): void {
  program
    .command("start [project]")
    .summary(
      "Start orchestrator agent and dashboard (auto-creates config on first run, adds projects by path/URL)",
    )
    .description(
      [
        "Start orchestrator agent and dashboard.",
        "",
        "Examples:",
        "  ao start",
        "  ao start ~/path/to/repo",
        "  ao start https://github.com/owner/repo",
        "  ao start --no-dashboard",
        "",
        "Tips:",
        "  - Run from inside a repo to auto-detect the project path.",
        "  - Use this before ao spawn on a new machine or fresh checkout.",
      ].join("\n"),
    )
    .option("--no-dashboard", "Skip starting the dashboard server")
    .option("--no-orchestrator", "Skip starting the orchestrator agent")
    .option("--rebuild", "Clean and rebuild dashboard before starting")
    .option("--interactive", "Interactive mode for agent selection")
    .action(
      async (
        projectArg?: string,
        opts?: {
          dashboard?: boolean;
          orchestrator?: boolean;
          rebuild?: boolean;
          interactive?: boolean;
        },
      ) => {
        try {
          let config: OrchestratorConfig;
          let projectId: string;
          let project: ProjectConfig;

          if (projectArg && isRepoUrl(projectArg)) {
            // ── URL argument: clone + auto-config + start ──
            console.log(chalk.bold.cyan("\n  Agent Orchestrator — Quick Start\n"));
            const result = await handleUrlStart(projectArg);
            config = result.config;
            ({ projectId, project } = resolveProjectByRepo(config, result.parsed));
          } else if (projectArg && isLocalPath(projectArg)) {
            // ── Path argument: add project if new, then start ──
            const resolvedPath = resolve(projectArg.replace(/^~/, process.env["HOME"] || ""));
            // Guard: reject the main repo before any config write
            const mainRepoPath = getMainRepoPath();
            let resolvedPathForGuard: string;
            try {
              resolvedPathForGuard = realpathSync.native(resolvedPath);
            } catch {
              resolvedPathForGuard = resolvedPath;
            }
            guardMainRepo(resolvedPathForGuard, mainRepoPath);

            // Local-path onboarding always targets staging unless the user has
            // explicitly pointed AO_CONFIG_PATH at a different real file.
            const configPath = resolveLocalPathConfigPath();

            if (!configPath) {
              // Guard non-TTY callers before any config write
              if (!isHumanCaller()) {
                const earlyRunning = await isAlreadyRunning();
                if (earlyRunning) {
                  console.log(`AO is already running.`);
                  console.log(`Dashboard: http://localhost:${earlyRunning.port}`);
                  console.log(`PID: ${earlyRunning.pid}`);
                  console.log(`Projects: ${earlyRunning.projects.join(", ")}`);
                  process.exit(0);
                }
              }
              // No staging config yet — auto-create there, then add the path as project
              config = await autoCreateConfig(cwd());
              // If the path is different from cwd, add it as a second project
              if (resolve(cwd()) !== resolvedPath) {
                // Guard already called above before any config write
                ({ projectId, project } = await addProjectToConfig(config, resolvedPath));
                config = loadConfig(config.configPath);
              } else {
                ({ projectId, project } = resolveProject(config));
              }
            } else {
              config = loadConfig(configPath);

              // Check if project is already in config (match by path)
              const existingEntry = Object.entries(config.projects).find(
                ([, p]) =>
                  resolve(p.path.replace(/^~/, process.env["HOME"] || "")) === resolvedPath,
              );

              if (existingEntry) {
                // Already in config — check if AO is already running for this project
                projectId = existingEntry[0];
                project = existingEntry[1];
                const earlyRunning = await isAlreadyRunning();
                if (earlyRunning && earlyRunning.projects.includes(projectId)) {
                  console.log(`AO is already running.`);
                  console.log(`Dashboard: http://localhost:${earlyRunning.port}`);
                  console.log(`PID: ${earlyRunning.pid}`);
                  console.log(`Projects: ${earlyRunning.projects.join(", ")}`);
                  console.log(`${projectId} already registered and running`);
                  process.exit(0);
                }
              } else {
                // Check already-running before mutating YAML for non-TTY callers
                if (!isHumanCaller()) {
                  const earlyRunning = await isAlreadyRunning();
                  if (earlyRunning) {
                    console.log(`AO is already running.`);
                    console.log(`Dashboard: http://localhost:${earlyRunning.port}`);
                    console.log(`PID: ${earlyRunning.pid}`);
                    console.log(`Projects: ${earlyRunning.projects.join(", ")}`);
                    process.exit(0);
                  }
                }
                // New project — add it to config (guard already fired above)
                ({ projectId, project } = await addProjectToConfig(config, resolvedPath));
                config = loadConfig(config.configPath);

                // If AO is already running and this is a global registry, attach via ensureOrchestrator
                const globalConfigPath = process.env["AO_GLOBAL_CONFIG"];
                const liveRunning = await isAlreadyRunning();
                if (liveRunning && globalConfigPath && globalConfigPath === config.configPath) {
                  const sm = await getSessionManager(config);
                  const systemPrompt = generateOrchestratorPrompt({ config, projectId, project });
                  await (
                    sm as unknown as {
                      ensureOrchestrator: (opts: {
                        projectId: string;
                        systemPrompt: string;
                      }) => Promise<unknown>;
                    }
                  ).ensureOrchestrator({ projectId, systemPrompt });
                  console.log(chalk.green(`Orchestrator session ready`));
                  console.log(
                    chalk.dim(`Opening dashboard at http://localhost:${liveRunning.port}`),
                  );
                  process.exit(0);
                }
              }
            }
          } else {
            // ── No arg or project ID: load config or auto-create ──
            let loadedConfig: OrchestratorConfig | null = null;
            try {
              const configPath = findConfigFile();
              if (!configPath) {
                throw new ConfigNotFoundError();
              }
              loadedConfig = loadConfig(configPath);
            } catch (err) {
              if (err instanceof ConfigNotFoundError) {
                // First run — guard against operating on the main repo
                const mainRepoPath = getMainRepoPath();
                let resolvedCwd: string;
                try {
                  resolvedCwd = realpathSync.native(cwd());
                } catch {
                  resolvedCwd = resolve(cwd());
                }
                guardMainRepo(resolvedCwd, mainRepoPath);
                loadedConfig = await autoCreateConfig(cwd());
              } else {
                throw err;
              }
            }
            config = loadedConfig;
            ({ projectId, project } = resolveProject(config, projectArg));
          }

          // ── Already-running detection (Step 9) ──
          const running = await isAlreadyRunning();
          if (running) {
            if (isHumanCaller()) {
              console.log(chalk.cyan(`\nℹ AO is already running.`));
              console.log(`  Dashboard: ${chalk.cyan(`http://localhost:${running.port}`)}`);
              console.log(`  PID: ${running.pid} | Up since: ${running.startedAt}`);
              console.log(`  Projects: ${running.projects.join(", ")}\n`);

              // Detect if cwd is an unregistered git repo to offer "add" option
              const cwdPath = process.cwd();
              const cwdIsGitRepo = existsSync(join(cwdPath, ".git"));
              const cwdAlreadyRegistered =
                config &&
                Object.values(config.projects).some(
                  (p) =>
                    resolve(p.path.replace(/^~/, process.env["HOME"] || "")) === resolve(cwdPath),
                );
              const menuOptions: Array<{ value: string; label: string }> = [
                { value: "open", label: "Open dashboard (keep current)" },
                { value: "new", label: "Start new orchestrator on this project" },
                { value: "restart", label: "Override — restart everything" },
              ];
              if (cwdIsGitRepo && !cwdAlreadyRegistered) {
                menuOptions.splice(1, 0, { value: "add", label: `Add ${cwdPath} to AO` });
              }
              menuOptions.push({ value: "quit", label: "Quit" });

              const choice = await promptSelect("\nWhat would you like to do?", menuOptions);

              if (choice === "open") {
                const url = `http://localhost:${running.port}`;
                const [cmd, args]: [string, string[]] =
                  process.platform === "win32"
                    ? ["cmd.exe", ["/c", "start", "", url]]
                    : [process.platform === "linux" ? "xdg-open" : "open", [url]];
                const opener = execFile(cmd, args);
                opener.once("error", () => {
                  console.warn(
                    chalk.yellow(`Could not open the browser automatically. Open ${url} manually.`),
                  );
                });
                process.exit(0);
              } else if (choice === "add") {
                // Register cwd as a new project in the running AO instance
                ({ projectId, project } = await addProjectToConfig(config, cwdPath));
                config = loadConfig(config.configPath);
                const sm = await getSessionManager(config);
                const systemPrompt = generateOrchestratorPrompt({ config, projectId, project });
                await (
                  sm as unknown as {
                    ensureOrchestrator: (opts: {
                      projectId: string;
                      systemPrompt: string;
                    }) => Promise<unknown>;
                  }
                ).ensureOrchestrator({ projectId, systemPrompt });
                console.log(chalk.green(`Orchestrator session ready`));
                console.log(chalk.dim(`Opening dashboard at http://localhost:${running.port}`));
                process.exit(0);
              } else if (choice === "new") {
                // Generate unique orchestrator: same project, new session
                const rawYaml = readFileSync(config.configPath, "utf-8");
                const rawConfig = yamlParse(rawYaml);

                // Collect existing prefixes to avoid collisions
                const existingPrefixes = new Set(
                  Object.values(rawConfig.projects as Record<string, Record<string, unknown>>)
                    .map((p) => p.sessionPrefix as string)
                    .filter(Boolean),
                );

                let newId: string;
                let newPrefix: string;
                do {
                  const suffix = Math.random().toString(36).slice(2, 6);
                  newId = `${projectId}-${suffix}`;
                  newPrefix = generateSessionPrefix(newId);
                } while (rawConfig.projects[newId] || existingPrefixes.has(newPrefix));

                rawConfig.projects[newId] = {
                  ...rawConfig.projects[projectId],
                  sessionPrefix: newPrefix,
                };
                writeFileSync(config.configPath, yamlStringify(rawConfig, { indent: 2 }));
                console.log(chalk.green(`\n✓ New orchestrator "${newId}" added to config\n`));
                projectId = newId;
                project = rawConfig.projects[newId] as ProjectConfig;
                config = loadConfig(config.configPath);
                // Continue to startup below
              } else if (choice === "restart") {
                await killExistingDaemon(running);
                console.log(chalk.yellow("\n  Stopped existing instance. Restarting...\n"));
                // Continue to startup below
              } else {
                process.exit(0);
              }
            } else {
              // Agent/non-TTY caller — print info and exit
              console.log(`AO is already running.`);
              console.log(`Dashboard: http://localhost:${running.port}`);
              console.log(`PID: ${running.pid}`);
              console.log(`Projects: ${running.projects.join(", ")}`);
              console.log(`To restart: ao stop && ao start`);
              process.exit(0);
            }
          }

          // ── Interactive agent selection ──
          if (opts?.interactive) {
            const { detectAvailableAgents } = await import("../lib/detect-agent.js");
            const globalConfigPath = process.env["AO_GLOBAL_CONFIG"];
            const isGlobalRegistry = !!(globalConfigPath && globalConfigPath === config.configPath);
            const localConfigPath = isGlobalRegistry
              ? join(
                  resolve(project.path.replace(/^~/, process.env["HOME"] || "")),
                  "agent-orchestrator.yaml",
                )
              : null;
            if (localConfigPath) {
              const agents = await detectAvailableAgents();
              const agentOptions = agents.map((a) => ({
                value: a.name,
                label: a.displayName ?? a.name,
              }));
              const orchestratorAgent = await promptSelect(
                "Select orchestrator agent:",
                agentOptions,
              );
              const workerAgent = await promptSelect("Select worker agent:", agentOptions);
              const localYaml = existsSync(localConfigPath)
                ? readFileSync(localConfigPath, "utf-8")
                : "";
              const localRaw = localYaml ? (yamlParse(localYaml) as Record<string, unknown>) : {};
              localRaw["orchestrator"] = { agent: orchestratorAgent };
              localRaw["worker"] = { agent: workerAgent };
              writeFileSync(localConfigPath, yamlStringify(localRaw, { indent: 2 }));
            }
          }

          const actualPort = await runStartup(config, projectId, project, opts);

          // ── Register in running.json (Step 10) ──
          await register({
            pid: process.pid,
            configPath: config.configPath,
            port: actualPort,
            startedAt: new Date().toISOString(),
            projects: Object.keys(config.projects),
          });
        } catch (err) {
          if (err instanceof Error) {
            console.error(chalk.red("\nError:"), err.message);
          } else {
            console.error(chalk.red("\nError:"), String(err));
          }
          process.exit(1);
        }
      },
    );
}

/**
 * Check if arg looks like a local path (not a project ID).
 * Paths contain / or ~ or . at the start.
 */
function isLocalPath(arg: string): boolean {
  return arg.startsWith("/") || arg.startsWith("~") || arg.startsWith("./") || arg.startsWith("..");
}

export function registerStop(program: Command): void {
  program
    .command("stop [project]")
    .description("Stop orchestrator agent and dashboard")
    .option("--purge-session", "Delete mapped OpenCode session when stopping")
    .option("--all", "Stop all running AO instances")
    .action(async (projectArg?: string, opts: { purgeSession?: boolean; all?: boolean } = {}) => {
      try {
        // Check running.json first
        const running = await getRunning();

        if (opts.all) {
          // Full stop: kill parent process and all daemon children, then unregister
          if (running) {
            await killExistingDaemon(running);
            console.log(chalk.green(`\n✓ Stopped AO on port ${running.port}`));
            console.log(chalk.dim(`  Projects: ${running.projects.join(", ")}\n`));
          } else {
            // running.json missing (crash/recovery) — sweep any orphaned daemon children
            await sweepDaemonChildren({ ownerPid: process.pid }).catch(() => {});
            console.log(chalk.yellow("No running AO instance found in running.json."));
          }
          return;
        }

        if (!projectArg && running) {
          // No-arg + running instance → full stop of parent process
          await killExistingDaemon(running);
          console.log(chalk.green(`\n✓ Stopped AO on port ${running.port}`));
          console.log(chalk.dim(`  Projects: ${running.projects.join(", ")}\n`));
          return;
        }

        // Targeted stop: kill only sessions for the named project; do NOT kill
        // the parent daemon (it may still be serving other projects).
        const config = loadConfig();
        const { projectId } = resolveProject(config, projectArg);
        const sm = await getSessionManager(config);
        const purgeOpenCode = opts.purgeSession === true;

        if (projectArg && running) {
          // Named project + running instance: kill all sessions for this project
          const allSessions = await sm.list();
          const projectSessions = allSessions.filter(
            (s: { projectId: string; id: string }) => s.projectId === projectId,
          );
          const sessionIds = projectSessions.map((s: { projectId: string; id: string }) => s.id);
          for (const session of projectSessions) {
            await sm.kill(session.id, { purgeOpenCode });
          }
          await writeLastStop({ projectId, sessionIds });
        } else {
          const allSessions = await sm.list();
          const projectSessions = allSessions.filter(
            (s: { projectId: string; id: string }) => s.projectId === projectId,
          );
          const sessionIds = projectSessions.map((s: { projectId: string; id: string }) => s.id);
          if (projectSessions.length > 0) {
            for (const session of projectSessions) {
              await sm.kill(session.id, { purgeOpenCode });
            }
            await writeLastStop({ projectId, sessionIds });
            console.log(chalk.bold.green("Orchestrator stopped"));
          } else {
            await writeLastStop({ projectId, sessionIds: [] });
            console.log(chalk.yellow("Orchestrator is not running"));
          }
          await stopLifecycleWorker(config, projectId);
        }

        console.log(chalk.bold.green("\n✓ Project stopped\n"));
        console.log(chalk.dim(`  Projects: ${Object.keys(config.projects).join(", ")}\n`));
      } catch (err) {
        if (err instanceof Error) {
          console.error(chalk.red("\nError:"), err.message);
        } else {
          console.error(chalk.red("\nError:"), String(err));
        }
        process.exit(1);
      }
    });
}
