/**
 * Config hot-reload — watches agent-orchestrator.yaml for changes and auto-reloads.
 *
 * Companion module: config.ts is upstream code; hot-reload is a fork feature
 * so it lives here to avoid merge conflicts.
 */

import { watch, type FSWatcher } from "node:fs";
import { existsSync } from "node:fs";
import type { OrchestratorConfig } from "./types.js";

export interface ConfigHotReloadOptions {
  configPath: string;
  reload: () => OrchestratorConfig;
  onChange: (config: OrchestratorConfig) => void;
  onError: (error: Error) => void;
  debounceMs?: number;
}

export interface ConfigHotReloadHandle {
  close(): void;
  getConfig(): OrchestratorConfig;
}

const DEFAULT_DEBOUNCE_MS = 1000;

export function startConfigHotReload(options: ConfigHotReloadOptions): ConfigHotReloadHandle | null {
  if (!existsSync(options.configPath)) {
    return null;
  }

  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let currentConfig: OrchestratorConfig = options.reload();

  const watcher: FSWatcher = watch(options.configPath, (eventType) => {
    if (eventType !== "change") return;

    if (timer !== null) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      try {
        currentConfig = options.reload();
        options.onChange(currentConfig);
      } catch (err) {
        options.onError(err instanceof Error ? err : new Error(String(err)));
      }
      timer = null;
    }, debounceMs);
  });

  watcher.on("error", (err) => {
    options.onError(err instanceof Error ? err : new Error(String(err)));
  });

  return {
    close() {
      if (timer !== null) {
        clearTimeout(timer);
      }
      watcher.close();
    },
    getConfig() {
      return currentConfig;
    },
  };
}
