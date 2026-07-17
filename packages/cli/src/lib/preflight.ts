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
 * Narrow classification of `gh auth status` failure output, used only to
 * distinguish a GitHub API rate-limit response (GraphQL bucket exhausted)
 * from a genuine auth failure (no token / bad credentials). This is
 * deterministic parsing of a CLI's own error text for control flow, not
 * semantic judgment — the signatures come directly from gh's known error
 * strings and HTTP status codes.
 */
function isRateLimitError(output: string): boolean {
  const lower = output.toLowerCase();
  return (
    lower.includes("api rate limit") ||
    lower.includes("rate limit exceeded") ||
    lower.includes("http 403") ||
    lower.includes("http 429") ||
    /\b403\b/.test(lower) ||
    /\b429\b/.test(lower)
  );
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
 * `gh auth status` validates the token via a GraphQL call. When the
 * GraphQL rate-limit bucket is exhausted, `gh auth status` fails and
 * reports the token as invalid even though a real, valid token is
 * configured (see jleechan-ao-preflight-ratelimit-qcr9). In that case we
 * fall back to a local, API-free presence check instead of hard-failing
 * every spawn for the rate-limit window.
 */
async function checkGhAuth(): Promise<void> {
  try {
    await exec("gh", ["--version"]);
  } catch {
    throw new Error("GitHub CLI (gh) is not installed. Install it: https://cli.github.com/");
  }

  try {
    await exec("gh", ["auth", "status"]);
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string };
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;

    if (isRateLimitError(output)) {
      const token = await getConfiguredGhToken();
      if (token) {
        console.warn(
          "gh auth status is rate-limited (GitHub API bucket exhausted); proceeding with configured token.",
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
