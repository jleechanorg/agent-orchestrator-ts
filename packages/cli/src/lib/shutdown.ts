/**
 * SIGINT/SIGTERM shutdown handler for the long-running `ao start` process.
 *
 * Installs `process.once` listeners that perform a full graceful shutdown:
 * stop lifecycle workers, kill all active sessions, sweep registered daemon
 * children, then unregister from running.json and exit.
 *
 * Cherry-picked from upstream ComposioHQ/agent-orchestrator#7d324b53
 * and adapted for our fork's API surface (@jleechanorg/ao-core).
 */

import {
  isTerminalSession,
  loadConfig,
  markDaemonShutdownHandlerInstalled,
  sweepDaemonChildren,
} from "@jleechanorg/ao-core";
import { getSessionManager } from "./create-session-manager.js";
import { stopLifecycleWorker } from "./lifecycle-service.js";
import { stopProjectSupervisor } from "./project-supervisor.js";
import { unregister } from "./running-state.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ShutdownContext {
  /** Path to the orchestrator config; re-read at shutdown time so any
   *  config edits since startup are honored. */
  configPath: string;
  /** Project this `ao start` invocation owns; used to scope session kills. */
  projectId: string;
}

// Module-level guards so a second call to installShutdownHandlers within
// the same process is a no-op (vs. registering duplicate listeners that
// would each race to unregister / process.exit on signal).
let handlersInstalled = false;
let shuttingDown = false;

export function isShutdownInProgress(): boolean {
  return shuttingDown;
}

/**
 * Install SIGINT/SIGTERM handlers. Process-wide idempotent — calling
 * this more than once is a no-op. Only the first signal triggers
 * cleanup; subsequent signals are ignored until the 10-second
 * force-exit timer fires.
 */
export function installShutdownHandlers(ctx: ShutdownContext): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  markDaemonShutdownHandlerInstalled();

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    const exitCode = signal === "SIGINT" ? 130 : 0;

    try {
      stopProjectSupervisor();
    } catch {
      // Best-effort — never block shutdown on observability.
    }

    const forceExit = setTimeout(() => process.exit(exitCode), SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    void (async () => {
      try {
        const shutdownConfig = loadConfig(ctx.configPath);
        const sm = await getSessionManager(shutdownConfig);
        const allSessions = await sm.list();
        const activeSessions = allSessions.filter((s) => !isTerminalSession(s));

        for (const session of activeSessions) {
          try {
            await sm.kill(session.id);
          } catch {
            // Best-effort per session
          }
        }

        // Stop lifecycle workers after sessions are killed
        try {
          await stopLifecycleWorker(shutdownConfig, ctx.projectId);
        } catch {
          // Best-effort
        }
      } catch {
        // Best-effort — continue to sweep/unregister even if cleanup fails
      }

      // Always sweep and unregister regardless of earlier failures
      try {
        await sweepDaemonChildren({ ownerPid: process.pid });
      } catch {
        // Best-effort
      }
      try {
        await unregister();
      } catch {
        // Best-effort
      }
      process.exit(exitCode);
    })();
  };

  process.once("SIGINT", (sig) => {
    shutdown(sig);
  });
  process.once("SIGTERM", (sig) => {
    shutdown(sig);
  });
}
