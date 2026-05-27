import type { Command } from "commander";
import { executeScriptCommand } from "../lib/script-runner.js";
import {
  getUpdateLifecyclePlan,
  pauseSupervisorsBeforeUpdate,
  verifyUpdatePause,
  shouldRestartAfterUpdate,
  restartAoAfterUpdate,
} from "../lib/update-lifecycle.js";

export function registerUpdate(program: Command): void {
  program
    .command("update")
    .description(
      "Fast-forward the local install repo, rebuild critical packages, and run smoke tests",
    )
    .option("--skip-smoke", "Skip smoke tests after rebuilding")
    .option("--smoke-only", "Run smoke tests without fetching or rebuilding")
    .option("--no-restore", "Restart AO after updating but do not restore stopped sessions")
    .action(
      async (opts: { skipSmoke?: boolean; smokeOnly?: boolean; restore?: boolean }) => {
        if (opts.skipSmoke && opts.smokeOnly) {
          console.error("`ao update` does not allow `--skip-smoke` together with `--smoke-only`.");
          process.exit(1);
        }

        const lifecyclePlan = await getUpdateLifecyclePlan();
        const didStop = await pauseSupervisorsBeforeUpdate(lifecyclePlan);
        if (didStop && !(await verifyUpdatePause(lifecyclePlan))) {
          process.exit(1);
        }

        const args: string[] = [];
        if (opts.skipSmoke) {
          args.push("--skip-smoke");
        }
        if (opts.smokeOnly) {
          args.push("--smoke-only");
        }

        try {
          await executeScriptCommand("ao-update.sh", args);
        } catch {
          if (shouldRestartAfterUpdate(lifecyclePlan, didStop)) {
            await restartAoAfterUpdate(lifecyclePlan, { restore: opts.restore !== false });
          }
          process.exit(1);
        }

        if (shouldRestartAfterUpdate(lifecyclePlan, didStop)) {
          await restartAoAfterUpdate(lifecyclePlan, { restore: opts.restore !== false });
        }
      },
    );
}
