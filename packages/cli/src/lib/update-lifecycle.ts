import { spawn } from "node:child_process";
import chalk from "chalk";
import {
  loadConfig,
  findManagedConfigFile,
  isTerminalSession,
  recordActivityEvent,
  type Session,
} from "@jleechanorg/ao-core";
import { getSessionManager } from "./create-session-manager.js";
import { getRunning } from "./running-state.js";

export interface UpdateLifecyclePlan {
  runningBeforeUpdate: boolean;
  primaryProjectId?: string;
  activeSessions: Session[];
}

function isWindows(): boolean {
  return process.platform === "win32";
}

export async function getUpdateLifecyclePlan(): Promise<UpdateLifecyclePlan> {
  let sessions: Session[];
  let primaryProjectId: string | undefined;
  let runningBeforeUpdate = false;

  try {
    const running = await getRunning();
    if (running && running.projects.length > 0) {
      runningBeforeUpdate = true;
      primaryProjectId = running.projects[0];
      const config = loadConfig(running.configPath);
      primaryProjectId = Object.keys(config.projects)[0];
      const sm = await getSessionManager(config);
      sessions = await sm.list();
    } else {
      const globalPath = findManagedConfigFile();
      if (!globalPath) {
        return { runningBeforeUpdate, primaryProjectId, activeSessions: [] };
      }
      const config = loadConfig(globalPath);
      if (!config || Object.keys(config.projects).length === 0) {
        return { runningBeforeUpdate, primaryProjectId, activeSessions: [] };
      }
      primaryProjectId = Object.keys(config.projects)[0];
      const sm = await getSessionManager(config);
      sessions = await sm.list();
    }
  } catch {
    console.error(
      chalk.yellow("⚠ Could not check for active sessions before updating. Proceeding anyway."),
    );
    return { runningBeforeUpdate, primaryProjectId, activeSessions: [] };
  }

  const active = sessions.filter((s) => !isTerminalSession(s));
  return { runningBeforeUpdate, primaryProjectId, activeSessions: active };
}

export async function pauseSupervisorsBeforeUpdate(
  plan: UpdateLifecyclePlan,
): Promise<boolean> {
  const shouldStop = plan.runningBeforeUpdate || plan.activeSessions.length > 0;
  if (!shouldStop) return false;

  if (plan.activeSessions.length > 0) {
    const noun = plan.activeSessions.length === 1 ? "session" : "sessions";
    console.log(
      chalk.yellow(
        `\n${plan.activeSessions.length} active ${noun} will be paused and restored after the update.`,
      ),
    );
    for (const s of plan.activeSessions.slice(0, 5)) {
      console.log(chalk.dim(`    • ${s.id}  (${s.status})`));
    }
    if (plan.activeSessions.length > 5) {
      console.log(chalk.dim(`    … and ${plan.activeSessions.length - 5} more`));
    }
  } else {
    console.log(chalk.dim("\nAO is running; it will be restarted after the update."));
  }

  const stopExit = await runAoLifecycleCommand(["stop", "--yes"]);
  if (stopExit !== 0) {
    recordActivityEvent({
      source: "cli",
      kind: "cli.update_failed",
      level: "error",
      summary: `ao update failed: internal ao stop exited non-zero`,
      data: { exitCode: stopExit },
    });
    console.error(chalk.red(`\nAO update could not stop the running daemon (exit ${stopExit}).`));
    process.exit(stopExit);
  }

  return true;
}

export async function verifyUpdatePause(_plan: UpdateLifecyclePlan): Promise<boolean> {
  const afterStop = await getUpdateLifecyclePlan();
  if (afterStop.runningBeforeUpdate || afterStop.activeSessions.length > 0) {
    recordActivityEvent({
      source: "cli",
      kind: "cli.update_failed",
      level: "error",
      summary: `ao update failed: AO still appears active after internal ao stop`,
      data: {
        runningAfterStop: afterStop.runningBeforeUpdate,
        activeSessionCount: afterStop.activeSessions.length,
        activeSessionIds: afterStop.activeSessions.map((s) => s.id).slice(0, 20),
      },
    });
    console.error(
      chalk.red(
        "\nAO update stopped before installing because AO still appears to be running after `ao stop --yes`.",
      ),
    );
    if (afterStop.activeSessions.length > 0) {
      console.error(chalk.dim("Still-active sessions:"));
      for (const s of afterStop.activeSessions.slice(0, 5)) {
        console.error(chalk.dim(`    • ${s.id}  (${s.status})`));
      }
      if (afterStop.activeSessions.length > 5) {
        console.error(chalk.dim(`    … and ${afterStop.activeSessions.length - 5} more`));
      }
    }
    console.error(chalk.dim("Run `ao stop` and retry `ao update` after AO is fully stopped."));
    return false;
  }
  return true;
}

export function shouldRestartAfterUpdate(
  plan: UpdateLifecyclePlan,
  didStop: boolean,
): boolean {
  return didStop && plan.runningBeforeUpdate;
}

export async function restartAoAfterUpdate(
  plan: UpdateLifecyclePlan,
  opts: { restore: boolean },
): Promise<void> {
  const args = ["start"];
  if (plan.primaryProjectId) args.push(plan.primaryProjectId);
  args.push(opts.restore ? "--restore" : "--no-restore");

  console.log(chalk.dim(`\nRestarting AO: ao ${args.join(" ")}`));
  const exitCode = await runAoLifecycleCommand(args);
  if (exitCode !== 0) {
    recordActivityEvent({
      source: "cli",
      kind: "cli.update_restart_failed",
      level: "error",
      summary: `ao update could not restart AO after install`,
      data: { exitCode, args },
    });
    console.error(
      chalk.yellow(
        `\nAO was updated, but \`ao ${args.join(" ")}\` failed with exit ${exitCode}. ` +
          `Run it manually to restore your sessions.`,
      ),
    );
    process.exit(exitCode);
  }
}

export function runAoLifecycleCommand(args: string[]): Promise<number> {
  return new Promise<number>((resolveExit) => {
    const child = spawn("ao", args, {
      stdio: "inherit",
      shell: isWindows(),
      windowsHide: true,
    });
    child.on("error", (error) => {
      console.error(chalk.yellow(`Could not run ao ${args.join(" ")}: ${error.message}`));
      resolveExit(1);
    });
    child.on("exit", (code, signal) => {
      resolveExit(signal ? 1 : (code ?? 1));
    });
  });
}
