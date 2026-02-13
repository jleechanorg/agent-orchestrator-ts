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

export function createPluginRegistry(): PluginRegistry {
  const plugins: PluginMap = new Map();

  return {
    register(plugin: PluginModule): void {
      const { manifest } = plugin;
      const key = makeKey(manifest.slot, manifest.name);
      const instance = plugin.create();
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

    async loadBuiltins(): Promise<void> {
      for (const builtin of BUILTIN_PLUGINS) {
        try {
          const mod = (await import(builtin.pkg)) as PluginModule;
          if (mod.manifest && typeof mod.create === "function") {
            this.register(mod);
          }
        } catch {
          // Plugin not installed — that's fine, only load what's available
        }
      }
    },

    async loadFromConfig(config: OrchestratorConfig): Promise<void> {
      // First, load all built-ins
      await this.loadBuiltins();

      // Then, load any additional plugins specified in project configs
      // (future: support npm package names and local file paths)
    },
  };
}
