import { Command } from "commander";
import { registerInit } from "./commands/init.js";
import { registerStatus } from "./commands/status.js";
import { registerSpawn, registerBatchSpawn } from "./commands/spawn.js";
import { registerSession } from "./commands/session.js";
import { registerSend } from "./commands/send.js";
import { registerAcknowledge, registerReport } from "./commands/report.js";
import { registerReviewCheck } from "./commands/review-check.js";
import { registerDashboard } from "./commands/dashboard.js";
import { registerOpen } from "./commands/open.js";
import { registerStart, registerStop } from "./commands/start.js";
import { registerLifecycleWorker } from "./commands/lifecycle-worker.js";
import { registerVerify } from "./commands/verify.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerUpdate } from "./commands/update.js";
import { registerSetup } from "./commands/setup.js";
import { registerPlugin } from "./commands/plugin.js";
import { registerProjectCommand } from "./commands/project.js";
import { registerMigrateStorage } from "./commands/migrate-storage.js";
import { registerCompletion } from "./commands/completion.js";
import { registerEvents } from "./commands/events.js";
import { registerConfig } from "./commands/config.js";
import { registerSkeptic } from "./commands/skeptic.js";
import { registerSkepticInstall } from "./commands/skeptic/install.js";
import { getConfigInstruction } from "./lib/config-instruction.js";
import { getCliVersion } from "./options/version.js";
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
    .version(getCliVersion());

  registerInit(program);
  registerStart(program);
  registerStop(program);
  registerStatus(program);
  registerSpawn(program);
  registerBatchSpawn(program);
  registerSession(program);
  registerSend(program);
  registerAcknowledge(program);
  registerReport(program);
  registerReviewCheck(program);
  registerDashboard(program);
  registerOpen(program);
  registerLifecycleWorker(program);
  registerVerify(program);
  registerDoctor(program);
  registerUpdate(program);
  registerSetup(program);
  registerPlugin(program);
  registerProjectCommand(program);
  registerMigrateStorage(program);
  registerCompletion(program);
  registerEvents(program);
  registerConfig(program);
  const skepticCmd = registerSkeptic(program);
  registerSkepticInstall(skepticCmd);
  type CmdProgram = Parameters<typeof registerAutonomousHarness>[0];
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument,@typescript-eslint/no-explicit-any
  registerAutonomousHarness(program as CmdProgram);

  program
    .command("config-help")
    .description("Show config schema and guide for creating agent-orchestrator.yaml")
    .action(() => {
      console.log(getConfigInstruction());
    });

  return program;
}
