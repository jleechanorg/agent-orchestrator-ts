/**
 * Skeptic CI Installer — bd-8tpa
 *
 * CLI: ao skeptic install [--gate] [--cron]
 *
 * Copies skeptic-gate.yml and/or skeptic-cron.yml into the target repo's
 * .github/workflows/ directory.
 *
 * - Auto-detects repo owner/name from `gh repo view` (git remote fallback)
 * - Copies files locally only — user commits/pushes to activate workflows
 * - Configures which gates to install via --gate / --cron flags
 * - Templates use ${{ github.repository }} at runtime — no injection needed
 */

import chalk from "chalk";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { exec } from "../../lib/shell.js";

// Template directory — resolved relative to this file's location
// Templates live in src/templates/skeptic/ so TypeScript (rootDir=src) copies them to dist/templates/skeptic/
const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates", "skeptic");

interface RepoInfo {
  owner: string;
  name: string;
}

/**
 * Detect the current repo from `gh repo view`, falling back to git remote parsing.
 * @param execFn Optional override for the exec function (used for testing).
 */
export async function detectRepo(execFn = exec): Promise<RepoInfo> {
  try {
    const result = await execFn("gh", ["repo", "view", "--json", "owner,name"]);
    const data = JSON.parse(result.stdout) as { owner: { login: string }; name: string };
    return { owner: data.owner.login, name: data.name };
  } catch {
    // Fallback: parse git remote
    try {
      const remoteResult = await execFn("git", ["remote", "get-url", "origin"]);
      const url = remoteResult.stdout.trim();
      // Supports: https://github.com/owner/repo.git  or  git@github.com:owner/repo.git
      // Capture full owner+name, then strip optional trailing .git
      const httpsMatch = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
      if (httpsMatch) {
        const parts = httpsMatch[1]!.split("/");
        if (parts.length !== 2) {
          // Re-throw so it propagates to the outer throw, not swallowed by inner catch
          throw new Error(`Could not parse owner/repo from git remote: ${url}`);
        }
        return { owner: parts[0]!, name: parts[1]! };
      }
      throw new Error("Git remote does not appear to be a GitHub URL");
    } catch (err) {
      // Only ignore exec errors; re-throw descriptive parse errors
      if (!(err instanceof Error) || !err.message.startsWith("Could not parse")) throw err;
    }
    throw new Error(
      "Could not detect repo. Run in a git repo with a configured remote, or use --repo owner/repo.",
    );
  }
}

/**
 * Ensure .github/workflows/ exists under the given root.
 */
function ensureWorkflowsDir(root: string): void {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Copy a template to the target repo's .github/workflows/ directory.
 */
function installWorkflow(
  root: string,
  filename: string,
  options: { force?: boolean } = {},
): "installed" | "skipped-exists" {
  const src = join(TEMPLATE_DIR, filename);
  const dst = join(root, ".github", "workflows", filename);

  if (existsSync(dst) && !options.force) {
    return "skipped-exists";
  }

  const content = readFileSync(src, "utf8");
  writeFileSync(dst, content, "utf8");
  return "installed";
}

/**
 * Verify the CLI is installed and buildable in the target repo.
 * Warns if pnpm/npm not found.
 */
async function checkBuildTools(_repo: RepoInfo): Promise<void> {
  const hasPnpm = await exec("pnpm", ["--version"]).then(() => true).catch(() => false);
  const hasNpm = await exec("npm", ["--version"]).then(() => true).catch(() => false);

  if (!hasPnpm && !hasNpm) {
    console.warn(
      chalk.yellow("⚠  Neither pnpm nor npm found — the skeptic workflows require Node.js tooling."),
    );
  } else if (!hasPnpm) {
    console.warn(
      chalk.yellow("⚠  pnpm not found — the skeptic workflows assume pnpm. Adjust build steps if using npm."),
    );
  }

  console.log(chalk.cyan("  ℹ  After committing, add secrets in GitHub repo Settings > Secrets:"));
  console.log(chalk.cyan("     • OPENAI_API_KEY   (Codex — required; Codex uses OAuth + API key)"));
  console.log(chalk.cyan("     • ANTHROPIC_API_KEY (Claude CLI — optional fallback)"));
}

export function registerSkepticInstall(skepticCmd: Command): void {
  skepticCmd
    .command("install")
    .description(
      "Install skeptic CI workflows into the current repo's .github/workflows/ (bd-8tpa)",
    )
    .option(
      "--gate",
      "Install skeptic-gate.yml (runs on every PR open/sync)",
      false,
    )
    .option(
      "--cron",
      "Install skeptic-cron.yml (runs every 30 min, auto-merges 7-green PRs)",
      false,
    )
    .option(
      "--all",
      "Install all available skeptic workflows (gate + cron)",
      false,
    )
    .option(
      "--force",
      "Overwrite existing workflow files if present",
      false,
    )
    .option(
      "--repo <owner/repo>",
      "Target repo (defaults to current repo detected via gh repo view / git remote)",
    )
    .action(async function (options) {
      const cmd = this as unknown as Command;
      const installGate = options.all || options.gate;
      const installCron = options.all || options.cron;

      if (!installGate && !installCron) {
        cmd.error(
          "Specify at least one workflow to install.\n" +
            "  Use --gate, --cron, or --all.\n" +
            "  Example: ao skeptic install --all",
        );
      }

      // Detect repo
      let repo: RepoInfo;
      if (options.repo) {
        const parts = String(options.repo).split("/");
        if (parts.length !== 2) {
          cmd.error("Repo must be in format: owner/repo");
        }
        repo = { owner: parts[0]!, name: parts[1]! };
      } else {
        repo = await detectRepo();
      }

      // Resolve the git repo root so we always write to .github/workflows/ in the
      // actual repo root, even if the user ran the command from a subdirectory.
      const { stdout: repoRoot } = await exec("git", ["rev-parse", "--show-toplevel"]);
      const root = repoRoot.trim();
      if (!root) {
        cmd.error("Not a git repository. Run from inside a git checkout.");
      }

      ensureWorkflowsDir(root);

      console.log(chalk.bold(`\n🔧 Installing skeptic CI in ${chalk.cyan(repo.owner + "/" + repo.name)}`));
      console.log(chalk.dim(`   Target: ${root}/.github/workflows/\n`));

      if (installGate) {
        const r = installWorkflow(root, "skeptic-gate.yml", { force: options.force });
        if (r === "installed") {
          console.log(chalk.green(`  ✅ skeptic-gate.yml installed`));
        } else {
          console.log(chalk.yellow(`  ⚠  skeptic-gate.yml already exists (use --force to overwrite)`));
        }
      }

      if (installCron) {
        const r = installWorkflow(root, "skeptic-cron.yml", { force: options.force });
        if (r === "installed") {
          console.log(chalk.green(`  ✅ skeptic-cron.yml installed`));
        } else {
          console.log(chalk.yellow(`  ⚠  skeptic-cron.yml already exists (use --force to overwrite)`));
        }
      }

      console.log();
      await checkBuildTools(repo);

      console.log(
        chalk.bold("\n📋 Next steps:") +
          "\n" +
          chalk.cyan("  1. Commit the new files:") +
          `\n     git add .github/workflows/skeptic-gate.yml .github/workflows/skeptic-cron.yml` +
          `\n     git commit -m "feat: add skeptic CI (gate+cron)"` +
          "\n" +
          chalk.cyan("  2. Push to activate workflows:") +
          "\n     git push" +
          "\n" +
          chalk.cyan("  3. Add this secret in GitHub > Settings > Secrets:") +
          "\n     • OPENAI_API_KEY   (Codex — required)" +
          "\n     (ANTHROPIC_API_KEY is optional — Claude CLI fallback if set)" +
          "\n" +
          chalk.green("  Done! Skeptic will run on your next PR.\n"),
      );
    });
}
