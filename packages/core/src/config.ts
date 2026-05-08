/**
 * Configuration loader — reads agent-orchestrator.yaml and validates with Zod.
 *
 * Minimal config that just works:
 *   projects:
 *     my-app:
 *       repo: org/repo
 *       path: ~/my-app
 *
 * Everything else has sensible defaults.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join, basename, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ConfigNotFoundError, type OrchestratorConfig } from "./types.js";
import { applyEnvSource } from "./env-source.js";

/** Ensures envSource is bootstrapped exactly once per process lifetime. */
let _envBootstrapDone = false;
import { findManagedConfigFile, getLegacyConfigPaths } from "./config-topology.js";
import { generateSessionPrefix, expandHome } from "./paths.js";

function inferScmPlugin(project: {
  repo: string;
  scm?: Record<string, unknown>;
  tracker?: Record<string, unknown>;
}): "github" | "gitlab" {
  const scmPlugin = project.scm?.["plugin"];
  if (scmPlugin === "gitlab") {
    return "gitlab";
  }

  const scmHost = project.scm?.["host"];
  if (typeof scmHost === "string" && scmHost.toLowerCase().includes("gitlab")) {
    return "gitlab";
  }

  const trackerPlugin = project.tracker?.["plugin"];
  if (trackerPlugin === "gitlab") {
    return "gitlab";
  }

  const trackerHost = project.tracker?.["host"];
  if (typeof trackerHost === "string" && trackerHost.toLowerCase().includes("gitlab")) {
    return "gitlab";
  }

  return "github";
}

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

const ReactionConfigSchema = z.object({
  auto: z.boolean().default(true),
  action: z
    .enum(["send-to-agent", "notify", "auto-merge", "request-merge", "parallel-retry", "skeptic-review", "respawn-for-review", "claim-verification"])
    .default("notify"),
  message: z.string().optional(),
  priority: z.enum(["urgent", "action", "warning", "info"]).optional(),
  retries: z.number().optional(),
  escalateAfter: z.union([z.number(), z.string()]).optional(),
  threshold: z.string().optional(),
  includeSummary: z.boolean().optional(),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
  autoMergeWaitSeconds: z.number().optional(),
  // bd-uxs.3: Failure budget fields
  failureBudget: z
    .object({
      max: z.number().int().positive(),
      window: z.string().optional(),
    })
    .optional(),
  onBudgetExhausted: z.enum(["escalate", "disable", "route-to", "notify"]).optional(),
  routeToAgent: z.string().optional(),
  // bd-uxs.4: Parallel retry fields
  parallelRetry: z
    .object({
      maxParallel: z.number().int().positive(),
      strategies: z.array(z.string()),
      killOnSuccess: z.boolean().optional(),
    })
    .optional(),
  // bd-skp2: Skeptic review fields
  skepticModel: z.enum(["codex", "claude", "gemini"]).optional(),
  skepticPostComment: z.boolean().optional(),
  skepticExcludePaths: z.array(z.string()).optional(),
});

const TrackerConfigSchema = z
  .object({
    plugin: z.string(),
  })
  .passthrough();

const SCMConfigSchema = z
  .object({
    plugin: z.string(),
    webhook: z
      .object({
        enabled: z.boolean().default(true),
        path: z.string().optional(),
        secretEnvVar: z.string().optional(),
        signatureHeader: z.string().optional(),
        eventHeader: z.string().optional(),
        deliveryHeader: z.string().optional(),
        maxBodyBytes: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .passthrough();

const NotifierConfigSchema = z
  .object({
    plugin: z.string(),
  })
  .passthrough();

const AgentPermissionSchema = z
  .enum(["permissionless", "default", "auto-edit", "suggest", "skip", "auto"])
  .default("permissionless")
  .transform((value) => (value === "skip" || value === "auto" ? "permissionless" : value));

const AgentSpecificConfigSchema = z
  .object({
    permissions: AgentPermissionSchema,
    model: z.string().optional(),
    orchestratorModel: z.string().optional(),
    opencodeSessionId: z.string().optional(),
  })
  .passthrough();

const RoleAgentSpecificConfigSchema = z
  .object({
    permissions: z
      .union([z.enum(["permissionless", "default", "auto-edit", "suggest"]), z.literal("skip"), z.literal("auto")])
      .optional(),
    model: z.string().optional(),
    orchestratorModel: z.string().optional(),
    opencodeSessionId: z.string().optional(),
  })
  .passthrough();

const RoleAgentDefaultsSchema = z
  .object({
    agent: z.string().optional(),
    agentConfig: RoleAgentSpecificConfigSchema.optional(),
  })
  .optional();

/** Only `model` / `orchestratorModel` are read for CLI-keyed defaults; extra keys are rejected. */
const CliModelDefaultsSchema = z
  .object({
    model: z.string().optional(),
    orchestratorModel: z.string().optional(),
  })
  .strict();

const RoleAgentConfigSchema = z
  .object({
    agent: z.string().optional(),
    agentConfig: RoleAgentSpecificConfigSchema.optional(),
  })
  .optional();

const DecomposerConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxDepth: z.number().min(1).max(5).default(3),
    model: z.string().default("claude-sonnet-4-20250514"),
    requireApproval: z.boolean().default(true),
  })
  .default({
    enabled: false,
    maxDepth: 3,
    model: "claude-sonnet-4-20250514",
    requireApproval: true,
  });

// bd-uxs.8: Merge gate config schema
const MergeGateConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    requiredLabels: z.array(z.string()).optional(),
    blockedLabels: z.array(z.string()).optional(),
    requiredChecks: z.array(z.string()).optional(),
    minApprovals: z.number().min(0).int().optional(),
    unchangedFiles: z.array(z.string()).optional(),
    requiredFiles: z.array(z.string()).optional(),
    preMergeWebhook: z.string().url().optional(),
    webhookTimeout: z.number().positive().max(120).default(30),
  })
  .default({})
  .optional();

// bd-bsu: Task queue config schema
const TaskQueueConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxConcurrent: z.number().int().min(1).max(20).default(4),
  beads: z.array(z.string()).default([]),
  taskTemplate: z.string().optional(),
}).optional();

const SpawnQueueConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxActiveSessions: z.number().int().min(1).max(200).default(20),
}).default({});

// bd-jhv1: Manager evolve loop config schema
const EvolveLoopConfigSchema = z.object({
  enabled: z.boolean().optional(),
  pollCadence: z.enum(["lightweight", "standard"]).default("lightweight"),
  autonomousFixScopes: z.array(z.string()).default([]),
  blockedScopes: z.array(z.string()).default([]),
  knowledgeBaseDir: z.string().default("~/.ao-evolve-knowledge"),
  zeroTouchWindow: z.enum(["24h", "30d"]).default("24h"),
});

// Technique config schema (autor research: all techniques converge, SR-prtype is safe default)
const TechniqueConfigSchema = z.object({
  default: z.enum(["SR-prtype", "SR-fewshot", "SR", "ET", "PRM", "default"]).default("SR-prtype"),
  perType: z.record(z.enum(["state-bool", "data-norm", "ci-workflow", "typeddict-schema", "large-arch-refactor", "unknown"]), z.enum(["SR-prtype", "SR-fewshot", "SR", "ET", "PRM", "default"])).optional(),
  thresholds: z.object({
    minScoreDiff: z.number().optional(),
    confidenceN: z.number().optional(),
  }).optional(),
});

/** bd-n047: Defaults schema — enabled defaults to true so omitting it is an implicit enable. */
const AutoMergeDefaultsSchema = z.object({
  enabled: z.boolean().default(true),
  waitSeconds: z.number().int().nonnegative().optional(),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
});
/** bd-n047: Override schema — enabled is optional (absent = inherit). Accepts legacy boolean too. */
const AutoMergeOverrideSchema = z.union([
  z.boolean().transform((v): import("./types.js").AutoMergeConfig => ({ enabled: v })),
  z.object({
    enabled: z.boolean().optional(),
    waitSeconds: z.number().int().nonnegative().optional(),
    mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
  }),
]);

const ProjectConfigSchema = z.object({
  name: z.string().optional(),
  repo: z.string(),
  path: z.string(),
  defaultBranch: z.string().default("main"),
  sessionPrefix: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "sessionPrefix must match [a-zA-Z0-9_-]+")
    .optional(),
  runtime: z.string().optional(),
  agent: z.string().optional(),
  workspace: z.string().optional(),
  tracker: TrackerConfigSchema.optional(),
  scm: SCMConfigSchema.optional(),
  symlinks: z.array(z.string()).optional(),
  postCreate: z.array(z.string()).optional(),
  // RoleAgentSpecificConfigSchema: empty project must not inject permissions: permissionless
  // (which would override defaults.agentConfig.permissions).
  agentConfig: RoleAgentSpecificConfigSchema.default({}),
  modelByCli: z.record(CliModelDefaultsSchema).optional(),
  orchestrator: RoleAgentConfigSchema,
  worker: RoleAgentConfigSchema,
  reactions: z.record(ReactionConfigSchema.partial()).optional(),
  agentRules: z.string().optional(),
  agentRulesFile: z.string().optional(),
  orchestratorRules: z.string().optional(),
  orchestratorSessionStrategy: z
    .enum(["reuse", "delete", "ignore", "delete-new", "ignore-new", "kill-previous"])
    .optional(),
  opencodeIssueSessionStrategy: z.enum(["reuse", "delete", "ignore"]).optional(),
  decomposer: DecomposerConfigSchema.optional(),
  // Central auto-merge switch: overrides approved-and-green reaction action.
  // Inherits from global autoMerge when not set.
  autoMerge: AutoMergeOverrideSchema.optional(),
  // Lifecycle-worker auto-spawns sessions for open PRs without an active worker.
  backfillAllPRs: z.boolean().optional(),
  // bd-uxs.8: Merge gate configuration
  mergeGate: MergeGateConfigSchema.optional(),
  // Override the global worktree base directory for this project.
  worktreeDir: z.string().optional(),
  // bd-6jc: Kill session after this many consecutive SCM failures. Overrides global.
  scmFailureThreshold: z.number().int().min(1).max(100).optional(),

  // Persistent spawn queue + active session cap.
  spawnQueue: SpawnQueueConfigSchema.optional(),

  // bd-bsu: Config-driven bead task queue with maxConcurrent concurrency limit.
  taskQueue: TaskQueueConfigSchema,

  // bd-jhv1: Manager evolve loop configuration
  evolveLoop: EvolveLoopConfigSchema.optional(),

  // Technique selection for AO workers (autor research: all techniques converge, SR-prtype default)
  technique: TechniqueConfigSchema.optional(),
});

const DefaultPluginsSchema = z.object({
  runtime: z.string().default("tmux"),
  agent: z.string().default("codex"),
  workspace: z.string().default("worktree"),
  notifiers: z.array(z.string()).default(["composio"]),
  agentConfig: AgentSpecificConfigSchema.optional(),
  modelByCli: z.record(CliModelDefaultsSchema).optional(),
  orchestrator: RoleAgentDefaultsSchema,
  worker: RoleAgentDefaultsSchema,
  // bd-n047: default auto-merge settings for all projects
  autoMerge: AutoMergeDefaultsSchema.optional(),
  // Phase B: scmFailureThreshold — kills dead-agent sessions after N consecutive SCM failures
  scmFailureThreshold: z.number().int().min(1).max(100).optional(),
  // bd-g884: shell init files to source for API keys; falls back to global envSource
  envSource: z.array(z.string()).optional(),
});

const OrchestratorConfigSchema = z.object({
  port: z.number().default(3000),
  terminalPort: z.number().optional(),
  directTerminalPort: z.number().optional(),
  readyThresholdMs: z.number().nonnegative().default(300_000),
  startupGracePeriodMs: z.number().nonnegative().default(120_000),
  // bd-6jc: Kill dead-agent sessions after this many consecutive SCM failures.
  scmFailureThreshold: z.number().int().min(1).max(100).default(3),
  defaults: DefaultPluginsSchema.default({}),
  projects: z.record(ProjectConfigSchema),
  notifiers: z.record(NotifierConfigSchema).default({}),
  notificationRouting: z.record(z.array(z.string())).default({
    urgent: ["composio"],
    action: ["composio"],
    warning: ["composio"],
    info: ["composio"],
  }),
  reactions: z.record(ReactionConfigSchema).default({}),
  _hasExplicitGlobalReaction: z.record(z.boolean()).optional(),
  plugins: z.record(z.record(z.unknown())).optional(),
  // Central auto-merge switch: enables auto-merge for approved-and-green reaction
  // across all projects unless overridden per-project.
  autoMerge: AutoMergeOverrideSchema.optional(),
  // Global worktree base directory; can be overridden per-project.
  worktreeDir: z.string().optional(),
  // bd-g884: Source shell init files to pull API keys into process.env.
  envSource: z.array(z.string()).default(["~/.bashrc"]),
});

// =============================================================================
// CONFIG LOADING
// =============================================================================

/**
 * Guardrail: reject envSource paths that escape the user's home directory.
 *
 * Config files can live in repo-local .claude/ dirs, so a malicious repo
 * could set `envSource: ["/tmp/evil.sh"]` to exec arbitrary scripts in the
 * AO daemon's PID. We restrict envSource to paths under the caller's home
 * dir (or /etc/environment for system-wide vars).
 */
function assertTrustedEnvSource(entries: string[]): void {
  const homePrefix = `${homedir()}${sep}`;
  for (const entry of entries) {
    const expanded = expandHome(entry);
    if (!isAbsolute(expanded)) {
      throw new Error(
        `Invalid envSource "${entry}": must be an absolute path or start with "~/".`,
      );
    }
    if (
      expanded !== "/etc/environment" &&
      !expanded.startsWith(homePrefix)
    ) {
      throw new Error(
        `Untrusted envSource "${expanded}": only files under ~ or /etc/environment are allowed.`,
      );
    }
  }
}

/** Expand all path fields in the config */
function expandPaths(config: OrchestratorConfig): OrchestratorConfig {
  for (const project of Object.values(config.projects)) {
    project.path = expandHome(project.path);
  }

  return config;
}

/** Apply defaults to project configs */
function applyProjectDefaults(config: OrchestratorConfig): OrchestratorConfig {
  for (const [id, project] of Object.entries(config.projects)) {
    // Derive name from project ID if not set
    if (!project.name) {
      project.name = id;
    }

    // Derive session prefix from project path basename if not set
    if (!project.sessionPrefix) {
      const projectId = basename(project.path);
      project.sessionPrefix = generateSessionPrefix(projectId);
    }

    const inferredPlugin = inferScmPlugin(project);

    // Infer SCM from repo if not set
    if (!project.scm && project.repo.includes("/")) {
      project.scm = { plugin: inferredPlugin };
    }

    // Infer tracker from repo if not set (default to github issues)
    if (!project.tracker) {
      project.tracker = { plugin: inferredPlugin };
    }
  }

  return config;
}

/** Validate project uniqueness and session prefix collisions */
function validateProjectUniqueness(config: OrchestratorConfig): void {
  // Check for duplicate project IDs (basenames)
  const projectIds = new Set<string>();
  const projectIdToPaths: Record<string, string[]> = {};

  for (const [_configKey, project] of Object.entries(config.projects)) {
    const projectId = basename(project.path);

    if (!projectIdToPaths[projectId]) {
      projectIdToPaths[projectId] = [];
    }
    projectIdToPaths[projectId].push(project.path);

    if (projectIds.has(projectId)) {
      const paths = projectIdToPaths[projectId].join(", ");
      throw new Error(
        `Duplicate project ID detected: "${projectId}"\n` +
          `Multiple projects have the same directory basename:\n` +
          `  ${paths}\n\n` +
          `To fix this, ensure each project path has a unique directory name.\n` +
          `Alternatively, you can use the config key as a unique identifier.`,
      );
    }
    projectIds.add(projectId);
  }

  // Check for duplicate session prefixes
  const prefixes = new Set<string>();
  const prefixToProject: Record<string, string> = {};

  for (const [configKey, project] of Object.entries(config.projects)) {
    const projectId = basename(project.path);
    const prefix = project.sessionPrefix || generateSessionPrefix(projectId);

    if (prefixes.has(prefix)) {
      const firstProjectKey = prefixToProject[prefix];
      const firstProject = config.projects[firstProjectKey];
      throw new Error(
        `Duplicate session prefix detected: "${prefix}"\n` +
          `Projects "${firstProjectKey}" and "${configKey}" would generate the same prefix.\n\n` +
          `To fix this, add an explicit sessionPrefix to one of these projects:\n\n` +
          `projects:\n` +
          `  ${firstProjectKey}:\n` +
          `    path: ${firstProject?.path}\n` +
          `    sessionPrefix: ${prefix}1  # Add explicit prefix\n` +
          `  ${configKey}:\n` +
          `    path: ${project.path}\n` +
          `    sessionPrefix: ${prefix}2  # Add explicit prefix\n`,
      );
    }

    prefixes.add(prefix);
    prefixToProject[prefix] = configKey;
  }
}

/** Apply default reactions */
function applyDefaultReactions(config: OrchestratorConfig): OrchestratorConfig {
  const defaults: Record<string, (typeof config.reactions)[string]> = {
    "ci-failed": {
      auto: true,
      action: "send-to-agent",
      message:
        "CI is failing on your PR. Run `gh pr checks` to see the failures, fix them, and push.",
      retries: 2,
      escalateAfter: 2,
    },
    "changes-requested": {
      auto: true,
      action: "send-to-agent",
      message:
        "There are review comments on your PR. Check with `gh pr view --comments` and `gh api` for inline comments. Address each one, push fixes, and reply.",
      escalateAfter: "30m",
    },
    "bugbot-comments": {
      auto: true,
      action: "send-to-agent",
      message: "Automated review comments found on your PR. Fix the issues flagged by the bot.",
      escalateAfter: "30m",
    },
    "merge-conflicts": {
      auto: true,
      action: "send-to-agent",
      message: "Your branch has merge conflicts. Rebase on the default branch and resolve them.",
      escalateAfter: "15m",
    },
    "approved-and-green": {
      auto: false,
      action: "notify",
      priority: "action",
      message: "PR is ready to merge",
    },
    "agent-idle": {
      auto: true,
      action: "send-to-agent",
      message:
        "You appear to be idle. If your task is not complete, continue working — write the code, commit, push, and create a PR. If you are blocked, explain what is blocking you.",
      retries: 2,
      escalateAfter: "15m",
    },
    "agent-stuck": {
      auto: true,
      action: "notify",
      priority: "urgent",
      threshold: "10m",
    },
    "agent-needs-input": {
      auto: true,
      action: "notify",
      priority: "urgent",
    },
    "agent-exited": {
      auto: true,
      action: "notify",
      priority: "urgent",
    },
    "all-complete": {
      auto: true,
      action: "notify",
      priority: "info",
      includeSummary: true,
    },
    // bd-qqm: skeptic-advice — fired when skeptic agent posts a FAIL verdict on a PR.
    // Lifecycle manager detects new skeptic comments and fires this reaction, which
    // sends the structured skeptic advice to the worker agent via send-to-agent.
    "skeptic-advice": {
      auto: true,
      action: "send-to-agent",
      message: "Skeptic has posted advice on your PR:\n\n{{context}}",
      retries: 2,
      escalateAfter: 2,
    },
  };

  // Merge defaults with user-specified reactions (user wins)
  config.reactions = { ...defaults, ...config.reactions };

  return config;
}

/**
 * Search for config file in standard locations.
 *
 * Search order:
 * 1. AO_CONFIG_PATH environment variable (if set)
 * 2. Managed staging/production config locations
 * 3. Search up directory tree from CWD (like git)
 * 4. Explicit startDir (if provided)
 * 5. Legacy home-directory aliases
 */
export function findConfigFile(startDir?: string): string | null {
  // 1. Check environment variable override
  if (process.env["AO_CONFIG_PATH"]) {
    const envPath = resolve(process.env["AO_CONFIG_PATH"]);
    if (existsSync(envPath)) {
      return envPath;
    }
  }

  // 2. Prefer managed staging/prod config locations before searching for
  // repo-local shadow configs. This keeps AO anchored to the user-level
  // topology unless the caller explicitly opts into another path.
  const managedConfig = findManagedConfigFile();
  if (managedConfig) {
    return managedConfig;
  }

  // 3. Search up directory tree from CWD (like git)
  const searchUpTree = (dir: string): string | null => {
    const configFiles = ["agent-orchestrator.yaml", "agent-orchestrator.yml"];

    for (const filename of configFiles) {
      const configPath = resolve(dir, filename);
      if (existsSync(configPath)) {
        return configPath;
      }
    }

    const parent = resolve(dir, "..");
    if (parent === dir) {
      // Reached root
      return null;
    }

    return searchUpTree(parent);
  };

  const cwd = process.cwd();
  const foundInTree = searchUpTree(cwd);
  if (foundInTree) {
    return foundInTree;
  }

  // 4. Check explicit startDir if provided
  if (startDir) {
    const files = ["agent-orchestrator.yaml", "agent-orchestrator.yml"];
    for (const filename of files) {
      const path = resolve(startDir, filename);
      if (existsSync(path)) {
        return path;
      }
    }
  }

  // 5. Check home directory locations (legacy aliases)
  for (const path of getLegacyConfigPaths()) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/** Find config file path (exported for use in hash generation) */
export function findConfig(startDir?: string): string | null {
  return findConfigFile(startDir);
}

/** Load and validate config from a YAML file */
export function loadConfig(configPath?: string): OrchestratorConfig {
  // Priority: 1. Explicit param, 2. Search (including AO_CONFIG_PATH env var)
  // findConfigFile handles AO_CONFIG_PATH validation, so delegate to it
  const path = configPath ?? findConfigFile();

  if (!path) {
    throw new ConfigNotFoundError();
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);
  const config = validateConfig(parsed);

  // Set the config path in the config object for hash generation
  config.configPath = path;

  // bd-g884: bootstrap API-key env vars from configured shell init files (once per process)
  // Prefer defaults.envSource if set (per-project override), fall back to global.
  const effective = config.defaults?.envSource ?? config.envSource;
  assertTrustedEnvSource(effective ?? ["~/.bashrc"]);
  applyEnvSource(effective);
  _envBootstrapDone = true;

  return config;
}

/** Load config and return both config and resolved path */
export function loadConfigWithPath(configPath?: string): {
  config: OrchestratorConfig;
  path: string;
} {
  const path = configPath ?? findConfigFile();

  if (!path) {
    throw new ConfigNotFoundError();
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);
  const config = validateConfig(parsed);

  // Set the config path in the config object for hash generation
  config.configPath = path;

  // bd-g884: bootstrap API-key env vars from configured shell init files (once per process)
  // Prefer defaults.envSource if set (per-project override), fall back to global.
  const effective = config.defaults?.envSource ?? config.envSource;
  assertTrustedEnvSource(effective ?? ["~/.bashrc"]);
  applyEnvSource(effective);
  _envBootstrapDone = true;

  return { config, path };
}

/** Validate a raw config object */
export function validateConfig(raw: unknown): OrchestratorConfig {
  // Guard: JSON.parse(JSON.stringify()) throws on undefined, returns "null"→null on null.
  // Both cases must go to the non-cloned branch.
  if (typeof raw !== "object" || raw === null) {
    raw = {};
  }
  const rawObj = raw as Record<string, unknown>;
  // Track per-key whether user explicitly declared this reaction (vs relying on
  // default empty reactions block). ReactionConfigSchema.partial() strips defaults,
  // so we must detect explicit declaration from raw input.
  const hasExplicitGlobalReaction: Record<string, boolean> = {};
  if (typeof rawObj?.reactions === "object" && rawObj.reactions !== null) {
    for (const key of Object.keys(rawObj.reactions)) {
      hasExplicitGlobalReaction[key] = true;
    }
  }

  // bd-jhv1: Kill switch — EVOLVE_LOOP_ENABLED=false disables evolveLoop globally.
  // Uses explicit string comparison, NOT z.coerce.boolean() which misreads "false".
  const evolveLoopKillSwitch = process.env["EVOLVE_LOOP_ENABLED"] === "false";

  // Pre-process: clone raw so we can mutate per-project evolveLoop.enabled.
  let working: Record<string, unknown>;
  if (evolveLoopKillSwitch) {
    working = JSON.parse(JSON.stringify(raw as object));
    const projects = working["projects"] as Record<string, Record<string, unknown>> | undefined;
    if (projects) {
      for (const project of Object.values(projects)) {
        if (project["evolveLoop"] !== undefined && project["evolveLoop"] !== null) {
          (project["evolveLoop"] as Record<string, unknown>)["enabled"] = false;
        }
      }
    }
  } else {
    working = raw as Record<string, unknown>;
  }

  const validated = OrchestratorConfigSchema.parse({
    ...working,
    _hasExplicitGlobalReaction: hasExplicitGlobalReaction,
  });

  let config = validated as OrchestratorConfig;
  config = expandPaths(config);
  config = applyEvolveLoopPaths(config);
  config = applyProjectDefaults(config);
  config = applyDefaultReactions(config);

  // Validate project uniqueness and prefix collisions
  validateProjectUniqueness(config);

  return config;
}

/** Expand ~ in evolveLoop.knowledgeBaseDir using os.homedir() */
function applyEvolveLoopPaths(config: OrchestratorConfig): OrchestratorConfig {
  for (const project of Object.values(config.projects)) {
    if (project.evolveLoop?.knowledgeBaseDir) {
      project.evolveLoop.knowledgeBaseDir = expandHome(project.evolveLoop.knowledgeBaseDir);
    }
  }
  return config;
}

/** Get the default config (useful for `ao init`) */
export function getDefaultConfig(): OrchestratorConfig {
  return validateConfig({
    projects: {},
  });
}
