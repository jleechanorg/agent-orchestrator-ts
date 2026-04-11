/**
 * Plugin Registry — discovers and loads plugins.
 *
 * Plugins can be:
 * 1. Built-in (packages/plugins/*)
 * 2. npm packages (@jleechanorg/ao-plugin-*)
 * 3. Local file paths specified in config
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import type {
  PluginSlot,
  PluginManifest,
  PluginModule,
  PluginRegistry,
  OrchestratorConfig,
} from "./types.js";

/** Map from "slot:name" → plugin instance */
type PluginMap = Map<string, { manifest: PluginManifest; instance: unknown }>;

/**
 * True when `err` indicates the requested npm package could not be resolved
 * (missing from node_modules / workspace), not runtime/init failures inside a
 * resolved package. Used to avoid swapping in a monorepo copy when the installed
 * plugin threw for other reasons.
 */
export function isPackageResolutionFailure(err: unknown, pkg: string): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") {
    return msg.includes(pkg);
  }
  if (!msg.includes(pkg)) return false;
  if (/cannot find (package|module)/i.test(msg)) return true;
  if (/module not found/i.test(msg)) return true;
  if (/^Not found:/i.test(msg.trim())) return true;
  return false;
}

/**
 * Attempt to resolve a plugin via a path relative to the monorepo root.
 *
 * Uses plugin-registry's own location (`packages/core/dist/`) to walk up to
 * the monorepo root, then into `packages/plugins/<name>/dist/index.js`.
 *
 * Works when `ao` is run from outside the monorepo — npm cannot resolve
 * workspace-linked packages, but the files are present in the monorepo.
 *
 * @param pkg  The package name (e.g. "@jleechanorg/ao-plugin-agent-gemini")
 * @param modUrl  import.meta.url of plugin-registry.js
 * @returns The loaded plugin module, or null if resolution failed
 */
async function tryMonorepoFallback(
  pkg: string,
  modUrl: string,
): Promise<unknown> {
  const match = pkg.match(/^@jleechanorg\/ao-plugin-(.+)$/);
  if (!match) return null;
  const pluginName = match[1]!;

  try {
    // plugin-registry.ts lives at packages/core/dist/plugin-registry.js
    // Navigate up to monorepo root: ../../../ → project root (dist → core → packages → root)
    const coreDir = dirname(fileURLToPath(modUrl)); // packages/core/dist
    const monorepoRoot = resolve(coreDir, "../../../");
    const pluginPath = join(monorepoRoot, "packages", "plugins", pluginName, "dist", "index.js");

    // Build a file:// URL so dynamic import() can load it as ESM (Windows-safe)
    const pluginUrl = pathToFileURL(pluginPath).href;
    return await import(pluginUrl);
  } catch {
    return null;
  }
}

function makeKey(slot: PluginSlot, name: string): string {
  return `${slot}:${name}`;
}

/** Built-in plugin package names, mapped to their npm package (exported for tests) */
export const BUILTIN_PLUGINS: ReadonlyArray<{ slot: PluginSlot; name: string; pkg: string }> = [
  // Runtimes
  { slot: "runtime", name: "tmux", pkg: "@jleechanorg/ao-plugin-runtime-tmux" },
  { slot: "runtime", name: "process", pkg: "@jleechanorg/ao-plugin-runtime-process" },
  { slot: "runtime", name: "antigravity", pkg: "@jleechanorg/ao-plugin-runtime-antigravity" },
  // Agents
  { slot: "agent", name: "claude-code", pkg: "@jleechanorg/ao-plugin-agent-claude-code" },
  { slot: "agent", name: "codex", pkg: "@jleechanorg/ao-plugin-agent-codex" },
  { slot: "agent", name: "cursor", pkg: "@jleechanorg/ao-plugin-agent-cursor" },
  { slot: "agent", name: "gemini", pkg: "@jleechanorg/ao-plugin-agent-gemini" },
  { slot: "agent", name: "minimax", pkg: "@jleechanorg/ao-plugin-agent-minimax" },
  { slot: "agent", name: "aider", pkg: "@jleechanorg/ao-plugin-agent-aider" },
  { slot: "agent", name: "opencode", pkg: "@jleechanorg/ao-plugin-agent-opencode" },
  // Workspaces
  { slot: "workspace", name: "worktree", pkg: "@jleechanorg/ao-plugin-workspace-worktree" },
  { slot: "workspace", name: "clone", pkg: "@jleechanorg/ao-plugin-workspace-clone" },
  // Trackers
  { slot: "tracker", name: "github", pkg: "@jleechanorg/ao-plugin-tracker-github" },
  { slot: "tracker", name: "linear", pkg: "@jleechanorg/ao-plugin-tracker-linear" },
  { slot: "tracker", name: "gitlab", pkg: "@jleechanorg/ao-plugin-tracker-gitlab" },
  { slot: "tracker", name: "beads", pkg: "@jleechanorg/ao-plugin-tracker-beads" },
  // SCM
  { slot: "scm", name: "github", pkg: "@jleechanorg/ao-plugin-scm-github" },
  { slot: "scm", name: "gitlab", pkg: "@jleechanorg/ao-plugin-scm-gitlab" },
  // Notifiers
  { slot: "notifier", name: "composio", pkg: "@jleechanorg/ao-plugin-notifier-composio" },
  { slot: "notifier", name: "desktop", pkg: "@jleechanorg/ao-plugin-notifier-desktop" },
  { slot: "notifier", name: "discord", pkg: "@jleechanorg/ao-plugin-notifier-discord" },
  { slot: "notifier", name: "mcp-mail", pkg: "@jleechanorg/ao-plugin-notifier-mcp-mail" },
  { slot: "notifier", name: "openclaw", pkg: "@jleechanorg/ao-plugin-notifier-openclaw" },
  { slot: "notifier", name: "slack", pkg: "@jleechanorg/ao-plugin-notifier-slack" },
  { slot: "notifier", name: "webhook", pkg: "@jleechanorg/ao-plugin-notifier-webhook" },
  // Terminals
  { slot: "terminal", name: "iterm2", pkg: "@jleechanorg/ao-plugin-terminal-iterm2" },
  { slot: "terminal", name: "web", pkg: "@jleechanorg/ao-plugin-terminal-web" },
  // Pollers
  { slot: "poller", name: "github-pr", pkg: "@jleechanorg/ao-plugin-poller-github-pr" },
  // Runtimes
  { slot: "runtime", name: "prose-polish", pkg: "@jleechanorg/ao-plugin-prose-polish" },
];

/** Extract plugin-specific config from orchestrator config */
function extractPluginConfig(
  slot: PluginSlot,
  name: string,
  config: OrchestratorConfig,
): Record<string, unknown> | undefined {
  // Notifiers are configured under config.notifiers.<id>.
  // Match by key (e.g. "openclaw") or explicit plugin field.
  if (slot === "notifier") {
    for (const [notifierName, notifierConfig] of Object.entries(config.notifiers ?? {})) {
      if (!notifierConfig || typeof notifierConfig !== "object") continue;
      const configuredPlugin = (notifierConfig as Record<string, unknown>)["plugin"];
      const hasExplicitPlugin = typeof configuredPlugin === "string" && configuredPlugin.length > 0;
      const matches = hasExplicitPlugin ? configuredPlugin === name : notifierName === name;
      if (matches) {
        const { plugin: _plugin, ...rest } = notifierConfig as Record<string, unknown>;
        return rest;
      }
    }
  }

  // SCM plugins are configured under config.plugins.<plugin-name> (e.g., plugins["scm-github"])
  if (slot === "scm") {
    const pluginConfig = config.plugins?.[`scm-${name}`];
    if (pluginConfig && typeof pluginConfig === "object") {
      return pluginConfig as Record<string, unknown>;
    }
  }

  // Poller plugins: config.plugins["poller-<name>"] (e.g., plugins["poller-github-pr"])
  if (slot === "poller") {
    const pluginConfig = config.plugins?.[`poller-${name}`];
    if (pluginConfig && typeof pluginConfig === "object") {
      return pluginConfig as Record<string, unknown>;
    }
  }

  return undefined;
}

export function createPluginRegistry(): PluginRegistry {
  const plugins: PluginMap = new Map();

  return {
    register(plugin: PluginModule, config?: Record<string, unknown>): void {
      const { manifest } = plugin;
      const key = makeKey(manifest.slot, manifest.name);
      const instance = plugin.create(config);
      plugins.set(key, { manifest, instance });
    },

    get<T>(slot: PluginSlot, name: string): T | null {
      const entry = plugins.get(makeKey(slot, name));
      return entry ? (entry.instance as T) : null;
    },

    list(slot: PluginSlot): PluginManifest[] {
      const result: PluginManifest[] = [];
      for (const [key, entry] of plugins) {
        if (key.startsWith(`${slot}:`)) {
          result.push(entry.manifest);
        }
      }
      return result;
    },

    async loadBuiltins(
      orchestratorConfig?: OrchestratorConfig,
      importFn?: (pkg: string) => Promise<unknown>,
      fallbackImportFn?: (pkg: string, selfUrl: string) => Promise<unknown>,
    ): Promise<void> {
      const doImport = importFn ?? ((pkg: string) => import(pkg));
      const selfUrl = import.meta.url; // plugin-registry.js URL for fallback resolution
      const doFallback = fallbackImportFn ?? tryMonorepoFallback;
      for (const builtin of BUILTIN_PLUGINS) {
        let mod: PluginModule | null = null;
        try {
          mod = (await doImport(builtin.pkg)) as PluginModule;
        } catch (err) {
          // Primary import failed — try monorepo-relative resolution only when the
          // package itself could not be resolved (not init/runtime errors).
          const shouldTryFallback = isPackageResolutionFailure(err, builtin.pkg);
          let fallback: unknown = null;
          if (shouldTryFallback) {
            fallback = await doFallback(builtin.pkg, selfUrl);
          }
          if (fallback) {
            mod = fallback as PluginModule;
          } else {
            console.warn(
              `[plugin-registry] failed to load builtin plugin '${builtin.pkg}':` +
                ` ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (mod?.manifest && typeof mod.create === "function") {
          const pluginConfig = orchestratorConfig
            ? extractPluginConfig(builtin.slot, builtin.name, orchestratorConfig)
            : undefined;
          this.register(mod, pluginConfig);
        }
      }
    },

    async loadFromConfig(
      config: OrchestratorConfig,
      importFn?: (pkg: string) => Promise<unknown>,
      fallbackImportFn?: (pkg: string, selfUrl: string) => Promise<unknown>,
    ): Promise<void> {
      // Load built-ins with orchestrator config so plugins receive their settings
      await this.loadBuiltins(config, importFn, fallbackImportFn);

      // Then, load any additional plugins specified in project configs
      // (future: support npm package names and local file paths)
    },
  };
}
