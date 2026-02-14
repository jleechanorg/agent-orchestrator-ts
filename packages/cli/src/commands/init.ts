import { createInterface } from "node:readline/promises";
import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import chalk from "chalk";
import type { Command } from "commander";

async function prompt(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultValue?: string,
): Promise<string> {
  const suffix = defaultValue ? ` ${chalk.dim(`(${defaultValue})`)}` : "";
  const answer = await rl.question(`${question}${suffix}: `);
  return answer.trim() || defaultValue || "";
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Interactive setup wizard — creates agent-orchestrator.yaml")
    .option("-o, --output <path>", "Output file path", "agent-orchestrator.yaml")
    .action(async (opts: { output: string }) => {
      const outputPath = resolve(opts.output);

      if (existsSync(outputPath)) {
        console.log(chalk.yellow(`Config already exists: ${outputPath}`));
        console.log("Delete it first or specify a different path with --output.");
        process.exit(1);
      }

      console.log(chalk.bold.cyan("\n  Agent Orchestrator — Setup Wizard\n"));

      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        const dataDir = await prompt(
          rl,
          "Data directory (session metadata)",
          "~/.agent-orchestrator",
        );
        const worktreeDir = await prompt(rl, "Worktree directory", "~/.worktrees");
        const portStr = await prompt(rl, "Dashboard port", "3000");
        const port = parseInt(portStr, 10);
        if (isNaN(port) || port < 1 || port > 65535) {
          console.error(chalk.red("Invalid port number. Must be 1-65535."));
          rl.close();
          process.exit(1);
        }

        // Default plugins
        console.log(chalk.bold("\n  Default Plugins\n"));
        const runtime = await prompt(rl, "Runtime (tmux, process)", "tmux");
        const agent = await prompt(rl, "Agent (claude-code, codex, aider)", "claude-code");
        const workspace = await prompt(rl, "Workspace (worktree, clone)", "worktree");
        const notifiersStr = await prompt(
          rl,
          "Notifiers (comma-separated: desktop, slack, webhook)",
          "desktop",
        );
        const notifiers = notifiersStr.split(",").map((s) => s.trim());

        // First project
        console.log(chalk.bold("\n  First Project\n"));
        const projectId = await prompt(rl, "Project ID (short name, e.g. my-app)", "");

        const config: Record<string, unknown> = {
          dataDir,
          worktreeDir,
          port,
          defaults: { runtime, agent, workspace, notifiers },
          projects: {} as Record<string, unknown>,
        };

        if (projectId) {
          const repo = await prompt(rl, "GitHub repo (owner/repo)", "");
          const path = await prompt(rl, "Local path to repo", `~/${projectId}`);
          const defaultBranch = await prompt(rl, "Default branch", "main");

          (config.projects as Record<string, unknown>)[projectId] = {
            repo,
            path,
            defaultBranch,
          };
        }

        const yamlContent = yamlStringify(config, { indent: 2 });
        writeFileSync(outputPath, yamlContent);

        console.log(chalk.green(`\nConfig written to ${outputPath}`));
        console.log(chalk.dim("Edit the file to add more projects or customize reactions.\n"));
      } finally {
        rl.close();
      }
    });
}
