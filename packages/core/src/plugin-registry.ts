import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ExternalPluginEntryRef,
  InstalledPluginConfig,
  PluginSlot,
  PluginManifest,
  PluginModule,
  PluginRegistry,
  OrchestratorConfig,
} from "./types.js";
export { isPackageResolutionFailure, tryMonorepoFallback } from "./plugin-registry-fallback.js";
import { isPackageResolutionFailure, tryMonorepoFallback } from "./plugin-registry-fallback.js";
import { applyForkExtensions } from "./plugin-registry-extensions.js";

type PluginMap = Map<string, { manifest: PluginManifest; instance: unknown }>;

interface NotifierRegistration {
  registrationName: string;
  config?: Record<string, unknown>;
}

const LOCAL_PLUGIN_ENTRY_CANDIDATES = ["dist/index.js", "index.js"] as const;

export const BUILTIN_PLUGINS: ReadonlyArray<{ slot: PluginSlot; name: string; pkg: string }> = [
  { slot: "runtime", name: "tmux", pkg: "@jleechanorg/ao-plugin-runtime-tmux" },
  { slot: "runtime", name: "process", pkg: "@jleechanorg/ao-plugin-runtime-process" },
  { slot: "runtime", name: "antigravity", pkg: "@jleechanorg/ao-plugin-runtime-antigravity" },
  { slot: "runtime", name: "mcp-ao", pkg: "@jleechanorg/ao-plugin-mcp-ao" },
  { slot: "runtime", name: "prose-polish", pkg: "@jleechanorg/ao-plugin-prose-polish" },
  { slot: "agent", name: "claude-code", pkg: "@jleechanorg/ao-plugin-agent-claude-code" },
  { slot: "agent", name: "codex", pkg: "@jleechanorg/ao-plugin-agent-codex" },
  { slot: "agent", name: "aider", pkg: "@jleechanorg/ao-plugin-agent-aider" },
  { slot: "agent", name: "cursor", pkg: "@jleechanorg/ao-plugin-agent-cursor" },
  { slot: "agent", name: "kimicode", pkg: "@jleechanorg/ao-plugin-agent-kimicode" },
  { slot: "agent", name: "opencode", pkg: "@jleechanorg/ao-plugin-agent-opencode" },
  { slot: "agent", name: "gemini", pkg: "@jleechanorg/ao-plugin-agent-gemini" },
  { slot: "agent", name: "minimax", pkg: "@jleechanorg/ao-plugin-agent-minimax" },
  { slot: "agent", name: "wafer", pkg: "@jleechanorg/ao-plugin-agent-wafer" },
  { slot: "workspace", name: "worktree", pkg: "@jleechanorg/ao-plugin-workspace-worktree" },
  { slot: "workspace", name: "clone", pkg: "@jleechanorg/ao-plugin-workspace-clone" },
  { slot: "tracker", name: "github", pkg: "@jleechanorg/ao-plugin-tracker-github" },
  { slot: "tracker", name: "linear", pkg: "@jleechanorg/ao-plugin-tracker-linear" },
  { slot: "tracker", name: "gitlab", pkg: "@jleechanorg/ao-plugin-tracker-gitlab" },
  { slot: "tracker", name: "beads", pkg: "@jleechanorg/ao-plugin-tracker-beads" },
  { slot: "scm", name: "github", pkg: "@jleechanorg/ao-plugin-scm-github" },
  { slot: "scm", name: "gitlab", pkg: "@jleechanorg/ao-plugin-scm-gitlab" },
  { slot: "notifier", name: "composio", pkg: "@jleechanorg/ao-plugin-notifier-composio" },
  { slot: "notifier", name: "desktop", pkg: "@jleechanorg/ao-plugin-notifier-desktop" },
  { slot: "notifier", name: "discord", pkg: "@jleechanorg/ao-plugin-notifier-discord" },
  { slot: "notifier", name: "mcp-mail", pkg: "@jleechanorg/ao-plugin-notifier-mcp-mail" },
  { slot: "notifier", name: "openclaw", pkg: "@jleechanorg/ao-plugin-notifier-openclaw" },
  { slot: "notifier", name: "slack", pkg: "@jleechanorg/ao-plugin-notifier-slack" },
  { slot: "notifier", name: "webhook", pkg: "@jleechanorg/ao-plugin-notifier-webhook" },
  { slot: "terminal", name: "iterm2", pkg: "@jleechanorg/ao-plugin-terminal-iterm2" },
  { slot: "terminal", name: "web", pkg: "@jleechanorg/ao-plugin-terminal-web" },
  { slot: "poller", name: "github-pr", pkg: "@jleechanorg/ao-plugin-poller-github-pr" },
];

function makeKey(slot: PluginSlot, name: string): string {
  return `${slot}:${name}`;
}

function matchesNotifierPlugin(
  pluginName: string,
  notifierId: string,
  notifierConfig: Record<string, unknown>,
): boolean {
  const configuredPlugin = notifierConfig["plugin"];
  const hasExplicitPlugin = typeof configuredPlugin === "string" && configuredPlugin.length > 0;
  return hasExplicitPlugin ? configuredPlugin === pluginName : notifierId === pluginName;
}

function collectNotifierRegistrations(
  pluginName: string,
  config: OrchestratorConfig,
  isExternalLoad = false,
): NotifierRegistration[] {
  const orderedMatches = new Map<string, Record<string, unknown>>();
  const notifierEntries = Object.entries(config.notifiers ?? {});

  const exactMatch = config.notifiers?.[pluginName];
  if (
    exactMatch &&
    typeof exactMatch === "object" &&
    matchesNotifierPlugin(pluginName, pluginName, exactMatch)
  ) {
    orderedMatches.set(pluginName, exactMatch);
  }

  for (const [notifierId, notifierConfig] of notifierEntries) {
    if (!notifierConfig || typeof notifierConfig !== "object") continue;
    if (matchesNotifierPlugin(pluginName, notifierId, notifierConfig)) {
      orderedMatches.set(notifierId, notifierConfig);
    }
  }

  return [...orderedMatches.entries()].map(([registrationName, rawConfig]) => ({
    registrationName,
    config: prepareConfig(
      "notifier",
      pluginName,
      registrationName,
      rawConfig,
      config.configPath,
      isExternalLoad,
    ),
  }));
}

function prepareConfig(
  slot: string,
  name: string,
  sourceId: string,
  rawConfig: Record<string, unknown>,
  configPath?: string,
  isExternalLoad = false,
): Record<string, unknown> {
  if ("package" in rawConfig && "path" in rawConfig) {
    throw new Error(
      `In ${slot} "${sourceId}": both "package" and "path" are specified. ` +
        `Use "package" for npm plugins or "path" for local plugins, not both.`,
    );
  }

  const isBuiltin = !isExternalLoad && BUILTIN_PLUGINS.some((b) => b.slot === slot && b.name === name);
  if ((rawConfig.package || isBuiltin) && "path" in rawConfig) {
    const loadingMethod = rawConfig.package ? `npm package "${rawConfig.package}"` : `built-in plugin "${name}"`;
    throw new Error(
      `In ${slot} "${sourceId}": "path" field conflicts with reserved plugin loading field. ` +
        `You're loading via ${loadingMethod}, but also have a "path" field which would be stripped. ` +
        `Rename your configuration field to something else (e.g., "apiPath", "webhookPath").`,
    );
  }

  const { plugin: _plugin, package: _package, path: _path, ...rest } = rawConfig;
  return configPath ? { ...rest, configPath } : rest;
}

function buildExternalPluginIndex(
  externalEntries: ExternalPluginEntryRef[] | undefined,
): Map<string, ExternalPluginEntryRef[]> {
  const index = new Map<string, ExternalPluginEntryRef[]>();
  if (!externalEntries) return index;

  for (const entry of externalEntries) {
    const key = entry.package ? `package:${entry.package}` : `path:${entry.path}`;
    const existing = index.get(key);
    if (existing) {
      existing.push(entry);
    } else {
      index.set(key, [entry]);
    }
  }

  return index;
}

function findAllExternalPluginEntries(
  plugin: InstalledPluginConfig,
  externalIndex: Map<string, ExternalPluginEntryRef[]>,
): ExternalPluginEntryRef[] {
  if (plugin.package) {
    return externalIndex.get(`package:${plugin.package}`) ?? [];
  }
  if (plugin.path) {
    return externalIndex.get(`path:${plugin.path}`) ?? [];
  }
  return [];
}

function validateManifestName(
  manifest: PluginManifest,
  entry: ExternalPluginEntryRef,
  specifier: string,
): void {
  if (entry.expectedPluginName && entry.expectedPluginName !== manifest.name) {
    const specifierType = entry.package ? "package" : "path";
    throw new Error(
      `Plugin manifest.name mismatch at ${entry.source}: ` +
        `expected "${entry.expectedPluginName}" but ${specifierType} "${specifier}" has manifest.name "${manifest.name}". ` +
        `Either update the 'plugin' field to match the actual manifest.name, or remove it to auto-infer.`,
    );
  }
}

function updateConfigWithManifestName(
  manifest: PluginManifest,
  entry: ExternalPluginEntryRef,
  config: OrchestratorConfig,
): void {
  const { location, slot, source } = entry;

  if (location.kind === "project") {
    const { projectId, configType } = location;
    const project = config.projects[projectId];
    if (project?.[configType]) {
      project[configType]!.plugin = manifest.name;
    }
  } else if (location.kind === "notifier") {
    const { notifierId } = location;
    const notifierConfig = config.notifiers[notifierId];
    if (notifierConfig) {
      notifierConfig.plugin = manifest.name;
    }
  }

  if (manifest.slot !== slot) {
    process.stderr.write(
      `[plugin-registry] Plugin at ${source} has slot "${manifest.slot}" but was configured as "${slot}". ` +
        `The plugin will be registered under its declared slot "${manifest.slot}".\n`,
    );
  }
}

export function isPluginModule(value: unknown): value is PluginModule {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PluginModule>;
  return Boolean(candidate.manifest && typeof candidate.create === "function");
}

export function normalizeImportedPluginModule(value: unknown): PluginModule | null {
  if (isPluginModule(value)) return value;

  if (value && typeof value === "object" && "default" in value) {
    const defaultExport = (value as { default?: unknown }).default;
    if (isPluginModule(defaultExport)) return defaultExport;
  }

  return null;
}

function resolveConfigRelativePath(targetPath: string, configPath?: string): string {
  if (isAbsolute(targetPath)) return targetPath;
  const baseDir = configPath ? dirname(configPath) : process.cwd();
  return resolve(baseDir, targetPath);
}

export function resolvePackageExportsEntry(exportsField: unknown): string | null {
  if (typeof exportsField === "string") return exportsField;
  if (!exportsField || typeof exportsField !== "object") return null;

  const exportsRecord = exportsField as Record<string, unknown>;
  const dotEntry = exportsRecord["."];

  if (typeof dotEntry === "string") return dotEntry;
  if (dotEntry && typeof dotEntry === "object") {
    const importEntry = (dotEntry as Record<string, unknown>)["import"];
    if (typeof importEntry === "string") return importEntry;
    const defaultEntry = (dotEntry as Record<string, unknown>)["default"];
    if (typeof defaultEntry === "string") return defaultEntry;
  }

  const importEntry = exportsRecord["import"];
  if (typeof importEntry === "string") return importEntry;

  const defaultEntry = exportsRecord["default"];
  if (typeof defaultEntry === "string") return defaultEntry;

  return null;
}

export function resolveLocalPluginEntrypoint(pluginPath: string): string | null {
  if (!existsSync(pluginPath)) return null;

  let stat;
  try {
    stat = statSync(pluginPath);
  } catch {
    return null;
  }

  if (stat.isFile()) return pluginPath;
  if (!stat.isDirectory()) return null;

  const packageJsonPath = join(pluginPath, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const raw = readFileSync(packageJsonPath, "utf-8");
      const packageJson = JSON.parse(raw) as {
        exports?: unknown;
        module?: unknown;
        main?: unknown;
      };

      const exportsEntry = resolvePackageExportsEntry(packageJson.exports);
      if (exportsEntry) {
        const resolvedEntry = resolve(pluginPath, exportsEntry);
        if (existsSync(resolvedEntry)) return resolvedEntry;
      }

      if (typeof packageJson.module === "string") {
        const moduleEntry = resolve(pluginPath, packageJson.module);
        if (existsSync(moduleEntry)) return moduleEntry;
      }

      if (typeof packageJson.main === "string") {
        const mainEntry = resolve(pluginPath, packageJson.main);
        if (existsSync(mainEntry)) return mainEntry;
      }
    } catch {
      // fall through
    }
  }

  for (const candidate of LOCAL_PLUGIN_ENTRY_CANDIDATES) {
    const entry = join(pluginPath, candidate);
    if (existsSync(entry)) return entry;
  }

  return null;
}

function inferPackageSpecifier(value: string | undefined): string | null {
  if (!value) return null;
  if (value.startsWith(".") || value.startsWith("/")) return null;
  return value.startsWith("@") || value.includes("/") ? value : null;
}

function resolvePluginSpecifier(
  plugin: InstalledPluginConfig,
  config: OrchestratorConfig,
): string | null {
  switch (plugin.source) {
    case "local": {
      if (!plugin.path) return null;
      const absolutePath = resolveConfigRelativePath(plugin.path, config.configPath);
      const entrypoint = resolveLocalPluginEntrypoint(absolutePath);
      return entrypoint ? pathToFileURL(entrypoint).href : null;
    }
    case "registry":
    case "npm":
      return plugin.package ?? inferPackageSpecifier(plugin.name);
    default:
      return null;
  }
}

export function createPluginRegistry(): PluginRegistry {
  const plugins: PluginMap = new Map();

  function registerInstance(
    slot: PluginSlot,
    name: string,
    manifest: PluginManifest,
    instance: unknown,
  ): void {
    plugins.set(makeKey(slot, name), { manifest, instance });
  }

  function registerNotifier(
    plugin: PluginModule,
    config: OrchestratorConfig,
    isExternalLoad = false,
  ): void {
    const { manifest } = plugin;
    const registrations = collectNotifierRegistrations(manifest.name, config, isExternalLoad);

    if (registrations.length === 0) {
      registerInstance(manifest.slot, manifest.name, manifest, plugin.create(undefined));
      return;
    }

    for (const [index, registration] of registrations.entries()) {
      const instance = plugin.create(registration.config);
      registerInstance(manifest.slot, registration.registrationName, manifest, instance);

      if (index === 0 && registration.registrationName !== manifest.name) {
        registerInstance(manifest.slot, manifest.name, manifest, instance);
      }
    }
  }

  const registry: PluginRegistry = {
    register(plugin: PluginModule, config?: Record<string, unknown>): void {
      const { manifest } = plugin;
      const instance = plugin.create(config);
      registerInstance(manifest.slot, manifest.name, manifest, instance);
    },

    get<T>(slot: PluginSlot, name: string): T | null {
      const entry = plugins.get(makeKey(slot, name));
      return entry ? (entry.instance as T) : null;
    },

    list(slot: PluginSlot): PluginManifest[] {
      const result = new Map<string, PluginManifest>();
      for (const [key, entry] of plugins) {
        if (key.startsWith(`${slot}:`) && !result.has(entry.manifest.name)) {
          result.set(entry.manifest.name, entry.manifest);
        }
      }
      return [...result.values()];
    },

    async loadBuiltins(
      orchestratorConfig?: OrchestratorConfig,
      importFn?: (pkg: string) => Promise<unknown>,
      fallbackImportFn?: (pkg: string, selfUrl: string) => Promise<unknown>,
    ): Promise<void> {
      const doImport = importFn ?? ((pkg: string) => import(pkg));
      const selfUrl = import.meta.url;
      const doFallback = fallbackImportFn ?? tryMonorepoFallback;

      for (const builtin of BUILTIN_PLUGINS) {
        let mod: PluginModule | null = null;
        try {
          mod = normalizeImportedPluginModule(await doImport(builtin.pkg));
        } catch (err) {
          const shouldTryFallback = isPackageResolutionFailure(err, builtin.pkg);
          if (shouldTryFallback) {
            try {
              mod = normalizeImportedPluginModule(await doFallback(builtin.pkg, selfUrl));
            } catch {
              // fallback also failed
            }
          }
          if (!mod) {
            console.warn(
              `[plugin-registry] failed to load builtin plugin '${builtin.pkg}':` +
                ` ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        if (mod) {
          try {
            if (orchestratorConfig && mod.manifest.slot === "notifier") {
              registerNotifier(mod, orchestratorConfig);
            } else {
              this.register(mod);
            }
          } catch (error) {
            process.stderr.write(
              `[plugin-registry] Failed to load built-in plugin "${builtin.name}": ${error}\n`,
            );
          }
        }
      }
    },

    async loadFromConfig(
      config: OrchestratorConfig,
      importFn?: (pkg: string) => Promise<unknown>,
      fallbackImportFn?: (pkg: string, selfUrl: string) => Promise<unknown>,
    ): Promise<void> {
      await this.loadBuiltins(config, importFn, fallbackImportFn);

      const doImport = importFn ?? ((pkg: string) => import(pkg));
      const externalIndex = buildExternalPluginIndex(config._externalPluginEntries);

      for (const plugin of config.plugins ?? []) {
        if (plugin.enabled === false) continue;

        const specifier = resolvePluginSpecifier(plugin, config);
        if (!specifier) {
          process.stderr.write(
            `[plugin-registry] Could not resolve specifier for plugin "${plugin.name}" (source: ${plugin.source})\n`,
          );
          continue;
        }

        try {
          const mod = normalizeImportedPluginModule(await doImport(specifier));
          if (!mod) continue;

          const matchingEntries = findAllExternalPluginEntries(plugin, externalIndex);
          for (const externalEntry of matchingEntries) {
            try {
              validateManifestName(mod.manifest, externalEntry, specifier);
              updateConfigWithManifestName(mod.manifest, externalEntry, config);
            } catch (validationError) {
              process.stderr.write(
                `[plugin-registry] Config validation failed for ${externalEntry.source}: ${validationError}\n`,
              );
            }
          }

          if (mod.manifest.slot === "notifier") {
            registerNotifier(mod, config, true);
          } else {
            this.register(mod);
          }
        } catch (error) {
          process.stderr.write(
            `[plugin-registry] Failed to load plugin "${specifier}": ${error}\n`,
          );
        }
      }
    },
  };

  applyForkExtensions(registry);

  return registry;
}
