import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type ManagedConfigEnvironment = "staging" | "production";

const CONFIG_FILENAME = "agent-orchestrator.yaml";

function getPathOverride(envName: string): string | null {
  const value = process.env[envName];
  if (!value || value.trim().length === 0) {
    return null;
  }
  return resolve(value);
}

export function getManagedConfigPath(env: ManagedConfigEnvironment = "staging"): string {
  if (env === "staging") {
    return (
      getPathOverride("AO_STAGING_CONFIG_PATH") ??
      getPathOverride("AO_CONFIG_STAGING_PATH") ??
      resolve(homedir(), ".openclaw", CONFIG_FILENAME)
    );
  }

  // Search order: explicit env override → HERMES_HOME → .hermes_prod → .openclaw_prod (legacy).
  // Use existsSync so we actually discover files rather than just returning strings.
  const hermesHomePath =
    process.env.HERMES_HOME && existsSync(resolve(process.env.HERMES_HOME, CONFIG_FILENAME))
      ? resolve(process.env.HERMES_HOME, CONFIG_FILENAME)
      : null;
  const hermesProdPath = existsSync(resolve(homedir(), ".hermes_prod", CONFIG_FILENAME))
    ? resolve(homedir(), ".hermes_prod", CONFIG_FILENAME)
    : null;
  const openclawProdPath = existsSync(resolve(homedir(), ".openclaw_prod", CONFIG_FILENAME))
    ? resolve(homedir(), ".openclaw_prod", CONFIG_FILENAME)
    : null;

  return (
    getPathOverride("AO_PROD_CONFIG_PATH") ??
    getPathOverride("AO_PRODUCTION_CONFIG_PATH") ??
    hermesHomePath ??
    hermesProdPath ??
    openclawProdPath ??
    // Default: use .hermes_prod as the default production path when nothing exists yet.
    resolve(homedir(), ".hermes_prod", CONFIG_FILENAME)
  );
}

export function getLegacyConfigPaths(): string[] {
  return [
    resolve(homedir(), ".agent-orchestrator.yaml"),
    resolve(homedir(), ".agent-orchestrator.yml"),
    resolve(homedir(), ".config", "agent-orchestrator", "config.yaml"),
  ];
}

export function getPreferredConfigSearchPaths(): string[] {
  return [
    getManagedConfigPath("staging"),
    getManagedConfigPath("production"),
  ];
}

export function findManagedConfigFile(): string | null {
  for (const candidate of getPreferredConfigSearchPaths()) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export type ManagedConfigTopologyIssue =
  | "staging_missing"
  | "production_missing"
  | "staging_prod_same_target"
  | "staging_symlinked"
  | "production_symlinked";

export interface ManagedConfigTopologyProblem {
  issue: ManagedConfigTopologyIssue;
  path: string;
  detail: string;
}

export function validateManagedConfigTopology(options?: {
  requireStaging?: boolean;
  requireProduction?: boolean;
}): ManagedConfigTopologyProblem[] {
  const problems: ManagedConfigTopologyProblem[] = [];
  const stagingPath = getManagedConfigPath("staging");
  const productionPath = getManagedConfigPath("production");

  if (options?.requireStaging && !existsSync(stagingPath)) {
    problems.push({
      issue: "staging_missing",
      path: stagingPath,
      detail: "Staging config is missing.",
    });
  }

  if (options?.requireProduction && !existsSync(productionPath)) {
    problems.push({
      issue: "production_missing",
      path: productionPath,
      detail: "Production config is missing.",
    });
  }

  try {
    if (lstatSync(stagingPath).isSymbolicLink()) {
      problems.push({
        issue: "staging_symlinked",
        path: stagingPath,
        detail: "Staging config must be a real file, not a symlink.",
      });
    }
  } catch {
    // Staging path does not exist — skip symlink check
  }

  try {
    if (lstatSync(productionPath).isSymbolicLink()) {
      problems.push({
        issue: "production_symlinked",
        path: productionPath,
        detail: "Production config must be a real file, not a symlink.",
      });
    }
  } catch {
    // Production path does not exist — skip symlink check
  }

  if (existsSync(stagingPath) && existsSync(productionPath)) {
    const stagingReal = realpathSync(stagingPath);
    const productionReal = realpathSync(productionPath);
    if (stagingReal === productionReal) {
      problems.push({
        issue: "staging_prod_same_target",
        path: stagingPath,
        detail: `Staging and production resolve to the same file (${stagingReal}).`,
      });
    }
  }

  return problems;
}
