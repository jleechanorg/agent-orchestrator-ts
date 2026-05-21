/**
 * area-lock plugin — Domain collision detection via merge_train domain_lock CLI.
 *
 * Wraps the `domain_lock` CLI (provided by the merge_train Python package)
 * to offer reserve/release/check operations as an AO plugin. This lets
 * the orchestrator detect when two workers would edit the same file domain.
 */

import { execFile, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { PluginModule } from "@jleechanorg/ao-core";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LockEntry {
  domain: string;
  pr_number: number;
  agent: string;
  branch: string;
  timestamp: string;
}

export interface CheckResult {
  status: "free" | "held";
  held_by: LockEntry[];
}

export interface AreaLockConfig {
  /** Path to the domain_lock CLI binary. Default: "domain_lock" */
  cliPath?: string;
  /** Path to file_domains.yaml. Default: "<projectRoot>/file_domains.yaml" */
  registryPath?: string;
  /** Working directory for CLI invocations. Default: projectRoot */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

function resolveCliPath(config: AreaLockConfig): string {
  return config.cliPath ?? "domain_lock";
}

function buildCliArgs(
  action: string,
  config: AreaLockConfig,
  extra: string[] = [],
): string[] {
  const args = [action];
  if (config.registryPath) {
    args.push("--registry", config.registryPath);
  }
  args.push(...extra);
  return args;
}

async function runCli(
  args: string[],
  cwd: string,
  cliPath: string,
): Promise<string> {
  const { stdout } = await execFileAsync(cliPath, args, {
    cwd,
    timeout: 30_000,
    encoding: "utf-8",
  });
  return stdout;
}

function parseCliJson<T>(action: string, stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    const snippet = stdout.trim().slice(0, 500);
    throw new Error(
      `domain_lock ${action} returned invalid JSON${snippet ? `: ${snippet}` : ""}`,
      { cause: error },
    );
  }
}

// ---------------------------------------------------------------------------
// AreaLock API
// ---------------------------------------------------------------------------

export interface AreaLock {
  reserve(prNumber: number, changedFiles: string[], agent: string, branch: string, runtimeProjectRoot?: string): Promise<LockEntry[]>;
  release(prNumber: number, runtimeProjectRoot?: string): Promise<LockEntry[]>;
  check(changedFiles: string[], runtimeProjectRoot?: string): Promise<CheckResult>;
}

function createAreaLock(projectRoot: string, config: AreaLockConfig = {}): AreaLock {
  const defaultCwd = config.cwd ?? projectRoot;
  const cliConfig: AreaLockConfig = {
    ...config,
    registryPath: config.registryPath ?? resolve(projectRoot, "file_domains.yaml"),
  };
  const cliPath = resolveCliPath(cliConfig);

  return {
    async reserve(prNumber: number, changedFiles: string[], agent: string, branch: string, runtimeProjectRoot?: string): Promise<LockEntry[]> {
      const cwd = runtimeProjectRoot ?? defaultCwd;
      const args = buildCliArgs("reserve", cliConfig, [
        "--pr", String(prNumber),
        "--agent", agent,
        "--branch", branch,
        "--files", ...changedFiles,
      ]);
      const stdout = await runCli(args, cwd, cliPath);
      return parseCliJson<LockEntry[]>("reserve", stdout);
    },

    async release(prNumber: number, runtimeProjectRoot?: string): Promise<LockEntry[]> {
      const cwd = runtimeProjectRoot ?? defaultCwd;
      const args = buildCliArgs("release", cliConfig, [
        "--pr", String(prNumber),
      ]);
      const stdout = await runCli(args, cwd, cliPath);
      return parseCliJson<LockEntry[]>("release", stdout);
    },

    async check(changedFiles: string[], runtimeProjectRoot?: string): Promise<CheckResult> {
      const cwd = runtimeProjectRoot ?? defaultCwd;
      const args = buildCliArgs("check", cliConfig, [
        "--files", ...changedFiles,
      ]);
      const stdout = await runCli(args, cwd, cliPath);
      return parseCliJson<CheckResult>("check", stdout);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module
// ---------------------------------------------------------------------------

export const manifest = {
  name: "area-lock",
  slot: "lock" as const,
  description: "Domain collision detection via merge_train domain_lock CLI",
  version: "0.1.0",
  displayName: "Area Lock",
};

const areaLockPlugin: PluginModule<AreaLock> = {
  manifest,
  create(config?: Record<string, unknown>): AreaLock {
    const projectRoot = (config?.projectRoot as string) ?? process.cwd();
    const lockConfig: AreaLockConfig = {
      cliPath: config?.cliPath as string | undefined,
      registryPath:
        (config?.registryPath as string | undefined) ??
        resolve(projectRoot, "file_domains.yaml"),
      cwd: config?.cwd as string | undefined,
    };
    return createAreaLock(projectRoot, lockConfig);
  },
  detect(): boolean {
    try {
      execFileSync("domain_lock", ["--help"], {
        stdio: "ignore",
        timeout: 5_000,
      });
      return true;
    } catch {
      return false;
    }
  },
};

export default areaLockPlugin;
