/**
 * Autonomous Harness CLI — `ao autonomous-harness`
 *
 * GAN-style generator/evaluator loop with file-based handoffs.
 * Usage:
 *   ao autonomous-harness --project-path /tmp/mctrl_test --project-name mctrl_test --sprints 1
 */

import { Command } from "commander";
import { runAutonomousHarness, type RunOptions } from "./orchestrator.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function registerAutonomousHarness(program: Command): void {
  const cmd = program
    .command("autonomous-harness")
    .description("Run autonomous GAN-style generator/evaluator loop with file-based handoffs")
    .requiredOption("--project-path <path>", "Path to the target project")
    .requiredOption("--project-name <name>", "Human-readable project name")
    .option("--sprints <n>", "Number of sprints", "1")
    .option("--generator-model <model>", "Model for generator phases", "minimax/MiniMax-M2.7")
    .option("--evaluator-model <model>", "Model for evaluator phases", "minimax/MiniMax-M2.7")
    .option("--skill-root <path>", "Path to skills directory (for skill prompts)");

  cmd.action(async () => {
    const opts = cmd.opts();
    const projectPath = resolve(opts.projectPath);

    if (!existsSync(projectPath)) {
      console.error(`[autonomous-harness] Project path does not exist: ${projectPath}`);
      process.exit(1);
    }

    const runOpts: RunOptions = {
      projectPath,
      projectName: opts.projectName,
      totalSprints: parseInt(opts.sprints, 10),
      generatorModel: opts.generatorModel,
      evaluatorModel: opts.evaluatorModel,
      skillRoot: opts.skillRoot,
    };

    console.log(`[autonomous-harness] Starting harness for ${opts.projectName} at ${projectPath}`);
    const finalState = await runAutonomousHarness(runOpts);
    console.log(`[autonomous-harness] Complete. ${finalState.completedSprints.length}/${finalState.totalSprints} sprints passed.`);
  });
}