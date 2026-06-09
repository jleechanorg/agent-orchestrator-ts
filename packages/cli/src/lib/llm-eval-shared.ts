import { buildVerdictLineRe } from "../commands/skeptic/verdict-utils.js";
import { loadConfig } from "@jleechanorg/ao-core";
import path from "node:path";

export const LLM_EVAL_TIMEOUT_MS = 300_000;
export const DEFAULT_CODEX_MODEL = process.env["AO_LLM_EVAL_CODEX_MODEL"] ?? "gpt-5.5";
export const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/anthropic";

/** Known claude binary locations, tried in order. */
export const CLAUDE_BINARY_CANDIDATES = [
  process.env["CLAUDE_BINARY"] ?? "",
  // nvm-style user-local (preferred — headless-compatible CLI)
  process.env["HOME"] ? `${process.env["HOME"]}/.local/bin/claude` : "",
  // Homebrew / user-local
  "/usr/local/bin/claude",
  "/opt/homebrew/bin/claude",
  // Claude Code standalone (macOS)
  "/Applications/Claude Code.app/Contents/Resources/bin/claude",
  // cmux release app (macOS) — GUI app, may ETIMEDOUT in launchd context
  "/Applications/cmux.app/Contents/Resources/bin/claude",
  // cmux DEV app (macOS) — GUI app, typically ETIMEDOUT in headless context
  "/Applications/cmux DEV.app/Contents/Resources/bin/claude",
  // PATH lookup (last resort — may not be available in launchd env)
  "claude",
].filter(Boolean);

/** Strict VERDICT matcher for tool output validation — PASS or FAIL only.
 * SKIPPED was the old infra-unavailable sentinel; it has been replaced by
 * VERDICT: FAIL (fail-closed). This regex intentionally rejects SKIPPED —
 * infra failures must block merges. */
export const STRICT_VERDICT_RE = buildVerdictLineRe(["PASS", "FAIL"]);

export interface LlmEvalResult {
  /** Whether a valid VERDICT line was obtained from the tool.
   *  false + error=undefined: tool unavailable (not installed / no credentials) — caller should try next.
   *  false + error=string: tool ran but produced no VERDICT — fail-closed.
   *  true: valid VERDICT obtained. */
  validVerdict: boolean;
  output: string;
  /** Set when the tool ran but produced non-VERDICT output, or when it errored fatally.
   *  Undefined means "tool unavailable — try next". */
  error?: string;
}

/** Errors that mean the tool is unavailable and the caller should try the next one. */
export function isUnavailable(errMsg: string, errCode?: string): boolean {
  // ENOENT = binary not installed
  // ETIMEDOUT = network/connection timeout — infrastructure unavailable, try next
  // 401/403 = credentials missing or invalid — treat as "unavailable" so fallback chain continues
  // Use word-boundary-aware regex to avoid false positives on strings like "took 4030ms"
  const lower = errMsg.toLowerCase();
  return (
    lower.includes("enoent") ||
    errCode === "ETIMEDOUT" ||
    // \b matches word boundary — so "401 " matches but "4012" does not
    /\b401\b/i.test(errMsg) ||
    /\b403\b/i.test(errMsg) ||
    /\b429\b/i.test(errMsg) ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("quota") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("resource_exhausted") ||
    lower.includes("insufficient_quota")
  );
}

/** True when msg indicates an auth failure that is global to all binaries. */
export function isAuthError(msg: string): boolean {
  return (
    /\b401\b/i.test(msg) ||
    /\b403\b/i.test(msg) ||
    msg.toLowerCase().includes("unauthorized") ||
    msg.toLowerCase().includes("forbidden")
  );
}

/** Shared exec options — avoids duplication across initial attempt and 429 retry. */
export function makeClaudeExecOptions(
  prompt: string,
): {
  input: string;
  encoding: "utf-8";
  timeout: number;
  maxBuffer: number;
  stdio: ["pipe", "pipe", "ignore"];
  cwd: string;
  env: Record<string, string | undefined>;
} {
  const env = { ...process.env };
  delete env.MINIMAX_API_KEY;

  /** Provider gateway agents that legitimately need ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN
   *  to route requests through their own proxy endpoints. This is an explicit opt-in whitelist;
   *  any agent not in this set will have those vars stripped unless useShellEnv is set. */
  const PROVIDER_AGENT_PLUGINS = new Set(["wafer", "minimax", "agy"]);

  let shouldKeepEnv = false;
  let reason = "";
  let activeAgent: string | undefined;
  let useShellEnv = false;

  try {
    const config = loadConfig();
    activeAgent = config.defaults?.agent;

    const cwd = process.cwd();
    if (config.projects && config.configPath) {
      const configDir = path.dirname(config.configPath);
      for (const proj of Object.values(config.projects)) {
        if (proj.agent && proj.path) {
          const resolvedProjPath = path.resolve(configDir, proj.path);
          if (cwd === resolvedProjPath || cwd.startsWith(resolvedProjPath + path.sep)) {
            activeAgent = proj.agent;
            break;
          }
        }
      }
    }

    const claudePluginConfig = config.plugins?.["claude-code"];
    if (claudePluginConfig && typeof claudePluginConfig === "object" && "useShellEnv" in claudePluginConfig) {
      useShellEnv = !!claudePluginConfig.useShellEnv;
    }
  } catch {
    // Config not found or invalid
  }

  if (useShellEnv) {
    shouldKeepEnv = true;
    reason = "useShellEnv flag is enabled in claude-code plugin config";
  } else if (activeAgent && PROVIDER_AGENT_PLUGINS.has(activeAgent)) {
    shouldKeepEnv = true;
    reason = `active agent is provider plugin "${activeAgent}"`;
  }

  const hasBaseUrl = process.env.ANTHROPIC_BASE_URL !== undefined;
  const hasAuthToken = process.env.ANTHROPIC_AUTH_TOKEN !== undefined;

  if (hasBaseUrl || hasAuthToken) {
    if (shouldKeepEnv) {
      if (hasBaseUrl) {
        console.debug(`[llm-eval-shared] Reading ANTHROPIC_BASE_URL from process.env (Reason: ${reason})`);
      }
      if (hasAuthToken) {
        console.debug(`[llm-eval-shared] Reading ANTHROPIC_AUTH_TOKEN from process.env (Reason: ${reason})`);
      }
    } else {
      delete env.ANTHROPIC_BASE_URL;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }
  }

  return {
    input: prompt,
    encoding: "utf-8",
    timeout: LLM_EVAL_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["pipe", "pipe", "ignore"],
    cwd: "/tmp",
    env,
  };
}

/**
 * Shared helper to execute the Claude CLI binary with 429 retry logic.
 * Avoids duplication of retry loops between Claude and MiniMax providers.
 */
export async function execClaudeBinaryWithRetry(
  candidate: string,
  prompt: string,
  envOverrides?: Record<string, string | undefined>,
): Promise<string> {
  const { execFileSync } = await import("node:child_process");
  const baseOptions = makeClaudeExecOptions(prompt);
  const options = {
    ...baseOptions,
    env: {
      ...baseOptions.env,
      ...envOverrides,
    },
  };

  try {
    const result = execFileSync(
      candidate,
      ["--bare", "--dangerously-skip-permissions", "--print"],
      options,
    );
    return result.trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      /\b429\b/i.test(msg) ||
      msg.toLowerCase().includes("rate_limit") ||
      msg.toLowerCase().includes("rate limit")
    ) {
      await new Promise((r) => setTimeout(r, 2000));
      const result = execFileSync(
        candidate,
        ["--bare", "--dangerously-skip-permissions", "--print"],
        options,
      );
      return result.trim();
    }
    throw err;
  }
}

