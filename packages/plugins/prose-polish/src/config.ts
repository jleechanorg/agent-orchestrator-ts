/**
 * Prose-polish runtime configuration.
 */
export interface ProsePolishConfig {
  defaultCategories?: string[];
  autoFix?: boolean;
  minSeverity?: "info" | "warn" | "critical";
  proximityWindow?: number;
  notXThreshold?: number;
}

export function parseConfig(options: unknown): ProsePolishConfig {
  if (options && typeof options === "object") {
    return options as ProsePolishConfig;
  }
  return {};
}
