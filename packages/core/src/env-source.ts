/**
 * env-source — source shell init files and merge API-key env vars into process.env.
 *
 * The AO daemon does NOT inherit from ~/.bashrc when it starts (it is not a login
 * shell). This module lets the config specify init files to source at startup so that
 * API keys (MINIMAX_API_KEY, ANTHROPIC_API_KEY, etc.) are available to plugins via
 * process.env without duplicating secrets into YAML config or .env files.
 *
 * Only vars matching known API-key prefixes are merged to avoid PATH/PS1 pollution.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

/** Prefixes of env vars that are safe to import from sourced shell init files. */
const ALLOWED_PREFIXES = [
  "MINIMAX_",
  "ANTHROPIC_",
  "OPENAI_",
  "MCP_AGENT_MAIL_",
  "AO_",
] as const;

/** Snapshot of process.env at import time — used to compute the diff. */
const ENV_BEFORE: Record<string, string | undefined> = { ...process.env };

/** Expand ~ in a file path. */
function expandHome(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return filepath.replace("~", homedir());
  }
  return filepath;
}

/**
 * Source a single shell init file and return any NEW env vars it defines
 * that match allowed prefixes.
 *
 * Runs `bash -c 'source <file> && env'` and diffs the output against
 * the env snapshot taken before sourcing. Returns only vars that appeared
 * (or changed) after sourcing.
 *
 * @param filepath - Path to the shell init file (supports ~ expansion).
 * @param beforeSnapshot - Optional env snapshot to diff against. Defaults to
 *   ENV_BEFORE (the snapshot taken at module import time). Pass a fresh
 *   snapshot between files to allow later files to override earlier ones.
 */
export function sourceEnvFile(
  filepath: string,
  beforeSnapshot?: Record<string, string | undefined>,
): Record<string, string> {
  const expanded = expandHome(filepath);

  if (!existsSync(expanded)) {
    return {};
  }

  const diffAgainst = beforeSnapshot ?? ENV_BEFORE;

  try {
    // Use execFileSync to avoid shell injection — no shell interpolation.
    const output = execFileSync(
      "bash",
      ["-c", `source "$1" > /dev/null 2>&1 && env`, "--", expanded],
      { timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] },
    )
      .toString()
      .trim();

    const newVars: Record<string, string> = {};

    for (const line of output.split("\n")) {
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) continue;
      const key = line.slice(0, eqIndex);
      const value = line.slice(eqIndex + 1);

      // Only include vars that are NEW or CHANGED compared to the pre-source snapshot,
      // AND that match an allowed prefix.
      if (
        ALLOWED_PREFIXES.some((p) => key.startsWith(p)) &&
        process.env[key] === diffAgainst[key]
      ) {
        newVars[key] = value;
      }
    }

    return newVars;
  } catch {
    return {};
  }
}

/**
 * Source all configured init files and merge allowed env vars into process.env.
 *
 * Called once at daemon startup (before any plugins are loaded) via
 * `bootstrapEnvSource` in config.ts after the config is validated.
 *
 * @param files - Paths to shell init files. Defaults to ["~/.bashrc"].
 */
export function applyEnvSource(files: string[] = ["~/.bashrc"]): void {
  for (const file of files) {
    // Snapshot before this file so its vars can override prior files' values.
    const before: Record<string, string | undefined> = { ...process.env };
    const vars = sourceEnvFile(file, before);
    for (const [key, value] of Object.entries(vars)) {
      process.env[key] = value;
    }
  }
}
