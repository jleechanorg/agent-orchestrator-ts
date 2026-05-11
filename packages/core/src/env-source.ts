/**
 * env-source — source shell init files and merge new env vars into process.env.
 *
 * The AO daemon does NOT inherit from ~/.bashrc when it starts (it is not a login
 * shell). This module lets the config specify init files to source at startup so that
 * env vars (API keys, feature flags, etc.) are available to plugins via process.env
 * without duplicating secrets into YAML config or .env files.
 *
 * All new/changed vars are merged except those in the blocklist below, which
 * prevents daemon-breakers (PATH, HOME) and security risks (LD_PRELOAD, NODE_OPTIONS).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { expandHome } from "./paths.js";

/** Vars that would break the daemon or duplicate launchd-provided values. */
const BLOCKED_VARS: ReadonlySet<string> = new Set([
  "PATH", "HOME", "PS1", "PWD", "OLDPWD", "SHELL", "USER",
]);

/** Singleton vars that would break the daemon or duplicate launchd-provided values. */
const BLOCKED_VARS: ReadonlySet<string> = new Set([
  "PATH", "HOME", "PS1", "PWD", "OLDPWD", "SHELL", "USER",
  "NODE_OPTIONS", // Can inject --require, --eval, etc.
]);

function isBlocked(key: string): boolean {
  if (BLOCKED_VARS.has(key)) return true;
  return BLOCKED_PREFIXES.some((p) => key.startsWith(p));
}

/** Snapshot of process.env at import time — used to compute the diff. */
const ENV_BEFORE: Record<string, string | undefined> = { ...process.env };

/**
 * Source a single shell init file and return any NEW env vars it defines
 * that match allowed prefixes.
 *
 * Shell dotfiles (e.g. ~/.bashrc): runs `bash -c 'source <file>; env'` and diffs
 * the output against the env snapshot taken before sourcing. Only vars that appeared
 * (or changed) after sourcing are returned.
 *
 * /etc/environment: parsed directly as plain KEY=VALUE (no shell, no export required)
 * because that file does not support shell syntax and most entries lack `export`.
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
    // /etc/environment: plain KEY=VALUE file — parse directly without bash sourcing.
    // Unlike shell dotfiles, it does not support `export` or shell syntax,
    // so vars appear in `env` output only if they were exported first.
    if (expanded === "/etc/environment") {
      const content = readFileSync(expanded, "utf-8");
      const newVars: Record<string, string> = {};
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) continue;
        const key = trimmed.slice(0, eqIndex);
        const value = trimmed.slice(eqIndex + 1);
        if (
          !isBlocked(key) &&
          process.env[key] === diffAgainst[key]
        ) {
          newVars[key] = value;
        }
      }
      return newVars;
    }

    // Shell dotfiles: source through bash, capture env output, diff against snapshot.
    // Use execFileSync to avoid shell injection — no shell interpolation.
    // Use `;` not `&&` so `env` runs even if sourced file exits non-zero
    // (e.g. bashrc with `set -e` or a failing command at the end).
    // Use `-i --noprofile` (interactive, no implicit profile sourcing) so:
    //   (a) `[[ $- != *i* ]] && return` guards in common .bashrc don't skip exports,
    //   (b) bash does NOT implicitly source ~/.bashrc before the explicit source,
    //       preventing implicit startup-file leakage into the configured file's output.
    // Use `--norc` for the same reason — don't let bash's own rc file run first.
    const output = execFileSync(
      "bash",
      ["--noprofile", "--norc", "-i", "-c", `source "$1" > /dev/null 2>&1; env`, "--", expanded],
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

      // Skip blocklisted vars (PATH, HOME, LD_*, etc.) and vars already
      // overwritten between module load and this sourcing call.
      if (
        !isBlocked(key) &&
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
