import { type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, basename } from "node:path";
import { cwd } from "node:process";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import {
  loadConfig,
  generateOrchestratorPrompt,
  generateSessionPrefix,
  getOrchestratorSessionId,
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
  isCanonicalGlobalConfigPath,
  isTerminalSession,
  getGlobalConfigPath,
  isWindows,
  isMac,
  isLinux,
  findPidByPort,
  killProcessTree,
  loadLocalProjectConfigDetailed,
  registerProjectInGlobalConfig,
  writeLocalProjectConfig,
  spawnManagedDaemonChild,
  sweepDaemonChildren,
  scanAoOrphans,
  reapAoOrphans,
  type OrchestratorConfig,
  type LocalProjectConfig,
  type ProjectConfig,
  type ParsedRepoUrl,
  type DaemonChildSweepResult,
  type AoOrphanProcess,
  ConfigNotFoundError,
} from "@jleechanorg/ao-core";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { exec, execSilent, git } from "../lib/shell.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { ensureLifecycleWorker, stopLifecycleWorker, listLifecycleWorkers, stopAllLifecycleWorkers } from "../lib/lifecycle-service.js";
import { startBunTmpJanitor } from "../lib/bun-tmp-janitor.js";
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
import { runtimePreflight, ensureGit } from "../lib/startup-preflight.js";
import {
  register,
  unregister,
  isAlreadyRunning,
  getRunning,
  waitForExit,
  acquireStartupLock,
  writeLastStop,
  readLastStop,
  clearLastStop,
  type RunningState,
} from "../lib/running-state.js";
import { attachToDaemon, killExistingDaemon } from "../lib/daemon.js";
import { startProjectSupervisor } from "../lib/project-supervisor.js";
import { isHumanCaller } from "../lib/caller-context.js";
import { detectEnvironment } from "../lib/detect-env.js";
import {
  detectAgentRuntime,
  detectAvailableAgents,
  type DetectedAgent,
} from "../lib/detect-agent.js";
import { detectDefaultBranch } from "../lib/git-utils.js";
import { promptConfirm, promptSelect, promptText } from "../lib/prompts.js";
import { extractOwnerRepo, isValidRepoString } from "../lib/repo-utils.js";
import {
  detectProjectType,
  generateRulesFromTemplates,
  formatProjectTypeForDisplay,
} from "../lib/project-detection.js";
import { formatCommandError } from "../lib/cli-errors.js";
import { findProjectForDirectory } from "../lib/project-resolution.js";
import {
  type InstallAttempt,
  canPromptForInstall,
  genericInstallHints,
  askYesNo,
  runInteractiveCommand,
  tryInstallWithAttempts,
} from "../lib/install-helpers.js";
import { installShutdownHandlers, isShutdownInProgress } from "../lib/shutdown.js";
import { resolveOrCreateProject } from "../lib/resolve-project.js";
import { pathsEqual } from "../lib/path-equality.js";
import { maybePromptForUpdateChannel } from "../lib/update-channel-onboarding.js";

import { DEFAULT_PORT } from "../lib/constants.js";
import { projectSessionUrl } from "../lib/routes.js";
import { resolveProjectByCwd } from "../lib/resolve-project-cwd.js";

function openUrl(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "win32"
      ? ["cmd.exe", ["/c", "start", "", url]]
      : [process.platform === "linux" ? "xdg-open" : "open", [url]];
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  spawn(cmd, args, { stdio: "ignore" });
}

const DEFAULT_AGENT = "codex";

function ensureConfigDirectory(configPath: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
}

function formatTopologyProblems(problems: ReturnType<typeof validateManagedConfigTopology>): string {
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

function readProjectBehaviorConfig(projectPath: string): LocalProjectConfig {
  const localConfig = loadLocalProjectConfigDetailed(projectPath);
  if (localConfig.kind === "loaded") {
    return { ...localConfig.config };
  }
  return {};
}

function writeProjectBehaviorConfig(projectPath: string, config: LocalProjectConfig): void {
  writeLocalProjectConfig(projectPath, config);
}

async function registerFlatConfig(configPath: string): Promise<string | null> {
  const projectPath = resolve(dirname(configPath));
  const projectId = basename(projectPath);

  const raw = readFileSync(configPath, "utf-8");
  const parsed = yamlParse(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object") return null;
  if ("projects" in parsed) return null;

  const repo = typeof parsed["repo"] === "string" ? parsed["repo"] : undefined;
  const defaultBranch =
    typeof parsed["defaultBranch"] === "string"
      ? parsed["defaultBranch"]
      : await detectDefaultBranch(projectPath, repo ?? null);
  const prefixInput = projectId.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  const prefix = generateSessionPrefix(prefixInput || projectId);

  console.log(chalk.dim(`\n  Registering project "${projectId}" in global config...\n`));

  const registeredProjectId = registerProjectInGlobalConfig(projectId, projectId, projectPath, {
    defaultBranch,
    sessionPrefix: prefix,
    ...(repo ? { repo } : {}),
  });

  console.log(chalk.green(`  ✓ Registered "${registeredProjectId}"\n`));
  return registeredProjectId;
}

async function resolveProject(
  config: OrchestratorConfig,
  projectArg?: string,
  action = "start",
): Promise<{ projectId: string; project: ProjectConfig; config: OrchestratorConfig }> {
  const projectIds = Object.keys(config.projects);

  if (projectIds.length === 0) {
    throw new Error("No projects configured. Add a project to agent-orchestrator.yaml.");
  }

  if (projectArg) {
    const project = config.projects[projectArg];
    if (!project) {
      throw new Error(
        `Project "${projectArg}" not found. Available projects:\n  ${projectIds.join(", ")}`,
      );
    }
    return { projectId: projectArg, project, config };
  }

  if (projectIds.length === 1) {
    const projectId = projectIds[0];
    return { projectId, project: config.projects[projectId], config };
  }

  const currentDir = resolve(cwd());
  const cwdMatch = resolveProjectByCwd({ config, currentDir });
  if (cwdMatch) return { ...cwdMatch, config };

  const matchedProjectId = findProjectForDirectory(config.projects, currentDir);
  if (matchedProjectId) {
    return { projectId: matchedProjectId, project: config.projects[matchedProjectId], config };
  }

  if (isHumanCaller()) {
    const currentDirResolved = resolve(cwd());
    const cwdAlreadyInConfig = projectIds.some((id) => {
      try {
        return pathsEqual(config.projects[id].path, currentDirResolved);
      } catch {
        return false;
      }
    });
    const cwdIsGitRepo = existsSync(resolve(currentDirResolved, ".git"));
    const addOption =
      !cwdAlreadyInConfig && cwdIsGitRepo
        ? [
            {
              value: "__add_cwd__",
              label: `Add ${basename(currentDirResolved)}`,
              hint: "register this directory as a new project",
            },
          ]
        : [];

    const selectedId = await promptSelect(`Choose project to ${action}:`, [
      ...projectIds.map((id) => ({
        value: id,
        label: config.projects[id].name ?? id,
        hint: id,
      })),
      ...addOption,
    ]);

    if (selectedId === "__add_cwd__") {
      const addedId = await addProjectToConfig(config, currentDirResolved);
      const reloadedConfig = loadConfig(config.configPath);
      return {
        projectId: addedId,
        project: reloadedConfig.projects[addedId],
        config: reloadedConfig,
      };
    }

    return { projectId: selectedId, project: config.projects[selectedId], config };
  } else {
    throw new Error(
      `Multiple projects configured. Specify which one to ${action}:\n  ${projectIds.map((id) => `ao ${action} ${id}`).join("\n  ")}`,
    );
  }
}

async function resolveProjectByRepo(
  config: OrchestratorConfig,
  parsed: ParsedRepoUrl,
): Promise<{ projectId: string; project: ProjectConfig; config: OrchestratorConfig }> {
  const projectIds = Object.keys(config.projects);

  for (const id of projectIds) {
    const project = config.projects[id];
    if (project.repo === parsed.ownerRepo) {
      return { projectId: id, project, config };
    }
  }

  return await resolveProject(config);
}

async function promptAgentSelection(): Promise<{
  orchestratorAgent: string;
  workerAgent: string;
} | null> {
  if (canPromptForInstall()) {
    const available = await detectAvailableAgents();
    if (available.length === 0) {
      console.log(chalk.yellow("No agent runtimes detected — using existing config."));
      return null;
    }

    const agentOptions = available.map((a) => ({ value: a.name, label: a.displayName }));
    const orchestratorAgent = await promptSelect("Orchestrator agent:", agentOptions);
    const workerAgent = await promptSelect("Worker agent:", agentOptions);

    return { orchestratorAgent, workerAgent };
  } else {
    return null;
  }
}

async function cloneRepo(parsed: ParsedRepoUrl, targetDir: string, cwd: string): Promise<void> {
  if (parsed.host === "github.com") {
    const ghAvailable = (await execSilent("gh", ["auth", "status"])) !== null;
    if (ghAvailable) {
      try {
        await exec("gh", ["repo", "clone", parsed.ownerRepo, targetDir, "--", "--depth", "1"], {
          cwd,
        });
        return;
      } catch {
      }
    }
  }

  const sshUrl = `git@${parsed.host}:${parsed.ownerRepo}.git`;
  try {
    await exec("git", ["clone", "--depth", "1", sshUrl, targetDir], { cwd });
    return;
  } catch {
  }

  await exec("git", ["clone", "--depth", "1", parsed.cloneUrl, targetDir], { cwd });
}

async function handleUrlStart(
  url: string,
): Promise<{ config: OrchestratorConfig; parsed: ParsedRepoUrl; autoGenerated: boolean }> {
  const spinner = ora();

  spinner.start("Parsing repository URL");
  const parsed = parseRepoUrl(url);
  spinner.succeed(`Repository: ${chalk.cyan(parsed.ownerRepo)} (${parsed.host})`);

  const cwd = process.cwd();
  const targetDir = resolveCloneTarget(parsed, cwd);

  const mainRepoPath = getMainRepoPath();
  let resolvedTargetDir: string;
  try {
    resolvedTargetDir = realpathSync.native(targetDir);
  } catch {
    resolvedTargetDir = targetDir;
  }
  guardMainRepo(resolvedTargetDir, mainRepoPath);

  const alreadyCloned = isRepoAlreadyCloned(targetDir, parsed.cloneUrl);

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

    console.log(chalk.green(`  Adding ${parsed.ownerRepo} to staging config: ${stagingConfigPath}`));
    await addProjectToConfig(config, targetDir);
    return { config: loadConfig(stagingConfigPath), parsed, autoGenerated: false };
  }

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

export async function autoCreateConfig(workingDir: string): Promise<OrchestratorConfig> {
  console.log(chalk.bold.cyan("\n  Agent Orchestrator — First Run Setup\n"));
  console.log(chalk.dim("  Detecting project and generating config...\n"));

  const env = await detectEnvironment(workingDir);
  const projectType = detectProjectType(workingDir);

  if (env.isGitRepo) {
    console.log(chalk.green("  ✓ Git repository detected"));
    if (env.ownerRepo) {
      console.log(chalk.dim(`    Remote: ${env.ownerRepo}`));
    }
    if (env.currentBranch) {
      console.log(chalk.dim(`    Branch: ${env.currentBranch}`));
    }
  }

  if (projectType.languages.length > 0 || projectType.frameworks.length > 0) {
    console.log(chalk.green("  ✓ Project type detected"));
    const formattedType = formatProjectTypeForDisplay(projectType);
    formattedType.split("\n").forEach((line) => {
      console.log(chalk.dim(`    ${line}`));
    });
  }

  console.log();

  const agentRules = generateRulesFromTemplates(projectType);

  const projectId = basename(workingDir);
  const repo = env.ownerRepo || "owner/repo";
  const path = env.isGitRepo ? workingDir : `~/${projectId}`;
  const defaultBranch = env.defaultBranch || "main";

  const agent = DEFAULT_AGENT;
  console.log(chalk.green(`  ✓ Agent runtime: ${agent}`));

  const port = await findFreePort(DEFAULT_PORT);
  if (port !== null && port !== DEFAULT_PORT) {
    console.log(chalk.yellow(`  ⚠ Port ${DEFAULT_PORT} is busy — using ${port} instead.`));
  }

  const config: Record<string, unknown> = {
    port: port ?? DEFAULT_PORT,
    defaults: {
      runtime: "tmux",
      agent,
      workspace: "worktree",
      notifiers: ["desktop"],
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

  const outputPath = prepareStagingConfigPath();
  if (existsSync(outputPath)) {
    console.log(chalk.yellow(`⚠ Config already exists: ${outputPath}`));
    console.log(chalk.dim("  Use 'ao start' to start with the existing config.\n"));
    return loadConfig(outputPath);
  }
  const yamlContent = configToYaml(config);
  ensureConfigDirectory(outputPath);
  writeFileSync(outputPath, yamlContent, { mode: 0o600 });

  console.log(chalk.green(`✓ Config created: ${outputPath}\n`));

  try {
    const registeredProjectId = registerProjectInGlobalConfig(projectId, projectId, path, {
      defaultBranch,
      sessionPrefix: generateSessionPrefix(projectId),
    });
    console.log(chalk.green(`✓ Registered "${registeredProjectId}" in global config\n`));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.yellow("⚠ Could not register project in global config."));
    console.log(chalk.dim(`  ${message}\n`));
  }

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

async function addProjectToConfig(
  config: OrchestratorConfig,
  projectPath: string,
): Promise<string> {
  const resolvedPath = resolve(projectPath.replace(/^~/, process.env["HOME"] || ""));

  const existingByPath = Object.entries(config.projects).find(([, p]) => {
    try {
      return pathsEqual(p.path, resolvedPath);
    } catch {
      return false;
    }
  });
  if (existingByPath) {
    console.log(
      chalk.dim(`  Path already configured as project "${existingByPath[0]}" — skipping add.`),
    );
    return existingByPath[0];
  }

  await ensureGit("adding projects");

  let projectId = basename(resolvedPath);

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

  const isGitRepo = (await git(["rev-parse", "--git-dir"], resolvedPath)) !== null;
  if (!isGitRepo) {
    throw new Error(`"${resolvedPath}" is not a git repository.`);
  }

  let ownerRepo: string | null = null;
  const gitRemote = await git(["remote", "get-url", "origin"], resolvedPath);
  if (gitRemote) {
    ownerRepo = extractOwnerRepo(gitRemote);
  }

  const defaultBranch = await detectDefaultBranch(resolvedPath, ownerRepo);

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

  const projectType = detectProjectType(resolvedPath);
  const agentRules = generateRulesFromTemplates(projectType);

  console.log(chalk.green(`  ✓ Git repository`));
  if (ownerRepo) {
    console.log(chalk.dim(`    Remote: ${ownerRepo}`));
  }
  console.log(chalk.dim(`    Default branch: ${defaultBranch}`));
  console.log(chalk.dim(`    Session prefix: ${prefix}`));

  if (projectType.languages.length > 0 || projectType.frameworks.length > 0) {
    console.log(chalk.green("  ✓ Project type detected"));
    const formattedType = formatProjectTypeForDisplay(projectType);
    formattedType.split("\n").forEach((line) => {
      console.log(chalk.dim(`    ${line}`));
    });
  }

  if (isCanonicalGlobalConfigPath(config.configPath)) {
    const registeredProjectId = registerProjectInGlobalConfig(
      projectId,
      projectId,
      resolvedPath,
      { defaultBranch, sessionPrefix: prefix },
      config.configPath,
    );

    writeProjectBehaviorConfig(resolvedPath, agentRules ? { agentRules } : {});

    console.log(chalk.green(`\n✓ Added "${registeredProjectId}" to ${config.configPath}\n`));
    return registeredProjectId;
  } else {
    const rawYaml = readFileSync(config.configPath, "utf-8");
    const rawConfig = yamlParse(rawYaml);
    if (!rawConfig.projects) rawConfig.projects = {};

    rawConfig.projects[projectId] = {
      name: projectId,
      ...(ownerRepo ? { repo: ownerRepo } : {}),
      path: resolvedPath,
      defaultBranch,
      sessionPrefix: prefix,
      ...(agentRules ? { agentRules } : {}),
    };

    writeFileSync(config.configPath, configToYaml(rawConfig as Record<string, unknown>));
    console.log(chalk.green(`\n✓ Added "${projectId}" to ${config.configPath}\n`));
  }

  if (!ownerRepo) {
    console.log(chalk.yellow("⚠ Could not detect GitHub remote."));
    console.log(chalk.dim("  Update the 'repo' field in the config before spawning agents.\n"));
  }

  return projectId;
}

export async function createConfigOnly(): Promise<void> {
  await autoCreateConfig(cwd());
}

async function startDashboard(
  port: number,
  webDir: string,
  configPath: string | null,
  terminalPort?: number,
  directTerminalPort?: number,
  devMode?: boolean,
): Promise<ChildProcess> {
  const env = await buildDashboardEnv(port, configPath, terminalPort, directTerminalPort);

  const isMonorepo = existsSync(resolve(webDir, "server"));
  const useDevServer = isMonorepo && devMode === true;

  let child: ChildProcess;
  if (useDevServer) {
    console.log(chalk.dim("  Mode: development (HMR enabled)"));
    child = spawnManagedDaemonChild("dashboard", "pnpm", ["run", "dev"], {
      cwd: webDir,
      stdio: "inherit",
      detached: !isWindows(),
      env,
    });
  } else {
    if (isMonorepo) {
      console.log(chalk.dim("  Mode: optimized (production bundles)"));
      console.log(chalk.dim("  Tip: use --dev for hot reload when editing dashboard UI\n"));
    }
    const startScript = resolve(webDir, "dist-server", "start-all.js");
    child = spawnManagedDaemonChild("dashboard", "node", [startScript], {
      cwd: webDir,
      stdio: "inherit",
      detached: !isWindows(),
      env,
    });
  }

  child.on("error", (err) => {
    const cmd = useDevServer ? "pnpm" : "node";
    const args = useDevServer ? ["run", "dev"] : [resolve(webDir, "dist-server", "start-all.js")];
    const formatted = formatCommandError(err, {
      cmd,
      args,
      action: "start the AO dashboard",
      installHints: genericInstallHints(cmd),
    });
    console.error(chalk.red("Dashboard failed to start:"), formatted.message);
    child.emit("exit", 1, null);
  });

  return child;
}

function getMainRepoPath(): string {
  const configured =
    process.env["AO_MAIN_REPO"] ||
    `${homedir()}/project_agento/agent-orchestrator`;
  try {
    return realpathSync.native(configured);
  } catch {
    return configured;
  }
}

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
  opts?: { dashboard?: boolean; orchestrator?: boolean; rebuild?: boolean; dev?: boolean },
): Promise<number> {
  await runtimePreflight(config);
  await maybePromptForUpdateChannel();

  installShutdownHandlers({ configPath: config.configPath, projectId });

  const mainRepoPath = getMainRepoPath();

  const projectPath = project.path.replace(/^~\//, `${process.env["HOME"] || ""}/`);
  let resolvedProjectPath: string;
  try {
    resolvedProjectPath = realpathSync.native(projectPath);
  } catch {
    resolvedProjectPath = resolve(projectPath);
  }

  guardMainRepo(resolvedProjectPath, mainRepoPath);

  const sessionId = getOrchestratorSessionId(project);
  const shouldStartLifecycle = opts?.dashboard !== false || opts?.orchestrator !== false;
  let port = config.port ?? DEFAULT_PORT;
  const orchestratorSessionStrategy = normalizeOrchestratorSessionStrategy(
    project.orchestratorSessionStrategy,
  );

  console.log(chalk.bold(`\nStarting orchestrator for ${chalk.cyan(project.name)}\n`));

  const spinner = ora();
  let dashboardProcess: ChildProcess | null = null;
  let reused = false;
  let selectedOrchestratorId: string | null = null;
  let restored = false;

  if (opts?.dashboard !== false) {
    const requestedDashboardPort = port;
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
    const webDir = findWebDir();
    const isMonorepo = existsSync(resolve(webDir, "server"));
    const willUseDevServer = isMonorepo && opts?.dev === true;
    if (opts?.rebuild) {
      await cleanNextCache(webDir);
    } else if (!willUseDevServer) {
      await preflight.checkBuilt(webDir);
    }

    spinner.start("Starting dashboard");
    dashboardProcess = await startDashboard(
      port,
      webDir,
      config.configPath,
      config.terminalPort,
      config.directTerminalPort,
      opts?.dev,
    );
    spinner.succeed(`Dashboard starting on http://localhost:${port}`);
    console.log(chalk.dim("  (Dashboard will be ready in a few seconds)\n"));
  }

  if (opts?.orchestrator !== false) {
    const sm = await getSessionManager(config);

    try {
      spinner.start("Ensuring orchestrator session");
      const systemPrompt = generateOrchestratorPrompt({ config, projectId, project });
      const before = await sm.get(sessionId);
      const session = await sm.ensureOrchestrator({ projectId, systemPrompt });
      selectedOrchestratorId = session.id;
      restored = Boolean(session.restoredAt);
      reused =
        orchestratorSessionStrategy === "reuse" &&
        session.metadata?.["orchestratorSessionReused"] === "true";
      if (before && session.id === before.id && !restored) {
        spinner.succeed(`Using orchestrator session: ${session.id}`);
      } else if (restored) {
        spinner.succeed(`Restored orchestrator session: ${session.id}`);
      } else {
        spinner.succeed(`Orchestrator session ready: ${session.id}`);
      }
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

  if (shouldStartLifecycle) {
    try {
      spinner.start("Starting project supervisor");
      await startProjectSupervisor();
      spinner.succeed("Lifecycle project supervisor started");
    } catch (err) {
      spinner.fail("Project supervisor failed to start");
      if (dashboardProcess) {
        dashboardProcess.kill();
      }
      throw new Error(
        `Failed to start project supervisor: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  if (isHumanCaller()) {
    try {
      const lastStop = await readLastStop();
      if (lastStop && lastStop.sessionIds.length > 0) {
        const stoppedAgo = `stopped at ${new Date(lastStop.stoppedAt).toLocaleString()}`;
        const otherProjects = lastStop.otherProjects ?? [];

        const allRestoreSessions: string[] = [
          ...(lastStop.projectId === projectId ? lastStop.sessionIds : []),
          ...otherProjects.flatMap((p) => p.sessionIds),
        ];

        const currentProjectSessions = lastStop.projectId === projectId ? lastStop.sessionIds : [];
        if (currentProjectSessions.length > 0) {
          console.log(
            chalk.yellow(
              `\n  ${currentProjectSessions.length} session(s) were active before last ao stop (${stoppedAgo}):`,
            ),
          );
          console.log(chalk.dim(`  ${currentProjectSessions.join(", ")}\n`));
        }
        if (otherProjects.length > 0) {
          const otherTotal = otherProjects.reduce((sum, p) => sum + p.sessionIds.length, 0);
          console.log(
            chalk.yellow(`  ${otherTotal} session(s) from other projects were also stopped:`),
          );
          for (const p of otherProjects) {
            console.log(chalk.dim(`  ${p.projectId}: ${p.sessionIds.join(", ")}`));
          }
          console.log();
        }

        if (allRestoreSessions.length > 0) {
          const shouldRestore = await promptConfirm("Restore these sessions?", true);
          if (shouldRestore) {
            let restoreConfig = config;
            if (otherProjects.length > 0) {
              const globalPath = getGlobalConfigPath();
              if (existsSync(globalPath)) {
                restoreConfig = loadConfig(globalPath);
              }
            }
            const sm = await getSessionManager(restoreConfig);
            const restoreSpinner = ora(`Restoring ${allRestoreSessions.length} session(s)`).start();
            let restoredCount = 0;
            const failedSessionIds = new Set<string>();
            const warnings: string[] = [];
            for (const sessId of allRestoreSessions) {
              if (selectedOrchestratorId && sessId === selectedOrchestratorId) {
                restoredCount++;
                continue;
              }
              try {
                await sm.restore(sessId);
                restoredCount++;
              } catch (err) {
                failedSessionIds.add(sessId);
                warnings.push(
                  `  Warning: could not restore ${sessId}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
            if (restoredCount === allRestoreSessions.length) {
              restoreSpinner.succeed(
                `Restored ${restoredCount}/${allRestoreSessions.length} session(s)`,
              );
            } else {
              restoreSpinner.warn(
                `Restored ${restoredCount}/${allRestoreSessions.length} session(s)`,
              );
            }
            for (const w of warnings) {
              console.log(chalk.yellow(w));
            }

            if (failedSessionIds.size > 0) {
              const remainingTarget = lastStop.sessionIds.filter((id) => failedSessionIds.has(id));
              const remainingOther = otherProjects
                .map((p) => ({
                  projectId: p.projectId,
                  sessionIds: p.sessionIds.filter((id) => failedSessionIds.has(id)),
                }))
                .filter((p) => p.sessionIds.length > 0);
              if (remainingTarget.length > 0 || remainingOther.length > 0) {
                await writeLastStop({
                  stoppedAt: lastStop.stoppedAt,
                  projectId: lastStop.projectId,
                  sessionIds: remainingTarget,
                  ...(remainingOther.length > 0 ? { otherProjects: remainingOther } : {}),
                });
                console.log(
                  chalk.dim(
                    `  Kept ${failedSessionIds.size} session(s) in last-stop record for retry on next ao start.\n`,
                  ),
                );
              } else {
                await clearLastStop();
              }
            } else {
              await clearLastStop();
            }
          } else {
            await clearLastStop();
          }
        } else {
          await clearLastStop();
        }
      }
    } catch {
    }
  }

  console.log(chalk.bold.green("\n✓ Startup complete\n"));

  if (opts?.dashboard !== false) {
    console.log(chalk.cyan("Dashboard:"), `http://localhost:${port}`);
  }

  if (shouldStartLifecycle) {
    const supervisedProjects = listLifecycleWorkers().sort();
    const projectSummary =
      supervisedProjects.length > 0 ? `: ${supervisedProjects.join(", ")}` : "";
    console.log(
      chalk.cyan("Lifecycle:"),
      `supervised (polling ${supervisedProjects.length} project(s)${projectSummary})`,
    );
  }

  if (opts?.orchestrator !== false && selectedOrchestratorId) {
    const restoreNote = restored ? " (restored)" : "";
    const target =
      opts?.dashboard !== false
        ? projectSessionUrl(port, projectId, selectedOrchestratorId)
        : `ao session attach ${selectedOrchestratorId}`;

    console.log(chalk.cyan("Orchestrator:"), `${target}${restoreNote}`);
  }

  console.log(chalk.dim(`Config: ${config.configPath}`));

  const projectIds = Object.keys(config.projects);
  if (projectIds.length > 0) {
    console.log(chalk.bold("\nNext step:\n"));
    console.log(`  Spawn an agent session:`);
    console.log(chalk.cyan(`     ao spawn <issue-number>\n`));
  }

  let openAbort: AbortController | undefined;
  if (opts?.dashboard !== false) {
    openAbort = new AbortController();
    const orchestratorUrl = selectedOrchestratorId
      ? projectSessionUrl(port, projectId, selectedOrchestratorId)
      : `http://localhost:${port}`;
    void waitForPortAndOpen(port, orchestratorUrl, openAbort.signal);
  }

  if (dashboardProcess) {
    dashboardProcess.on("exit", (code) => {
      if (openAbort) openAbort.abort();
      if (isShutdownInProgress()) return;
      if (code !== 0 && code !== null) {
        console.error(chalk.red(`Dashboard exited with code ${code}`));
      }
      process.exit(code ?? 0);
    });
  }

  if (opts?.dashboard === false && shouldStartLifecycle) {
    const keepAlive = setInterval(() => {}, 1 << 30);
    const shutdown = async (): Promise<void> => {
      clearInterval(keepAlive);
        try {
          await stopAllLifecycleWorkers(config);
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

const DASHBOARD_CMD_PATTERN = /next-server|start-all\.js|next dev|ao-web/;

async function killDashboardOnPort(port: number): Promise<boolean> {
  try {
    const pid = await findPidByPort(port);
    if (!pid) return false;

    if (!isWindows()) {
      try {
        const { stdout: cmdline } = await exec("ps", ["-p", String(pid), "-o", "args="]);
        if (!DASHBOARD_CMD_PATTERN.test(cmdline)) return false;
      } catch {
        return false;
      }
    }

    await killProcessTree(Number(pid));
    return true;
  } catch {
    return false;
  }
}

async function stopDashboard(port: number): Promise<void> {
  if (await killDashboardOnPort(port)) {
    console.log(chalk.green("Dashboard stopped"));
    return;
  }

  for (let p = port + 1; p <= port + MAX_PORT_SCAN; p++) {
    if (await killDashboardOnPort(p)) {
      console.log(chalk.green(`Dashboard stopped (was on port ${p})`));
      return;
    }
  }

  console.log(chalk.yellow("Could not stop dashboard (may not be running)"));
}

function formatSweepSummary(result: DaemonChildSweepResult): string {
  return `${result.terminated} graceful, ${result.forceKilled} force-killed${
    result.failed > 0 ? `, ${result.failed} failed` : ""
  }`;
}

async function sweepRegisteredDaemonChildren(ownerPid?: number): Promise<void> {
  const result = await sweepDaemonChildren({ ownerPid });
  if (result.attempted > 0) {
    console.log(
      chalk.dim(
        `  Swept ${result.attempted} registered daemon child(ren): ${formatSweepSummary(result)}`,
      ),
    );
  }
}

function describeAoOrphans(orphans: AoOrphanProcess[]): string {
  return orphans
    .map((orphan) => `${orphan.pid} (${orphan.role})`)
    .slice(0, 8)
    .join(", ");
}

async function maybeSweepAoOrphansOnStart(reapOrphans: boolean | undefined): Promise<void> {
  const orphans = await scanAoOrphans();
  if (orphans.length === 0) return;

  if (!reapOrphans && isHumanCaller()) {
    console.log(
      chalk.yellow(
        `\n  Found ${orphans.length} orphaned AO child process(es): ${describeAoOrphans(orphans)}`,
      ),
    );
    reapOrphans = await promptConfirm("Kill orphaned AO child processes before starting?", true);
  }

  if (!reapOrphans) {
    console.log(
      chalk.yellow(
        `  Found ${orphans.length} orphaned AO child process(es). Run \`ao start --reap-orphans\` to clean them up.`,
      ),
    );
    return;
  }

  const result = await reapAoOrphans(orphans);
  console.log(
    chalk.green(
      `  Reaped ${result.attempted} orphaned AO child process(es): ${formatSweepSummary(result)}`,
    ),
  );
}

async function attachAndSpawnOrchestrator(opts: {
  running: RunningState;
  config: OrchestratorConfig;
  projectId: string;
  project: ProjectConfig;
  justCreated: boolean;
}): Promise<void> {
  const { running, config, projectId, project, justCreated } = opts;
  const daemon = attachToDaemon(running);

  console.log(
    chalk.dim(
      justCreated
        ? "\n  Spawning orchestrator session...\n"
        : "\n  Attaching to running AO instance...\n",
    ),
  );

  const sm = await getSessionManager(config);
  const systemPrompt = generateOrchestratorPrompt({ config, projectId, project });
  const session = await sm.ensureOrchestrator({ projectId, systemPrompt });

  if (justCreated) {
    console.log(chalk.green(`\n✓ Project "${projectId}" registered in the global config.`));
    console.log(chalk.green(`✓ Orchestrator session ready: ${session.id}`));
  } else {
    console.log(chalk.green(`✓ Orchestrator session ready: ${session.id}`));
    console.log(
      chalk.green(`✓ Project "${projectId}" reattached to running daemon (PID ${daemon.pid}).`),
    );
  }

  const notifyResult = await daemon.notifyProjectChange();
  if (notifyResult.ok) {
    console.log(chalk.dim(`  Dashboard config reloaded.`));
  } else {
    console.log(
      chalk.yellow(`  ⚠ ${notifyResult.reason}. Refresh the page if the project doesn't show up.`),
    );
  }

  if (!running.projects.includes(projectId)) {
    console.log(
      chalk.yellow(
        `\nℹ Lifecycle polling for "${projectId}" will attach within ~60s\n` +
          `  because the running ao start process now supervises active global projects.\n`,
      ),
    );
  }

  if (isHumanCaller()) {
    console.log(chalk.dim(`  Opening dashboard: http://localhost:${daemon.port}\n`));
    openUrl(`http://localhost:${daemon.port}`);
  } else {
    console.log(`Dashboard: http://localhost:${daemon.port}`);
  }
}

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
    .option("--dev", "Use Next.js dev server with hot reload (for dashboard UI development)")
    .option("--interactive", "Prompt to configure config settings")
    .option("--reap-orphans", "Kill orphaned AO child processes before starting")
    .action(
      async (
        projectArg?: string,
        opts?: {
          dashboard?: boolean;
          orchestrator?: boolean;
          rebuild?: boolean;
          dev?: boolean;
          interactive?: boolean;
          reapOrphans?: boolean;
        },
      ) => {
        let releaseStartupLock: (() => void) | undefined;
        let startupLockReleased = false;
        const unlockStartup = (): void => {
          if (startupLockReleased || !releaseStartupLock) return;
          startupLockReleased = true;
          releaseStartupLock();
        };

        try {
          releaseStartupLock = await acquireStartupLock();
          await maybeSweepAoOrphansOnStart(opts?.reapOrphans);
          let config: OrchestratorConfig;
          let projectId: string;
          let project: ProjectConfig;

          let running = await isAlreadyRunning();
          let startNewOrchestrator = false;
          const isProjectId = projectArg && !isRepoUrl(projectArg) && !isLocalPath(projectArg);
          const projectArgIsUrlOrPath =
            !!projectArg && (isRepoUrl(projectArg) || isLocalPath(projectArg));

          if (running) {
            if (!isHumanCaller() && !isProjectId) {
              console.log(`AO is already running.`);
              console.log(`Dashboard: http://localhost:${running.port}`);
              console.log(`PID: ${running.pid}`);
              console.log(`Projects: ${running.projects.join(", ")}`);
              console.log(`To restart: ao stop && ao start`);
              unlockStartup();
              process.exit(0);
            }

            if (isHumanCaller() && !projectArg) {
              console.log(chalk.cyan(`\nℹ AO is already running.`));
              console.log(`  Dashboard: ${chalk.cyan(`http://localhost:${running.port}`)}`);
              console.log(`  PID: ${running.pid} | Up since: ${running.startedAt}`);
              console.log(`  Projects: ${running.projects.join(", ")}\n`);

              const cwdResolved = resolve(cwd());
              const cwdIsRegistered = running.projects.some((p) => {
                try {
                  const loadedCfg = loadConfig();
                  const proj = loadedCfg.projects[p];
                  return proj !== undefined && pathsEqual(proj.path, cwdResolved);
                } catch {
                  return false;
                }
              });
              const cwdHasGit = existsSync(resolve(cwdResolved, ".git"));
              const addCwdOption =
                !cwdIsRegistered && cwdHasGit
                  ? [
                      {
                        value: "add",
                        label: `Add ${basename(cwdResolved)}`,
                        hint: "register this directory and start",
                      },
                    ]
                  : [];

              const choice = await promptSelect(
                "AO is already running. What do you want to do?",
                [
                  { value: "open", label: "Open dashboard", hint: "Keep the current instance" },
                  {
                    value: "new",
                    label: "Start new orchestrator",
                    hint: "Add a new session for this project",
                  },
                  ...addCwdOption,
                  {
                    value: "restart",
                    label: "Restart everything",
                    hint: "Stop the current instance first",
                  },
                  { value: "quit", label: "Quit" },
                ],
                "open",
              );

              if (choice === "open") {
                openUrl(`http://localhost:${running.port}`);
                unlockStartup();
                process.exit(0);
              } else if (choice === "quit") {
                unlockStartup();
                process.exit(0);
              } else if (choice === "add") {
                const loadedCfg = loadConfig();
                const addedId = await addProjectToConfig(loadedCfg, cwdResolved);
                console.log(
                  chalk.green(
                    `\n✓ Added "${addedId}" — open the dashboard to start an orchestrator.\n`,
                  ),
                );
                const notifyResult = await attachToDaemon(running).notifyProjectChange();
                if (!notifyResult.ok) {
                  console.log(
                    chalk.yellow(
                      `  ⚠ ${notifyResult.reason}. Refresh the page if the project doesn't show up.`,
                    ),
                  );
                }
                openUrl(`http://localhost:${running.port}`);
                unlockStartup();
                process.exit(0);
              } else if (choice === "new") {
                startNewOrchestrator = true;
              } else if (choice === "restart") {
                await killExistingDaemon(running);
                console.log(chalk.yellow("\n  Stopped existing instance. Restarting...\n"));
                running = null;
              }
            }
          }

          if (projectArg && isRepoUrl(projectArg)) {
            console.log(chalk.bold.cyan("\n  Agent Orchestrator — Quick Start\n"));
            const result = await handleUrlStart(projectArg);
            config = result.config;
            const resolved = await resolveProjectByRepo(config, result.parsed);
            projectId = resolved.projectId;
            project = resolved.project;
            config = resolved.config;
          } else if (projectArg && isLocalPath(projectArg)) {
            const resolvedPath = resolve(projectArg.replace(/^~/, process.env["HOME"] || ""));
            const mainRepoPath = getMainRepoPath();
            let resolvedPathForGuard: string;
            try {
              resolvedPathForGuard = realpathSync.native(resolvedPath);
            } catch {
              resolvedPathForGuard = resolvedPath;
            }
            guardMainRepo(resolvedPathForGuard, mainRepoPath);

            const configPath = resolveLocalPathConfigPath();

            if (!configPath) {
              config = await autoCreateConfig(cwd());
              if (resolve(cwd()) !== resolvedPath) {
                const addedId = await addProjectToConfig(config, resolvedPath);
                config = loadConfig(config.configPath);
                projectId = addedId;
                project = config.projects[projectId];
              } else {
                ({ projectId, project, config } = await resolveProject(config));
              }
            } else {
              config = loadConfig(configPath);

              const existingEntry = Object.entries(config.projects).find(
                ([, p]) => resolve(p.path.replace(/^~/, process.env["HOME"] || "")) === resolvedPath,
              );

              if (existingEntry) {
                projectId = existingEntry[0];
                project = existingEntry[1];
              } else {
                const addedId = await addProjectToConfig(config, resolvedPath);
                config = loadConfig(config.configPath);
                projectId = addedId;
                project = config.projects[projectId];
              }
            }
          } else if (!projectArg || isProjectId) {
            let loadedConfig: OrchestratorConfig | null = null;
            try {
              const configPath = findConfigFile();
              if (!configPath) {
                throw new ConfigNotFoundError();
              }
              loadedConfig = loadConfig(configPath);
            } catch (err) {
              if (err instanceof ConfigNotFoundError) {
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
            ({ config, projectId, project } = await resolveProject(loadedConfig, projectArg));
          } else {
            throw new Error("Unreachable: project arg is neither URL, path, nor project ID");
          }

          if (startNewOrchestrator) {
            const rawYaml = readFileSync(config.configPath, "utf-8");
            const rawConfig = yamlParse(rawYaml);

            const existingPrefixes = new Set(
              Object.values(rawConfig.projects as Record<string, Record<string, unknown>>).map(
                (p) => p.sessionPrefix as string,
              ).filter(Boolean),
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
            const nextYaml = isCanonicalGlobalConfigPath(config.configPath)
              ? yamlStringify(rawConfig, { indent: 2 })
              : configToYaml(rawConfig as Record<string, unknown>);
            writeFileSync(config.configPath, nextYaml);
            console.log(chalk.green(`\n✓ New orchestrator "${newId}" added to config\n`));
            config = loadConfig(config.configPath);
            projectId = newId;
            project = config.projects[newId];
          }

          if (running) {
            if (
              projectArgIsUrlOrPath &&
              !startNewOrchestrator &&
              running.projects.includes(projectId)
            ) {
              console.log(chalk.cyan(`\nℹ AO is already running.`));
              console.log(`  Dashboard: ${chalk.cyan(`http://localhost:${running.port}`)}`);
              console.log(`  Project "${projectId}" is already registered and running.\n`);
              openUrl(`http://localhost:${running.port}`);
              unlockStartup();
              process.exit(0);
            }

            await attachAndSpawnOrchestrator({
              running,
              config,
              projectId,
              project,
              justCreated: false,
            });
            unlockStartup();
            process.exit(0);
          }

          const agentOverride = opts?.interactive ? await promptAgentSelection() : null;
          if (agentOverride) {
            const { orchestratorAgent, workerAgent } = agentOverride;

            if (isCanonicalGlobalConfigPath(config.configPath)) {
              const nextLocalConfig = readProjectBehaviorConfig(project.path);
              nextLocalConfig.orchestrator = {
                ...(nextLocalConfig.orchestrator ?? {}),
                agent: orchestratorAgent,
              };
              nextLocalConfig.worker = {
                ...(nextLocalConfig.worker ?? {}),
                agent: workerAgent,
              };
              writeProjectBehaviorConfig(project.path, nextLocalConfig);
              console.log(chalk.dim(`  ✓ Saved to ${project.path}/agent-orchestrator.yaml\n`));
            } else {
              const rawYaml = readFileSync(config.configPath, "utf-8");
              const rawConfig = yamlParse(rawYaml);
              const proj = rawConfig.projects[projectId];
              proj.orchestrator = { ...(proj.orchestrator ?? {}), agent: orchestratorAgent };
              proj.worker = { ...(proj.worker ?? {}), agent: workerAgent };
              writeFileSync(config.configPath, configToYaml(rawConfig as Record<string, unknown>));
              console.log(chalk.dim(`  ✓ Saved to ${config.configPath}\n`));
            }
            config = loadConfig(config.configPath);
            project = config.projects[projectId];
          }

          const actualPort = await runStartup(config, projectId, project, opts);

          await register({
            pid: process.pid,
            configPath: config.configPath,
            port: actualPort,
            startedAt: new Date().toISOString(),
            projects: listLifecycleWorkers(),
          });
          unlockStartup();

          startBunTmpJanitor({
            onSweep: ({ removed, freedBytes, errors }) => {
              if (removed > 0) {
                console.info(
                  `[bun-tmp-janitor] reclaimed ${removed} file(s) / ${freedBytes} bytes`,
                );
              }
              if (errors > 0) {
                console.warn(`[bun-tmp-janitor] sweep had ${errors} error(s)`);
              }
            },
          });
        } catch (err) {
          if (err instanceof Error) {
            console.error(chalk.red("\nError:"), err.message);
          } else {
            console.error(chalk.red("\nError:"), String(err));
          }
          unlockStartup();
          process.exit(1);
        } finally {
          unlockStartup();
        }
      },
    );
}

function isLocalPath(arg: string): boolean {
  if (arg.startsWith("/") || arg.startsWith("~") || arg.startsWith("./") || arg.startsWith("..")) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(arg)) return true;
  if (arg.startsWith("\\\\") || arg.startsWith(".\\") || arg.startsWith("..\\")) return true;
  return false;
}

async function sweepWindowsPtyHostsBeforeParentKill(): Promise<void> {
  if (!isWindows()) return;
  try {
    const mod = (await import("@jleechanorg/ao-plugin-runtime-process")) as {
      sweepWindowsPtyHosts?: () => Promise<{
        attempted: number;
        gracefullyExited: number;
        forceKilled: number;
        failed: number;
      }>;
    };
    if (typeof mod.sweepWindowsPtyHosts !== "function") return;
    const result = await mod.sweepWindowsPtyHosts();
    if (result.attempted > 0) {
      console.log(
        chalk.dim(
          `  Swept ${result.attempted} pty-host(s): ` +
            `${result.gracefullyExited} graceful, ` +
            `${result.forceKilled} force-killed` +
            (result.failed > 0 ? `, ${result.failed} failed` : ""),
        ),
      );
    }
  } catch {
  }
}

export function registerStop(program: Command): void {
  program
    .command("stop [project]")
    .description("Stop orchestrator agent and dashboard")
    .option("--purge-session", "Delete mapped OpenCode session when stopping")
    .option("--all", "Stop all running AO instances")
    .action(
      async (
        projectArg?: string,
        opts: { purgeSession?: boolean; all?: boolean } = {},
      ) => {
        try {
          const running = await getRunning();

          if (opts.all) {
            if (running) {
              await sweepWindowsPtyHostsBeforeParentKill();
              await sweepRegisteredDaemonChildren(running.pid);
              await killProcessTree(running.pid, "SIGTERM");
              await unregister();
              console.log(
                chalk.green(`\n✓ Stopped AO on port ${running.port}`),
              );
              console.log(chalk.dim(`  Projects: ${running.projects.join(", ")}\n`));
            } else {
              console.log(chalk.yellow("No running AO instance found in running.json."));
            }
            return;
          }

          let config = loadConfig();
          if (!projectArg || !config.projects[projectArg]) {
            const globalPath = getGlobalConfigPath();
            if (existsSync(globalPath)) {
              config = loadConfig(globalPath);
            }
          }
          const { projectId: _projectId, project } = await resolveProject(config, projectArg, "stop");
          const port = config.port ?? DEFAULT_PORT;

          console.log(chalk.bold(`\nStopping orchestrator for ${chalk.cyan(project.name)}\n`));

          const sm = await getSessionManager(config);
          try {
            const stopAll = !projectArg;
            const rawSessions = await sm.list(stopAll ? undefined : _projectId);
            const allSessions = stopAll
              ? rawSessions
              : rawSessions.filter((s) => s.projectId === _projectId);
            const activeSessions = allSessions.filter((s) => !isTerminalSession(s));
            const killedSessionIds: string[] = [];

            const targetActive = activeSessions.filter((s) => s.projectId === _projectId);
            const otherActive = activeSessions.filter((s) => s.projectId !== _projectId);
            const otherByProject = new Map<string, string[]>();

            if (activeSessions.length > 0) {
              const spinner = ora(`Stopping ${activeSessions.length} active session(s)`).start();
              const purgeOpenCode = opts?.purgeSession === true;
              const warnings: string[] = [];
              for (const session of activeSessions) {
                try {
                  const result = await sm.kill(session.id, { purgeOpenCode });
                  if (result.cleaned || result.alreadyTerminated) {
                    killedSessionIds.push(session.id);
                  }
                } catch (err) {
                  warnings.push(
                    `  Warning: failed to stop ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              }
              if (killedSessionIds.length === 0) {
                spinner.fail("Failed to stop any sessions");
              } else if (killedSessionIds.length < activeSessions.length) {
                spinner.warn(
                  `Stopped ${killedSessionIds.length}/${activeSessions.length} session(s)`,
                );
              } else {
                spinner.succeed(`Stopped ${killedSessionIds.length} session(s)`);
              }
              for (const w of warnings) {
                console.log(chalk.yellow(w));
              }
              const killedTarget = targetActive
                .filter((s) => killedSessionIds.includes(s.id))
                .map((s) => s.id);
              if (killedTarget.length > 0) {
                console.log(chalk.green(`  ${project.name}: ${killedTarget.join(", ")}`));
              }
              for (const s of otherActive) {
                if (!killedSessionIds.includes(s.id)) continue;
                const list = otherByProject.get(s.projectId ?? "unknown") ?? [];
                list.push(s.id);
                otherByProject.set(s.projectId ?? "unknown", list);
              }
              for (const [pid, ids] of otherByProject) {
                console.log(chalk.green(`  ${pid}: ${ids.join(", ")}`));
              }
            } else {
              console.log(chalk.yellow(`No active sessions found`));
            }

            if (killedSessionIds.length > 0) {
              const otherProjects: Array<{ projectId: string; sessionIds: string[] }> = [];
              for (const [pid, ids] of otherByProject) {
                otherProjects.push({ projectId: pid, sessionIds: ids });
              }

              await writeLastStop({
                stoppedAt: new Date().toISOString(),
                projectId: _projectId,
                sessionIds: killedSessionIds.filter((id) => targetActive.some((s) => s.id === id)),
                otherProjects: otherProjects.length > 0 ? otherProjects : undefined,
              });
            }
          } catch (err) {
            console.log(
              chalk.yellow(
                `  Could not list sessions: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          }

          if (!projectArg) {
            if (running) {
              await sweepWindowsPtyHostsBeforeParentKill();
              await sweepRegisteredDaemonChildren(running.pid);
              await killProcessTree(running.pid, "SIGTERM");
              await unregister();
            } else {
              await sweepRegisteredDaemonChildren();
            }
            await stopDashboard(running?.port ?? port);
          }

          if (projectArg) {
            console.log(chalk.bold.green(`\n✓ Stopped sessions for ${project.name}\n`));
          } else {
            console.log(chalk.bold.green("\n✓ Orchestrator stopped\n"));
            console.log(
              chalk.dim(`  Uptime: since ${running?.startedAt ?? "unknown"}`),
            );
            console.log(
              chalk.dim(`  Projects: ${Object.keys(config.projects).join(", ")}\n`),
            );
          }
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
