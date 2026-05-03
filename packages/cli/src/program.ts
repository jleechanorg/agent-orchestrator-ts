import { Command } from "commander";
import { registerInit } from "./commands/init.js";
import { registerStatus } from "./commands/status.js";
import { registerSpawn, registerBatchSpawn } from "./commands/spawn.js";
import { registerSession } from "./commands/session.js";
import { registerSend } from "./commands/send.js";
import { registerReviewCheck } from "./commands/review-check.js";
import { registerDashboard } from "./commands/dashboard.js";
import { registerOpen } from "./commands/open.js";
import { registerStart, registerStop } from "./commands/start.js";
import { registerLifecycleWorker } from "./commands/lifecycle-worker.js";
import { registerVerify } from "./commands/verify.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerUpdate } from "./commands/update.js";
import { registerSkeptic } from "./commands/skeptic.js";
import { registerSkepticInstall } from "./commands/skeptic/install.js";
import { getConfigInstruction } from "./lib/config-instruction.js";
import { registerAutonomousHarness } from "@jleechanorg/ao-autonomous-harness";

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("ao")
    .description(
      [
        "Agent Orchestrator — manage parallel AI coding agents",
        "",
        "Quick workflows:",
        "  ao start",
        "  ao start ~/path/to/repo",
        "  ao start https://github.com/owner/repo",
        '  ao spawn "fix the flaky retry path"',
        "  ao spawn -p my-project bd-1234",
        "  ao spawn --project my-project --claim-pr 456",
        "  ao status",
        "  ao session ls",
        "",
        "Repo-local AO usage skill:",
        "  skills/agent-orchestrator/SKILL.md",
        "  Installed by: bash scripts/setup.sh",
      ].join("\n"),
    )
    .version("0.1.0");

  registerInit(program);
  registerStart(program);
  registerStop(program);
  registerStatus(program);
  registerSpawn(program);
  registerBatchSpawn(program);
  registerSession(program);
  registerSend(program);
  registerReviewCheck(program);
  registerDashboard(program);
  registerOpen(program);
  registerLifecycleWorker(program);
  registerVerify(program);
  registerDoctor(program);
  registerUpdate(program);
  const skepticCmd = registerSkeptic(program);
  registerSkepticInstall(skepticCmd);
  // Commander v12 vs v13 has incompatible opts<T>() return type variance.
  // The runtime behavior is identical — use the same interface the function declares.
  type CmdProgram = Parameters<typeof registerAutonomousHarness>[0];
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument,@typescript-eslint/no-explicit-any -- intentionally bridging commander type variance
  registerAutonomousHarness(program as CmdProgram);

  program
    .command("config-help")
    .description("Show config schema and guide for creating agent-orchestrator.yaml")
    .action(() => {
      console.log(getConfigInstruction());
    });

  return program;
}
