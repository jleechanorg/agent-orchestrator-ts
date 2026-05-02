/**
 * Autonomous Harness CLI — `ao autonomous-harness`
 *
 * GAN-style generator/evaluator loop with file-based handoffs.
 * Usage:
 *   ao autonomous-harness --project-id agent-orchestrator --project-path /tmp/mctrl_test --project-name mctrl_test --sprints 1
 */

/** Minimal commander-like interface compatible with both v12 and v13 */
interface CommanderLike {
  command(name?: string): CommanderLike;
  description(text?: string): CommanderLike;
  requiredOption(name: string, ...args: unknown[]): CommanderLike;
  option(name: string, ...args: unknown[]): CommanderLike;
  action(handler: (...args: unknown[]) => unknown): CommanderLike;
  opts<T>(): T;
}
import { runAutonomousHarness, type RunOptions } from "./orchestrator.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

interface AutonomousHarnessOptions {
  projectPath: string;
  projectName: string;
  projectId: string;
  sprints: string;
  generatorModel: string;
  evaluatorModel: string;
  orchestratorModel: string;
  skillRoot?: string;
  maxIterationsPerPhase: string;
}

export function registerAutonomousHarness(program: CommanderLike): void {
  const cmd = program
    .command("autonomous-harness")
    .description("Run autonomous GAN-style generator/evaluator loop with file-based handoffs")
    .requiredOption("--project-id <id>", "AO project ID (must match an entry in agent-orchestrator.yaml)")
    .requiredOption("--project-path <path>", "Path to the target project workspace")
    .requiredOption("--project-name <name>", "Human-readable project name")
    .option("--sprints <n>", "Number of sprints", "1")
    .option("--generator-model <model>", "Model for generator phases", "minimax/MiniMax-M2.7")
    .option("--evaluator-model <model>", "Model for evaluator phases", "minimax/MiniMax-M2.7")
    .option("--orchestrator-model <model>", "Model for orchestrator (evaluation/annotation phases)", "minimax/MiniMax-M2.7")
    .option("--skill-root <path>", "Path to skills directory (for skill prompts)")
    .option("--max-iterations-per-phase <n>", "Max poll iterations per phase", "10");

  cmd.action(async () => {
    const opts = cmd.opts<AutonomousHarnessOptions>();
    const projectPath = resolve(opts.projectPath);

    if (!existsSync(projectPath)) {
      console.error(`[autonomous-harness] Project path does not exist: ${projectPath}`);
      process.exit(1);
    }

    const sprints = parseInt(opts.sprints, 10);
    if (!Number.isInteger(sprints) || sprints <= 0) {
      console.error(`[autonomous-harness] Error: --sprints must be a positive integer, got: ${opts.sprints}`);
      process.exit(1);
    }

    const maxIterations = parseInt(opts.maxIterationsPerPhase, 10);
    if (!Number.isInteger(maxIterations) || maxIterations <= 0) {
      console.error(`[autonomous-harness] Error: --max-iterations-per-phase must be a positive integer, got: ${opts.maxIterationsPerPhase}`);
      process.exit(1);
    }

    const runOpts: RunOptions = {
      projectId: opts.projectId,
      projectPath,
      projectName: opts.projectName,
      totalSprints: sprints,
      generatorModel: opts.generatorModel,
      evaluatorModel: opts.evaluatorModel,
      orchestratorModel: opts.orchestratorModel,
      skillRoot: opts.skillRoot,
      maxIterationsPerPhase: maxIterations,
    };

    console.log(`[autonomous-harness] Starting harness for ${opts.projectName} (id=${opts.projectId}) at ${projectPath}`);
    const finalState = await runAutonomousHarness(runOpts);
    console.log(`[autonomous-harness] Complete. ${finalState.completedSprints.length}/${finalState.totalSprints} sprints passed.`);
  });
}