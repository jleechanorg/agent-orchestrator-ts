import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// When installed via npm the dist lives at <pkg-root>/dist/lib/; when running
// from a git checkout it lives at packages/cli/dist/lib/.  Walk up until we
// find a directory that contains a "scripts" folder, falling back to 4 levels.
function findRepoRoot(): string {
  const distLib = dirname(fileURLToPath(import.meta.url));
  for (let levels = 2; levels <= 5; levels++) {
    const candidate = resolve(distLib, "../".repeat(levels));
    if (existsSync(resolve(candidate, "scripts"))) return candidate;
  }
  return resolve(distLib, "../../../../");
}
const DEFAULT_REPO_ROOT = findRepoRoot();

export function resolveRepoRoot(): string {
  const override = process.env["AO_REPO_ROOT"];
  return override ? resolve(override) : DEFAULT_REPO_ROOT;
}

export function resolveScriptPath(scriptName: string): string {
  const scriptPath = resolve(resolveRepoRoot(), "scripts", scriptName);
  if (!existsSync(scriptPath)) {
    throw new Error(`Script not found: ${scriptPath}`);
  }
  return scriptPath;
}

export async function runRepoScript(scriptName: string, args: string[]): Promise<number> {
  const shell = process.env["AO_BASH_PATH"] || "bash";
  const scriptPath = resolveScriptPath(scriptName);

  return await new Promise<number>((resolveExit, reject) => {
    const child = spawn(shell, [scriptPath, ...args], {
      cwd: resolveRepoRoot(),
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        resolveExit(1);
        return;
      }

      resolveExit(code ?? 1);
    });
  });
}

export async function executeScriptCommand(scriptName: string, args: string[]): Promise<void> {
  try {
    const exitCode = await runRepoScript(scriptName, args);
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
