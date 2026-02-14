/**
 * Plugin Registry — discovers and loads plugins.
 *
 * Plugins can be:
 * 1. Built-in (packages/plugins/*)
 * 2. npm packages (@agent-orchestrator/plugin-*)
 * 3. Local file paths specified in config
 */

import type {
  PluginSlot,
  PluginManifest,
  PluginModule,
  PluginRegistry,
  OrchestratorConfig,
} from "./types.js";

/** Map from "slot:name" → plugin instance */
type PluginMap = Map<string, { manifest: PluginManifest; instance: unknown }>;

function makeKey(slot: PluginSlot, name: string): string {
  return `${slot}:${name}`;
}

/** Built-in plugin package names, mapped to their npm package */
const BUILTIN_PLUGINS: Array<{ slot: PluginSlot; name: string; pkg: string }> = [
  // Runtimes
  { slot: "runtime", name: "tmux", pkg: "@agent-orchestrator/plugin-runtime-tmux" },
  { slot: "runtime", name: "process", pkg: "@agent-orchestrator/plugin-runtime-process" },
  // Agents
  { slot: "agent", name: "claude-code", pkg: "@agent-orchestrator/plugin-agent-claude-code" },
  { slot: "agent", name: "codex", pkg: "@agent-orchestrator/plugin-agent-codex" },
  { slot: "agent", name: "aider", pkg: "@agent-orchestrator/plugin-agent-aider" },
  // Workspaces
  { slot: "workspace", name: "worktree", pkg: "@agent-orchestrator/plugin-workspace-worktree" },
  { slot: "workspace", name: "clone", pkg: "@agent-orchestrator/plugin-workspace-clone" },
  // Trackers
  { slot: "tracker", name: "github", pkg: "@agent-orchestrator/plugin-tracker-github" },
  { slot: "tracker", name: "linear", pkg: "@agent-orchestrator/plugin-tracker-linear" },
  // SCM
  { slot: "scm", name: "github", pkg: "@agent-orchestrator/plugin-scm-github" },
  // Notifiers
  { slot: "notifier", name: "desktop", pkg: "@agent-orchestrator/plugin-notifier-desktop" },
  { slot: "notifier", name: "slack", pkg: "@agent-orchestrator/plugin-notifier-slack" },
  { slot: "notifier", name: "webhook", pkg: "@agent-orchestrator/plugin-notifier-webhook" },
  // Terminals
  { slot: "terminal", name: "iterm2", pkg: "@agent-orchestrator/plugin-terminal-iterm2" },
  { slot: "terminal", name: "web", pkg: "@agent-orchestrator/plugin-terminal-web" },
];

/** Extract plugin-specific config from orchestrator config */
function extractPluginConfig(
  slot: PluginSlot,
  name: string,
  config: OrchestratorConfig,
): Record<string, unknown> | undefined {
  // Map well-known orchestrator config fields to plugin config
  if (slot === "workspace" && name === "worktree" && config.worktreeDir) {
    return { worktreeDir: config.worktreeDir };
  }
  if (slot === "workspace" && name === "clone" && config.worktreeDir) {
    return { cloneDir: config.worktreeDir };
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

    async loadBuiltins(orchestratorConfig?: OrchestratorConfig): Promise<void> {
      for (const builtin of BUILTIN_PLUGINS) {
        try {
          const mod = (await import(builtin.pkg)) as PluginModule;
          if (mod.manifest && typeof mod.create === "function") {
            const pluginConfig = orchestratorConfig
              ? extractPluginConfig(builtin.slot, builtin.name, orchestratorConfig)
              : undefined;
            this.register(mod, pluginConfig);
          }
        } catch {
          // Plugin not installed — that's fine, only load what's available
        }
      }
    },

    async loadFromConfig(config: OrchestratorConfig): Promise<void> {
      // Load built-ins with orchestrator config so plugins receive their settings
      await this.loadBuiltins(config);

      // Then, load any additional plugins specified in project configs
      // (future: support npm package names and local file paths)
    },
  };
}
