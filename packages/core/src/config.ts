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
import { createHash } from "node:crypto";
import { resolve, join, dirname, basename, sep } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ConfigNotFoundError, type OrchestratorConfig } from "./types.js";
import { applyEnvSource } from "./env-source.js";
import {
  findManagedConfigFile,
  findRepoLocalConfigFile,
  getLegacyConfigPaths,
} from "./config-topology.js";
import { deepMerge } from "./deep-merge.js";
import { generateSessionPrefix, expandHome } from "./paths.js";

let _envBootstrapDone = false;

function bootstrapEnvSource(config: OrchestratorConfig): void {
  if (_envBootstrapDone) return;
  const effective = config.defaults?.envSource ?? config.envSource;
  assertTrustedEnvSource(effective ?? ["~/.bashrc"]);
  applyEnvSource(effective);
  _envBootstrapDone = true;
}

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

function classifyConfigShape(configPath: string): "wrapped" | "flat-or-nonobject" | "missing" {
  if (!existsSync(configPath)) {
    return "missing";
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw);
  return parsed && typeof parsed === "object" && "projects" in (parsed as Record<string, unknown>)
    ? "wrapped"
    : "flat-or-nonobject";
}

function generateLegacyWrappedStorageKey(configPath: string, projectPath: string): string {
  const resolvedConfigPath = realpathSync(configPath);
  const configDir = dirname(resolvedConfigPath);
  const hash = createHash("sha256").update(configDir).digest("hex").slice(0, 12);
  return `${hash}-${basename(projectPath)}`;
}

function applyWrappedLocalStorageKeys(configPath: string, parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;

  const parsedObject = parsed as Record<string, unknown>;
  if (
    !("projects" in parsedObject) ||
    !parsedObject["projects"] ||
    typeof parsedObject["projects"] !== "object"
  ) {
    return parsed;
  }

  return {
    ...parsedObject,
    projects: Object.fromEntries(
      Object.entries(parsedObject["projects"] as Record<string, unknown>).map(
        ([projectId, value]) => {
          if (!value || typeof value !== "object") {
            return [projectId, value];
          }

          const project = value as Record<string, unknown>;
          if (typeof project["storageKey"] === "string" || typeof project["path"] !== "string") {
            return [projectId, value];
          }

          return [
            projectId,
            {
              ...project,
              storageKey: generateLegacyWrappedStorageKey(configPath, project["path"]),
            },
          ];
        },
      ),
    ),
  };
}

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

function validatePluginConfigFields(
  value: { plugin?: string; package?: string; path?: string },
  ctx: z.RefinementCtx,
  configType: string,
): void {
  if (!value.plugin && !value.package && !value.path) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${configType} config requires either 'plugin' (for built-ins) or 'package'/'path' (for external plugins)`,
    });
  }
  if (value.package && value.path) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${configType} config cannot have both 'package' and 'path' - use one or the other`,
    });
  }
}

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
  failureBudget: z
    .object({
      max: z.number().int().positive(),
      window: z.string().optional(),
    })
    .optional(),
  onBudgetExhausted: z.enum(["escalate", "disable", "route-to", "notify"]).optional(),
  routeToAgent: z.string().optional(),
  parallelRetry: z
    .object({
      maxParallel: z.number().int().positive(),
      strategies: z.array(z.string()),
      killOnSuccess: z.boolean().optional(),
    })
    .optional(),
  skepticModel: z.enum(["codex", "claude", "gemini"]).optional(),
  skepticPostComment: z.boolean().optional(),
  skepticExcludePaths: z.array(z.string()).optional(),
});

const TrackerConfigSchema = z
  .object({
    plugin: z.string().optional(),
    package: z.string().optional(),
    path: z.string().optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => validatePluginConfigFields(value, ctx, "Tracker"));

const SCMConfigSchema = z
  .object({
    plugin: z.string().optional(),
    package: z.string().optional(),
    path: z.string().optional(),
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
  .passthrough()
  .superRefine((value, ctx) => validatePluginConfigFields(value, ctx, "SCM"));

const NotifierConfigSchema = z
  .object({
    plugin: z.string().optional(),
    package: z.string().optional(),
    path: z.string().optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => validatePluginConfigFields(value, ctx, "Notifier"));

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

const EvolveLoopConfigSchema = z.object({
  enabled: z.boolean().optional(),
  pollCadence: z.enum(["lightweight", "standard"]).default("lightweight"),
  autonomousFixScopes: z.array(z.string()).default([]),
  blockedScopes: z.array(z.string()).default([]),
  knowledgeBaseDir: z.string().default("~/.ao-evolve-knowledge"),
  zeroTouchWindow: z.enum(["24h", "30d"]).default("24h"),
});

const TechniqueConfigSchema = z.object({
  default: z.enum(["SR-prtype", "SR-fewshot", "SR", "ET", "PRM", "default"]).default("SR-prtype"),
  perType: z.record(z.enum(["state-bool", "data-norm", "ci-workflow", "typeddict-schema", "large-arch-refactor", "unknown"]), z.enum(["SR-prtype", "SR-fewshot", "SR", "ET", "PRM", "default"])).optional(),
  thresholds: z.object({
    minScoreDiff: z.number().optional(),
    confidenceN: z.number().optional(),
  }).optional(),
});

const AutoMergeDefaultsSchema = z.object({
  enabled: z.boolean().default(true),
  waitSeconds: z.number().int().nonnegative().optional(),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
});

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
  resolveError: z.string().optional(),
  runtime: z.string().optional(),
  agent: z.string().optional(),
  defaultAgent: z.string().optional(),
  fallbackAgents: z.array(z.string()).optional(),
  workspace: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  tracker: TrackerConfigSchema.optional(),
  scm: SCMConfigSchema.optional(),
  symlinks: z.array(z.string()).optional(),
  postCreate: z.array(z.string()).optional(),
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
  autoMerge: AutoMergeOverrideSchema.optional(),
  backfillAllPRs: z.boolean().optional(),
  mergeGate: MergeGateConfigSchema.optional(),
  worktreeDir: z.string().optional(),
  scmFailureThreshold: z.number().int().min(1).max(100).optional(),
  spawnQueue: SpawnQueueConfigSchema.optional(),
  taskQueue: TaskQueueConfigSchema,
  evolveLoop: EvolveLoopConfigSchema.optional(),
  technique: TechniqueConfigSchema.optional(),
});

const DefaultPluginsSchema = z.object({
  runtime: z.string().default("tmux"),
  agent: z.string().default("codex"),
  workspace: z.string().default("worktree"),
  notifiers: z.array(z.string()).default(["composio"]),
  agentConfig: AgentSpecificConfigSchema.optional(),
  modelByCli: z.record(CliModelDefaultsSchema).optional(),
  fallbackAgents: z.array(z.string()).optional(),
  orchestrator: RoleAgentDefaultsSchema,
  worker: RoleAgentDefaultsSchema,
  autoMerge: AutoMergeDefaultsSchema.optional(),
  scmFailureThreshold: z.number().int().min(1).max(100).optional(),
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

const InstalledPluginConfigSchema = z
  .object({
    name: z.string(),
    source: z.enum(["registry", "npm", "local"]),
    package: z.string().optional(),
    version: z.string().optional(),
    path: z.string().optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.source === "local" && !value.path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["path"],
        message: "Local plugins require a path",
      });
    }

    if ((value.source === "registry" || value.source === "npm") && !value.package) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["package"],
        message: "Registry and npm plugins require a package name",
      });
    }
  });

const PowerConfigSchema = z
  .object({
    preventIdleSleep: z.boolean().default(process.platform === "darwin"),
  })
  .default({});

const DashboardConfigSchema = z.object({
  attentionZones: z.enum(["simple", "detailed"]).default("simple"),
});

const LifecycleConfigSchema = z
  .object({
    autoCleanupOnMerge: z.boolean().default(true),
    mergeCleanupIdleGraceMs: z
      .number()
      .int()
      .nonnegative()
      .refine((v) => v === 0 || v >= 10_000, {
        message:
          "mergeCleanupIdleGraceMs is in milliseconds; values between 1 and 9999 are likely a units mistake (use 0 to disable the gate, or e.g. 10000 for 10s, 300000 for 5min)",
      })
      .default(300_000),
  })
  .default({});

const OrchestratorConfigSchema = z.object({
  $schema: z.string().optional(),
  port: z.number().default(3000),
  terminalPort: z.number().optional(),
  directTerminalPort: z.number().optional(),
  readyThresholdMs: z.number().nonnegative().default(300_000),
  startupGracePeriodMs: z.number().nonnegative().default(120_000),
  scmFailureThreshold: z.number().int().min(1).max(100).default(3),
  power: PowerConfigSchema,
  lifecycle: LifecycleConfigSchema,
  defaults: DefaultPluginsSchema.default({}),
  projects: z.record(
    z
      .string()
      .regex(
        /^[a-zA-Z0-9_-]+$/,
        "Project ID must match [a-zA-Z0-9_-]+ (no dots, slashes, or special characters)",
      ),
    ProjectConfigSchema,
  ),
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
  dashboard: DashboardConfigSchema.optional(),
  autoMerge: AutoMergeOverrideSchema.optional(),
  worktreeDir: z.string().optional(),
  envSource: z
    .array(z.string())
    .default(["~/.bashrc"])
    .refine(
      (entries) =>
        entries.every((e) => {
          if (e === "/etc/environment") return true;
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

interface ExternalPluginEntryRef {
  source: string;
  location:
    | { kind: "project"; projectId: string; configType: string }
    | { kind: "notifier"; notifierId: string };
  slot: "tracker" | "scm" | "notifier";
  package?: string;
  path?: string;
  expectedPluginName?: string;
}

function assertTrustedEnvSource(entries: string[]): void {
  const homePrefix = `${homedir()}${sep}`;
  for (const entry of entries) {
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

function expandPaths(config: OrchestratorConfig): OrchestratorConfig {
  for (const project of Object.values(config.projects)) {
    project.path = expandHome(project.path);
  }

  return config;
}

function generateTempPluginName(pkg?: string, path?: string): string {
  if (pkg) {
    const slashParts = pkg.split("/");
    const packageName = slashParts[slashParts.length - 1] ?? pkg;

    const prefixMatch = packageName.match(
      /^ao-plugin-(?:runtime|agent|workspace|tracker|scm|notifier|terminal)-(.+)$/,
    );
    if (prefixMatch?.[1]) {
      return prefixMatch[1];
    }

    return packageName;
  }

  if (path) {
    const segments = path.split("/").filter((s) => s && s !== "." && s !== "..");
    return segments[segments.length - 1] ?? path;
  }

  return "unknown";
}

function processExternalPluginConfig(
  pluginConfig: { plugin?: string; package?: string; path?: string },
  source: string,
  location: ExternalPluginEntryRef["location"],
  slot: ExternalPluginEntryRef["slot"],
): ExternalPluginEntryRef | null {
  if (!pluginConfig.package && !pluginConfig.path) return null;

  if (pluginConfig.path) {
    pluginConfig.path = expandHome(pluginConfig.path);
  }

  const userSpecifiedPlugin = pluginConfig.plugin;

  if (!pluginConfig.plugin) {
    pluginConfig.plugin = generateTempPluginName(pluginConfig.package, pluginConfig.path);
  }

  return {
    source,
    location,
    slot,
    package: pluginConfig.package,
    path: pluginConfig.path,
    expectedPluginName: userSpecifiedPlugin,
  };
}

export function collectExternalPluginConfigs(config: OrchestratorConfig): ExternalPluginEntryRef[] {
  const entries: ExternalPluginEntryRef[] = [];

  for (const [projectId, project] of Object.entries(config.projects)) {
    if (project.tracker) {
      const entry = processExternalPluginConfig(
        project.tracker,
        `projects.${projectId}.tracker`,
        { kind: "project", projectId, configType: "tracker" },
        "tracker",
      );
      if (entry) entries.push(entry);
    }

    if (project.scm) {
      const entry = processExternalPluginConfig(
        project.scm,
        `projects.${projectId}.scm`,
        { kind: "project", projectId, configType: "scm" },
        "scm",
      );
      if (entry) entries.push(entry);
    }
  }

  for (const [notifierId, notifierConfig] of Object.entries(config.notifiers ?? {})) {
    if (notifierConfig) {
      const entry = processExternalPluginConfig(
        notifierConfig,
        `notifiers.${notifierId}`,
        { kind: "notifier", notifierId },
        "notifier",
      );
      if (entry) entries.push(entry);
    }
  }

  return entries;
}

type InstalledPluginConfig = z.infer<typeof InstalledPluginConfigSchema>;

function mergeExternalPlugins(
  existingPlugins: InstalledPluginConfig[],
  externalEntries: ExternalPluginEntryRef[],
): InstalledPluginConfig[] {
  const plugins = [...existingPlugins];
  const seen = new Set<string>();

  for (const plugin of plugins) {
    if (plugin.package) seen.add(`package:${plugin.package}`);
    if (plugin.path) seen.add(`path:${plugin.path}`);
  }

  for (const entry of externalEntries) {
    const key = entry.package ? `package:${entry.package}` : `path:${entry.path}`;
    if (seen.has(key)) {
      const existingPlugin = plugins.find(
        (p) =>
          (entry.package && p.package === entry.package) || (entry.path && p.path === entry.path),
      );
      if (existingPlugin && existingPlugin.enabled === false) {
        existingPlugin.enabled = true;
      }
      continue;
    }
    seen.add(key);

    const tempName = entry.expectedPluginName ?? generateTempPluginName(entry.package, entry.path);

    plugins.push({
      name: tempName,
      source: entry.package ? "npm" : "local",
      package: entry.package,
      path: entry.path,
      enabled: true,
    });
  }

  return plugins;
}

/** Apply defaults to project configs */
function applyProjectDefaults(config: OrchestratorConfig): OrchestratorConfig {
  for (const [id, project] of Object.entries(config.projects)) {
    if (!project.name) {
      project.name = id;
    }

    if (!project.sessionPrefix) {
      const projectId = basename(project.path);
      project.sessionPrefix = generateSessionPrefix(projectId);
    }

    const inferredPlugin = inferScmPlugin({ repo: project.repo!, scm: project.scm as Record<string, unknown> | undefined, tracker: project.tracker as Record<string, unknown> | undefined });

    if (!project.scm && project.repo?.includes("/")) {
      project.scm = { plugin: inferredPlugin };
    }

    if (!project.tracker) {
      project.tracker = { plugin: inferredPlugin };
    }
  }

  return config;
}

/** Validate project uniqueness and session prefix collisions */
function validateProjectUniqueness(config: OrchestratorConfig): void {
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

export const DEFAULT_BUGBOT_COMMENTS_MESSAGE =
  "Automated review comments found on your PR. Fix the issues flagged by the bot.";

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
    "skeptic-advice": {
      auto: true,
      action: "send-to-agent",
      message: "Skeptic has posted advice on your PR:\n\n{{context}}",
      retries: 2,
      escalateAfter: 2,
    },
  };

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
  if (process.env["AO_CONFIG_PATH"]) {
    const envPath = resolve(process.env["AO_CONFIG_PATH"]);
    if (existsSync(envPath)) {
      return envPath;
    }
  }

  const managedConfig = findManagedConfigFile();
  if (managedConfig) {
    return managedConfig;
  }

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
      return null;
    }

    return searchUpTree(parent);
  };

  const cwd = process.cwd();
  const foundInTree = searchUpTree(cwd);
  if (foundInTree) {
    return foundInTree;
  }

  if (startDir) {
    const files = ["agent-orchestrator.yaml", "agent-orchestrator.yml"];
    for (const filename of files) {
      const path = resolve(startDir, filename);
      if (existsSync(path)) {
        return path;
      }
    }
  }

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

function mergeConfigOverlay(
  base: unknown,
  overlayPath: string,
): unknown {
  const overlayRaw = readFileSync(overlayPath, "utf-8");
  const overlay = parseYaml(overlayRaw);

  if (typeof base !== "object" || base === null) {
    return overlay;
  }
  if (typeof overlay !== "object" || overlay === null) {
    return base;
  }

  const baseObj = base as Record<string, unknown>;
  const overlayObj = overlay as Record<string, unknown>;

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

  for (const key of Object.keys(overlayObj)) {
    if (key === "projects") {
      continue;
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
  const path = configPath ?? findConfigFile();

  if (!path) {
    throw new ConfigNotFoundError();
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);

  const overlayPath = configPath ? null : findRepoLocalConfigOverlay(path);
  const merged = overlayPath ? mergeConfigOverlay(parsed, overlayPath) : parsed;

  const config = validateConfig(merged);

  config.configPath = path;

  bootstrapEnvSource(config);

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

  const overlayPath = configPath ? null : findRepoLocalConfigOverlay(path);
  const merged = overlayPath ? mergeConfigOverlay(parsed, overlayPath) : parsed;

  const config = validateConfig(merged);

  config.configPath = path;

  bootstrapEnvSource(config);

  return { config, path };
}

/** Validate a raw config object */
export function validateConfig(raw: unknown): OrchestratorConfig {
  if (typeof raw !== "object" || raw === null) {
    raw = {};
  }
  const rawObj = raw as Record<string, unknown>;
  const hasExplicitGlobalReaction: Record<string, boolean> = {};
  if (typeof rawObj?.reactions === "object" && rawObj.reactions !== null) {
    for (const key of Object.keys(rawObj.reactions)) {
      hasExplicitGlobalReaction[key] = true;
    }
  }

  const evolveLoopKillSwitch = process.env["EVOLVE_LOOP_ENABLED"] === "false";

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

  validateProjectUniqueness(config);

  return config;
}

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
