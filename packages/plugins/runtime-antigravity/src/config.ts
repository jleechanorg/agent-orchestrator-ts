/**
 * Zod-based configuration for the Antigravity runtime plugin.
 *
 * Provides validated, defaulted configuration for the runtime,
 * including model selection, polling intervals, Peekaboo binary
 * paths, CLI fallback settings, and multi-repo workspace mapping.
 */

import { z } from "zod";

// =============================================================================
// Antigravity Runtime Config
// =============================================================================

export const AntigravityConfigSchema = z.object({
  /** Default model to use in Antigravity conversations. */
  defaultModel: z.string().default("Claude Opus 4.6"),
  /** Default planning mode. */
  defaultMode: z.enum(["Planning", "Fast"]).default("Planning"),
  /** Poll interval for idle detection (ms). Minimum 5 000 ms. */
  pollIntervalMs: z.number().min(5000).default(15000),
  /** Max capacity backoff time (ms). */
  maxCapacityBackoffMs: z.number().default(3600000),
  /** Peekaboo binary path. */
  peekabooBin: z.string().default("peekaboo"),
  /** Claude Code CLI binary path for fallback. */
  fallbackCliBin: z.string().default("claude"),
  /** CLI flags for fallback. */
  fallbackCliFlags: z
    .array(z.string())
    .default(["--dangerously-skip-permissions"]),
  /** Max fallback retries. */
  fallbackMaxRetries: z.number().min(0).default(3),
});

export type AntigravityConfig = z.infer<typeof AntigravityConfigSchema>;

// =============================================================================
// Multi-repo Workspace Mapping
// =============================================================================

export const WorkspaceMapSchema = z.record(
  z.string(),
  z.object({
    /** Path to the local repo. */
    repoPath: z.string(),
    /** Antigravity workspace name (as shown in Manager sidebar). */
    workspaceName: z.string(),
    /** Optional worktree directory for creating branches. */
    worktreeDir: z.string().optional(),
  }),
);

export type WorkspaceMap = z.infer<typeof WorkspaceMapSchema>;

// =============================================================================
// Parsing helpers
// =============================================================================

/**
 * Parse and validate raw config input.
 *
 * @param raw - Untyped configuration object (e.g. from a JSON file or plugin options).
 * @returns Validated AntigravityConfig with defaults applied.
 * @throws {ZodError} if validation fails.
 */
export function parseConfig(raw: unknown): AntigravityConfig {
  return AntigravityConfigSchema.parse(raw);
}

/**
 * Return a config object with all defaults.
 */
export function defaultConfig(): AntigravityConfig {
  return AntigravityConfigSchema.parse({});
}
