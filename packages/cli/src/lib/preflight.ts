/**
 * Pre-flight checks for `ao start` and `ao spawn`.
 *
 * Validates runtime prerequisites before entering the main command flow,
 * giving clear errors instead of cryptic failures.
 *
 * All checks throw on failure so callers can catch and handle uniformly.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isPortAvailable } from "./web-dir.js";
import { exec } from "./shell.js";

/**
 * Check that the dashboard port is free.
 * Throws if the port is already in use.
 */
async function checkPort(port: number): Promise<void> {
  const free = await isPortAvailable(port);
  if (!free) {
    throw new Error(
      `Port ${port} is already in use. Free it or change 'port' in agent-orchestrator.yaml.`,
    );
  }
}

/**
 * Check that workspace packages have been compiled (TypeScript → JavaScript).
 * Verifies @jleechanorg/ao-core dist output exists from the web package's
 * node_modules, since a missing dist/ causes module resolution errors when
 * starting the dashboard. Works with both `next dev` and `next build`.
 */
async function checkBuilt(webDir: string): Promise<void> {
  const nodeModules = resolve(webDir, "node_modules", "@jleechanorg", "ao-core");
  if (!existsSync(nodeModules)) {
    throw new Error("Dependencies not installed. Run: pnpm install && pnpm build");
  }
  const coreEntry = resolve(nodeModules, "dist", "index.js");
  if (!existsSync(coreEntry)) {
    throw new Error("Packages not built. Run: pnpm build");
  }
}

/**
 * Check that tmux is installed (required for the default runtime).
 * Throws if not installed.
 */
async function checkTmux(): Promise<void> {
  try {
    await exec("tmux", ["-V"]);
  } catch {
    throw new Error("tmux is not installed. Install it: brew install tmux");
  }
}

/**
 * Narrow classification of a `gh` failure's output, used only to distinguish
 * a GitHub API rate-limit response from a genuine auth failure (no token /
 * bad credentials, missing scopes, org/SSO policy block). This is
 * deterministic parsing of a CLI's own error text for control flow, not
 * semantic judgment — the signatures come directly from gh's known error
 * strings and HTTP status codes.
 *
 * A bare "403" is NOT sufficient evidence of rate limiting: GitHub returns
 * 403 for missing token scopes and org/SSO policy blocks too, and those are
 * genuine auth failures that must still throw, not warn-and-proceed (see PR
 * #771 review — chatgpt-codex-connector P2). 403 only counts when paired
 * with explicit rate-limit text. 429 ("Too Many Requests") is unambiguous on
 * its own and may match bare.
 */
function isRateLimitError(output: string): boolean {
  const lower = output.toLowerCase();
  const hasRateLimitText = lower.includes("rate limit") || lower.includes("too many requests");
  const hasStatus429 = lower.includes("http 429") || /\b429\b/.test(lower);
  return hasRateLimitText || hasStatus429;
}

/**
 * Returns a configured GitHub token, if any, without making an API call.
 * Env vars are checked first since `gh` itself prioritizes them; `gh auth
 * token` reads local credential storage and is a local op (no network/API
 * call), so it stays reliable even when the API rate limit is exhausted.
 */
async function getConfiguredGhToken(): Promise<string | null> {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const { stdout } = await exec("gh", ["auth", "token"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check that the GitHub CLI is installed and authenticated.
 * Distinguishes between "not installed" and "not authenticated"
 * so the user gets the right troubleshooting guidance.
 *
 * The primary probe is `gh api user` — a single cheap REST call that tests
 * the thing we actually need (can this environment make authenticated API
 * calls) rather than `gh`'s own opinion of the token. `gh auth status`
 * validates via GraphQL and has proven unreliable for this purpose in two
 * ways (see jleechan-ao-preflight-ratelimit-qcr9): it fails with rate-limit
 * text when the GraphQL bucket is exhausted even though the token is valid,
 * and — reproduced live against the daemon's actual token — it can report
 * "token is invalid" outright while `gh api user` succeeds with the same
 * token. So `gh auth status` is no longer consulted at all: if `gh api
 * user` succeeds, preflight passes immediately; only on failure do we
 * classify the failure text (rate-limit vs genuine) and fall back to a
 * local, API-free token-presence check instead of hard-failing every spawn.
 */
async function checkGhAuth(): Promise<void> {
  try {
    await exec("gh", ["--version"]);
  } catch {
    throw new Error("GitHub CLI (gh) is not installed. Install it: https://cli.github.com/");
  }

  try {
    await exec("gh", ["api", "user"]);
    return;
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string };
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;

    if (isRateLimitError(output)) {
      const token = await getConfiguredGhToken();
      if (token) {
        console.warn(
          "gh api user is rate-limited (GitHub API bucket exhausted); proceeding with configured token.",
        );
        return;
      }
    }

    throw new Error("GitHub CLI is not authenticated. Run: gh auth login", { cause: err });
  }
}

export const preflight = {
  checkPort,
  checkBuilt,
  checkTmux,
  checkGhAuth,
};
