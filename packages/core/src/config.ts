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

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { resolve, basename, sep } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ConfigNotFoundError, type OrchestratorConfig } from "./types.js";
import { skepticModelSchema } from "./skeptic-model-schema.js";
import { applyEnvSource } from "./env-source.js";
import {
  findManagedConfigFile,
  findRepoLocalConfigFile,
  getLegacyConfigPaths,
} from "./config-topology.js";
import { deepMerge } from "./deep-merge.js";
import { expandEnvVars } from "./config-env-expand.js";
import { validateReactionDefinitions } from "./config-reaction-validation.js";
import { generateSessionPrefix, expandHome } from "./paths.js";

/** Ensures envSource is bootstrapped exactly once per process lifetime. */
let _envBootstrapDone = false;

/**
 * Test-only: reset the envSource bootstrap flag so the next loadConfig call
 * re-bootstraps from process.env + configured envSource files. Production
 * callers MUST NOT use this — the once-per-process invariant is intentional.
 */
export function _resetEnvBootstrapForTesting(): void {
  _envBootstrapDone = false;
}

function inferScmPlugin(project: {
  repo?: string;
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
    .enum(["send-to-agent", "notify", "auto-merge", "request-merge", "parallel-retry", "skeptic-review", "respawn-for-review", "claim-verification", "agent-fallback"])
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
  skepticModel: skepticModelSchema.optional(),
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
    startupTimeoutMs: z.number().int().positive().optional(),
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
    startupTimeoutMs: z.number().int().positive().optional(),
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

const LockConfigSchema = z.object({
  plugin: z.string().optional(),
  config: z.record(z.any()).optional(),
});

const ProjectConfigSchema = z.object({
  name: z.string().optional(),
  repo: z.string().optional(),
  path: z.string(),
  defaultBranch: z.string().default("main"),
  sessionPrefix: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "sessionPrefix must match [a-zA-Z0-9_-]+")
    .optional(),
  runtime: z.string().optional(),
  agent: z.string().optional(),
  defaultAgent: z.string().optional(),
  fallbackAgents: z.array(z.string()).optional(),
  workspace: z.string().optional(),
  tracker: TrackerConfigSchema.optional(),
  scm: SCMConfigSchema.optional(),
  lock: LockConfigSchema.optional(),
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
  backfillAllPRs: z.boolean().default(false),
  // bd-uxs.8: Merge gate configuration
  mergeGate: MergeGateConfigSchema.optional(),
  // Override the global worktree base directory for this project.
  worktreeDir: z.string().optional(),
  // Override the global clone base directory for this project.
  cloneDir: z.string().optional(),
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

  // Skeptic cron per-PR throttle layers (see SkepticCronConfig in types.ts)
  skepticCron: z
    .object({
      enablePerPrThrottle: z.boolean().default(false),
      perPrCooldownMs: z.number().int().min(0).optional(),
      shaStabilityWindowMs: z.number().int().min(0).optional(),
      enableVerdictCooldown: z.boolean().default(true),
    })
    .optional(),
});

const DefaultPluginsSchema = z.object({
  runtime: z.string().default("tmux"),
  agent: z.string().default("antigravity"),
  workspace: z.string().default("worktree"),
  lock: z.string().default("area-lock"),
  notifiers: z.array(z.string()).default(["composio"]),
  agentConfig: AgentSpecificConfigSchema.optional(),
  modelByCli: z.record(CliModelDefaultsSchema).optional(),
  fallbackAgents: z.array(z.string()).optional(),
  orchestrator: RoleAgentDefaultsSchema,
  worker: RoleAgentDefaultsSchema,
  // bd-n047: default auto-merge settings for all projects
  autoMerge: AutoMergeDefaultsSchema.optional(),
  // Phase B: scmFailureThreshold — kills dead-agent sessions after N consecutive SCM failures
  scmFailureThreshold: z.number().int().min(1).max(100).optional(),
  // bd-g884: shell init files to source for API keys; falls back to global envSource
  // Security: restricted to shell dotfiles (same allowlist as top-level envSource).
  envSource: z
    .array(z.string())
    .optional()
    .refine(
      (entries) =>
        !entries ||
        entries.every((e) => {
          if (e === "/etc/environment") return true;
          return (
            e.startsWith("~/") &&
            /^~\/\.[a-zA-Z][a-zA-Z0-9_-]*$/.test(e)
          );
        }),
      {
        message:
          "Untrusted envSource: only shell dotfiles (~/.bashrc, ~/.zshrc, ...) or /etc/environment are allowed.",
      },
    ),
});

const OrchestratorConfigSchema = z.object({
  port: z.number().default(3000),
  /**
   * bd-#667: Suppress browser auto-open on `ao start` / `ao dashboard`.
   * Default `true` (browser opens) to preserve current behavior. Set
   * `true` in YAML, or pass `--open-browser` to the CLI.
   */
  openBrowser: z.boolean().default(false),
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
  // Global clone base directory; can be overridden per-project.
  cloneDir: z.string().optional(),
  // bd-g884: Source shell init files to pull API keys into process.env.
  // Security: envSource is restricted to known shell init files or /etc/environment.
  // This prevents a malicious repo-local config from sourcing arbitrary scripts
  // even if those scripts happen to live under ~/ (e.g. ~/worktrees/repo/evil.sh).
  envSource: z
    .array(z.string())
    .default(["~/.bashrc"])
    .refine(
      (entries) =>
        entries.every((e) => {
          if (e === "/etc/environment") return true;
          // Only allow shell dotfiles: ~/.bashrc, ~/.zshrc, ~/.profile, etc.
          // Reject paths like ~/scripts/env.sh, ~/worktrees/repo/evil.sh.
          return (
            e.startsWith("~/") &&
            /^~\/\.[a-zA-Z][a-zA-Z0-9_-]*$/.test(e)
          );
        }),
      {
        message:
          "Untrusted envSource: only shell dotfiles (~/.bashrc, ~/.zshrc, ~/.profile, ...) or /etc/environment are allowed.",
      },
    ),
});

// =============================================================================
// CONFIG LOADING
// =============================================================================

/**
 * Guardrail: reject envSource paths that escape the user's home directory.
 *
 * Config files can live in repo-local .claude/ dirs, so a malicious repo
 * could set `envSource: ["/tmp/evil.sh"]` to exec arbitrary scripts in the
 * AO daemon's PID. We restrict envSource to the user's shell dotfiles
 * (paths starting with ~/) or /etc/environment. Explicit absolute paths
 * (not starting with ~/) are rejected because they could point to files
 * outside the user's trusted home directory tree.
 */
function assertTrustedEnvSource(entries: string[]): void {
  const homePrefix = `${homedir()}${sep}`;
  for (const entry of entries) {
    // Only allow ~/...-relative paths or /etc/environment.
    // Reject explicit absolute paths (e.g. /Users/jleechan/scripts/env.sh)
    // to prevent a repo-local config from referencing files outside ~/.
    if (!entry.startsWith("~") && entry !== "/etc/environment") {
      throw new Error(
        `Untrusted envSource "${entry}": only "~" paths or /etc/environment are allowed.`,
      );
    }
    const expanded = expandHome(entry);
    if (
      entry !== "/etc/environment" &&
      !expanded.startsWith(homePrefix)
    ) {
      throw new Error(
        `Untrusted envSource "${expanded}": resolves outside home directory.`,
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
    if (!project.scm && project.repo?.includes("/")) {
      project.scm = { plugin: inferredPlugin };
    }

    // Infer tracker from repo if not set (default to github issues)
    if (!project.tracker) {
      project.tracker = { plugin: inferredPlugin };
    }
  }

  return config;
}

/**
 * Warn when a project's configKey does not match basename(project.path)
 * and no explicit `name:` field is set. This catches the "mislabeled block"
 * pattern that copy-paste between configs produces — e.g., a block keyed
 * `cmux:` whose `path`, `repo`, and `agentRules` all reference a different
 * project (e.g. `claude-commands`). The collision surfaces only when another
 * config also has a `claude-commands` block; this check warns proactively
 * even in a single-config file.
 *
 * bd-686.1: 2026-06-14 — the AO config duplicate-basename bug recurred within
 * hours of first discovery because the workaround (direct plugin invocation)
 * was captured as a memory entry without applying the 1-line config fix.
 */
function validateProjectKeyConsistency(config: OrchestratorConfig): void {
  for (const [configKey, project] of Object.entries(config.projects)) {
    const projectBasename = basename(project.path);
    if (configKey === projectBasename) {
      continue; // Convention satisfied — no warning needed.
    }
    // Opt-out rule: an explicit `name` field silences the warning ONLY when
    // the name matches the configKey. A name that matches `basename(path)`
    // but not `configKey` is a copy-paste indicator (motivating case: a block
    // keyed `cmux` copied from a `claude-commands` template, where `name`
    // and `path` were edited in lockstep — leaving the warning to fire is
    // the correct behavior).
    if (project.name === configKey) {
      continue;
    }
    console.warn(
      `[config] Mislabeled project block: configKey "${configKey}" has ` +
        `path "${project.path}" whose basename is "${projectBasename}". ` +
        `If this is intentional, set an explicit "name: ${configKey}" field ` +
        `(must match the configKey) to silence this warning. Otherwise, ` +
        `rename the block to "${projectBasename}" or move the project to a ` +
        `path with basename "${configKey}". (bd-686.1)`,
    );
  }
}

/** Validate project uniqueness and session prefix collisions */
function validateProjectUniqueness(config: OrchestratorConfig): void {
  // Check for duplicate project IDs (basenames)
  const projectIds = new Set<string>();
  const projectIdToPaths: Record<string, string[]> = {};
  const projectIdToKeys: Record<string, string[]> = {};

  for (const [configKey, project] of Object.entries(config.projects)) {
    const projectId = basename(project.path);

    if (!projectIdToPaths[projectId]) {
      projectIdToPaths[projectId] = [];
      projectIdToKeys[projectId] = [];
    }
    projectIdToPaths[projectId].push(project.path);
    projectIdToKeys[projectId].push(configKey);

    if (projectIds.has(projectId)) {
      const conflictLines = projectIdToKeys[projectId]
        .map((key, i) => `  - configKey "${key}" → ${projectIdToPaths[projectId][i]}`)
        .join("\n");
      throw new Error(
        `Duplicate project ID detected: "${projectId}"\n` +
          `Multiple projects share the same directory basename but use different config keys:\n` +
          `${conflictLines}\n\n` +
          `This usually means a config block was mislabeled (copy-pasted under a different key).\n` +
          `To fix, either:\n` +
          `  1. Rename one of the config keys to match the other (e.g. align all keys on the basename), or\n` +
          `  2. Move the mislabeled project to its own path with a unique basename.\n\n` +
          `If you intended one project to have a custom name, set an explicit "name:" field on the\n` +
          `mislabeled block to silence the warning.`,
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

  // ac9ab7d: Check for prefix boundary collisions — one prefix must not be a
  // prefix of another prefix with the "-" separator. E.g., "ao" and "ao-staging"
  // would collide because session "ao-staging-1" could match both prefixes.
  const sortedPrefixes = [...prefixes].sort();
  for (let i = 0; i < sortedPrefixes.length; i++) {
    for (let j = i + 1; j < sortedPrefixes.length; j++) {
      const shorter = sortedPrefixes[i]!;
      const longer = sortedPrefixes[j]!;
      if (longer.startsWith(`${shorter}-`)) {
        const firstKey = prefixToProject[shorter]!;
        const secondKey = prefixToProject[longer]!;
        const firstProject = config.projects[firstKey];
        const secondProject = config.projects[secondKey];
        throw new Error(
          `Session prefix boundary collision: "${shorter}" is a prefix of "${longer}"\n` +
            `Sessions like "${longer}-1" would be ambiguous between ` +
            `project "${firstKey}" (prefix: ${shorter}) and project "${secondKey}" (prefix: ${longer}).\n\n` +
            `To fix this, rename one of the prefixes so neither is a prefix of the other:\n\n` +
            `projects:\n` +
            `  ${firstKey}:\n` +
            `    path: ${firstProject?.path}\n` +
            `    sessionPrefix: ${firstProject?.sessionPrefix ?? shorter}  # Already explicit\n` +
            `  ${secondKey}:\n` +
            `    path: ${secondProject?.path}\n` +
            `    sessionPrefix: ${longer.replace(`${shorter}-`, `${shorter}_`)}  # Rename to avoid collision\n`,
        );
      }
    }
  }
}

/** Apply default reactions */
function applyDefaultReactions(config: OrchestratorConfig): OrchestratorConfig {
  const defaults: Record<string, (typeof config.reactions)[string]> = {
    "ci-failed": {
      auto: true,
      action: "send-to-agent",
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
// CONFIG OVERLAY (repo-local merge on top of managed config)
// =============================================================================

/**
 * Determine whether the primary config is a managed config, and if so,
 * find a repo-local config to overlay. Returns null when:
 * - the primary config is already repo-local (walk-up found it, no overlay needed)
 * - no repo-local config exists in the CWD tree
 * - the repo-local config is the same file as the primary (identity guard)
 *
 * Uses realpathSync to normalize macOS /var ↔ /private/var symlink aliases.
 */
function findRepoLocalConfigOverlay(primaryPath: string): string | null {
  const managedPath = findManagedConfigFile();
  if (!managedPath) {
    return null;
  }

  let primaryReal: string;
  let managedReal: string;
  try {
    primaryReal = realpathSync(primaryPath);
    managedReal = realpathSync(managedPath);
  } catch {
    primaryReal = resolve(primaryPath);
    managedReal = resolve(managedPath);
  }

  if (primaryReal !== managedReal) {
    return null;
  }

  const repoLocal = findRepoLocalConfigFile();
  if (!repoLocal) {
    return null;
  }

  let repoLocalReal: string;
  try {
    repoLocalReal = realpathSync(repoLocal);
  } catch {
    repoLocalReal = resolve(repoLocal);
  }

  if (repoLocalReal === primaryReal) {
    return null;
  }

  return repoLocal;
}

/**
 * Deep-merge a repo-local overlay on top of a managed config (parsed YAML objects).
 * For `projects`, merges per-project by project key.
 * For all other keys, deep-merge with overlay winning on conflict.
 */
function mergeConfigOverlay(
  base: unknown,
  overlayPath: string,
): unknown {
  const overlayRaw = readFileSync(overlayPath, "utf-8");
  // Expand env vars in the overlay BEFORE merging — otherwise ${VAR} literals in
  // a repo-local overlay win on deep-merge and bypass the primary config's
  // expansion. bd-feedback-2026-06-19-notif-slack-placeholder
  const overlay = expandEnvVars(parseYaml(overlayRaw));

  if (typeof base !== "object" || base === null) {
    return overlay;
  }
  if (typeof overlay !== "object" || overlay === null) {
    return base;
  }

  const baseObj = base as Record<string, unknown>;
  const overlayObj = overlay as Record<string, unknown>;

  // Per-project deep merge: overlay project fields win over base project fields
  if (
    typeof baseObj["projects"] === "object" &&
    baseObj["projects"] !== null &&
    typeof overlayObj["projects"] === "object" &&
    overlayObj["projects"] !== null
  ) {
    const baseProjects = baseObj["projects"] as Record<string, unknown>;
    const overlayProjects = overlayObj["projects"] as Record<string, unknown>;
    const mergedProjects: Record<string, unknown> = { ...baseProjects };

    for (const [projectId, overlayProject] of Object.entries(overlayProjects)) {
      const baseProject = mergedProjects[projectId];
      if (
        typeof baseProject === "object" &&
        baseProject !== null &&
        typeof overlayProject === "object" &&
        overlayProject !== null
      ) {
        mergedProjects[projectId] = deepMerge(
          baseProject as Record<string, unknown>,
          overlayProject as Record<string, unknown>,
        );
      } else {
        mergedProjects[projectId] = overlayProject;
      }
    }

    baseObj["projects"] = mergedProjects;
  }

  // Deep-merge remaining top-level keys (defaults, reactions, notifiers, etc.)
  for (const key of Object.keys(overlayObj)) {
    if (key === "projects") {
      continue; // already handled above
    }
    const baseVal = baseObj[key];
    const overVal = overlayObj[key];

    if (
      typeof baseVal === "object" &&
      baseVal !== null &&
      typeof overVal === "object" &&
      overVal !== null &&
      !Array.isArray(baseVal) &&
      !Array.isArray(overVal)
    ) {
      baseObj[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overVal as Record<string, unknown>,
      );
    } else {
      baseObj[key] = overVal;
    }
  }

  return baseObj;
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

  // Config overlay: when the primary config is a managed config (staging/prod),
  // search for a repo-local config and deep-merge it on top. Repo-local wins
  // for overlapping keys — this makes per-repo project overrides work even when
  // a managed config shadows the walk-up search.
  const overlayPath = configPath ? null : findRepoLocalConfigOverlay(path);

  // bd-feedback-2026-06-19-notif-slack-placeholder (Skeptic gate-8a / -8c):
  // Bootstrap envSource from the MERGED view of envSource (primary deep-merged
  // with overlay if present) BEFORE we expand ${VAR} templates anywhere. An
  // overlay may override `defaults.envSource` (e.g. to switch from ~/.bashrc
  // to ~/.zshrc) and the overlay's own ${VAR} templates need vars sourced from
  // that overridden envSource, not from the primary config's envSource. Without
  // this, a daemon installed via launchd freezes ${SLACK_WEBHOOK_URL} to its
  // :- fallback at overlay-merge time and the sourced value never replaces it.
  bootstrapEnvSourceForLoad(parsed, overlayPath);

  const expanded = expandEnvVars(parsed);

  const merged = overlayPath ? mergeConfigOverlay(expanded, overlayPath) : expanded;

  const config = validateConfig(merged);

  // Set the config path in the config object for hash generation
  config.configPath = path;

  return config;
}

/**
 * Bootstrap envSource for the loadConfig / loadConfigWithPath path. When an
 * overlay exists, simulate the deep-merge's overlay-wins-on-conflict semantics
 * for the envSource field and bootstrap from the merged list. applyEnvSource
 * uses per-call snapshots so we don't duplicate or re-source already-applied
 * vars — we only add what the overlay's extra files contribute.
 *
 * Shape policy: this bootstrap runs BEFORE validateConfig(), but it must NOT
 * have side effects on a config that validation will later reject. The schema
 * requires envSource to be `z.array(z.string())`; if the raw value is anything
 * else (string, null, missing → undefined default, etc.), skip bootstrap and
 * let validation throw. A raw string envSource is no longer normalized to an
 * array here — that pre-validation side effect could source arbitrary shell
 * init files from a config that the schema will reject.
 */
function bootstrapEnvSourceForLoad(
  primaryParsed: unknown,
  overlayPath: string | null,
): void {
  if (_envBootstrapDone) return;
  const primaryEnvSourceList: unknown =
    typeof primaryParsed === "object" && primaryParsed !== null
      ? readRawEnvSourceList(primaryParsed as Record<string, unknown>)
      : undefined;
  let overlayEnvSourceList: unknown;
  if (overlayPath) {
    const overlayRaw = readFileSync(overlayPath, "utf-8");
    const overlayParsed = parseYaml(overlayRaw);
    if (typeof overlayParsed === "object" && overlayParsed !== null) {
      overlayEnvSourceList = readRawEnvSourceList(
        overlayParsed as Record<string, unknown>,
      );
    }
  }
  // Overlay wins on conflict (matches the deep-merge semantics used elsewhere).
  // If the chosen list is not a string array (e.g. a raw string from an
  // invalid config), skip bootstrap — validation will reject and we MUST NOT
  // have sourced any files before that throw.
  const rawChosen = overlayEnvSourceList ?? primaryEnvSourceList;
  if (rawChosen === undefined) {
    // No envSource declared anywhere → use schema default `["~/.bashrc"]`.
    // The default is also what validation will accept.
    assertTrustedEnvSource(["~/.bashrc"]);
    applyEnvSource(["~/.bashrc"]);
    _envBootstrapDone = true;
    return;
  }
  if (!Array.isArray(rawChosen)) {
    // Mis-shaped envSource (e.g. a string). Validation will reject; no
    // bootstrap side effect, no process.env pollution.
    return;
  }
  const stringList = rawChosen.filter((v): v is string => typeof v === "string");
  if (stringList.length === 0) {
    return;
  }
  assertTrustedEnvSource(stringList);
  applyEnvSource(stringList);
  _envBootstrapDone = true;
}

/**
 * Read the raw envSource field as a list, without normalizing a single string
 * into an array. Returns undefined if the field is missing; returns the raw
 * value (which may be a string, an array, or something else invalid) if
 * present — callers decide whether to trust it.
 */
function readRawEnvSourceList(
  obj: Record<string, unknown>,
): unknown {
  const defaultsObj = obj["defaults"];
  const defaultsEnvSource =
    typeof defaultsObj === "object" && defaultsObj !== null
      ? (defaultsObj as Record<string, unknown>)["envSource"]
      : undefined;
  const globalEnvSource = obj["envSource"];
  // Prefer defaults.envSource (per-project override), fall back to top-level.
  return defaultsEnvSource ?? globalEnvSource;
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

  // Config overlay: same as loadConfig — see comment there.
  const overlayPath = configPath ? null : findRepoLocalConfigOverlay(path);

  // Same merged-view bootstrap as loadConfig — see comment there.
  bootstrapEnvSourceForLoad(parsed, overlayPath);

  const expanded = expandEnvVars(parsed);

  const merged = overlayPath ? mergeConfigOverlay(expanded, overlayPath) : expanded;

  const config = validateConfig(merged);

  // Set the config path in the config object for hash generation
  config.configPath = path;

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

  // Warn about mislabeled config blocks (configKey vs basename mismatch).
  // Runs BEFORE applyProjectDefaults so we can distinguish "name: explicitly
  // set" from "name: auto-derived from configKey" — only the latter triggers
  // the warning. Runs after expandPaths so the basename is computed on the
  // resolved path.
  validateProjectKeyConsistency(config);

  config = applyProjectDefaults(config);
  config = applyDefaultReactions(config);

  // Validate project uniqueness and prefix collisions
  validateProjectUniqueness(config);

  // Warn on reaction definitions missing required fields
  const reactionIssues = validateReactionDefinitions(config);
  for (const issue of reactionIssues) {
    console.warn(`[config] ${issue.message}`);
  }

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
