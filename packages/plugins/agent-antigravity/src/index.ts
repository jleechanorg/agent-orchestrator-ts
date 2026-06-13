import { createAgentPlugin, type AgentPluginConfig } from "@jleechanorg/ao-plugin-agent-base";
import {
  type Agent,
  type AgentLaunchConfig,
  type PluginModule,
  type ProjectConfig,
  type Session,
  type ActivityDetection,
  shellEscape,
} from "@jleechanorg/ao-core";
import { expandHome } from "@jleechanorg/ao-core/paths";
import { execFileSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

export const manifest = {
  name: "antigravity",
  slot: "agent" as const,
  description: "Agent plugin: Antigravity CLI (agy)",
  version: "0.1.0",
  displayName: "Antigravity (agy)",
};

const antigravityConfig: AgentPluginConfig = {
  name: "antigravity",
  description: manifest.description,
  processName: "agy",
  command: "agy",
  configDir: ".gemini", // Antigravity uses .gemini folder
  permissionlessFlag: "--dangerously-skip-permissions",
};

const antigravityOverrides: Partial<Agent> = {
  getLaunchCommand(launchConfig: AgentLaunchConfig): string {
    const promptArg = launchConfig.prompt ? shellEscape(launchConfig.prompt) : '""';
    const parts = ["agy", "--prompt-interactive", promptArg];
    const permissions = launchConfig.permissions ?? "permissionless";
    if (permissions === "permissionless" || permissions === "auto-edit" || permissions === "skip") {
      parts.push("--dangerously-skip-permissions");
    }
    return parts.join(" ");
  },

  getEnvironment(launchConfig: AgentLaunchConfig): Record<string, string> {
    const baseAgent = createAgentPlugin(antigravityConfig);
    const baseEnv = baseAgent.getEnvironment(launchConfig);

    const userHome = os.homedir();
    const sessionHome = path.join(userHome, ".ao-sessions", launchConfig.sessionId);
    
    // Ensure session directory exists
    fs.mkdirSync(sessionHome, { recursive: true });

    // Point the session HOME's Library/Keychains at the user's REAL keychains so the macOS
    // Security framework can find the already-stored Antigravity OAuth token and git
    // credentials. The worker runs under $HOME=~/.ao-sessions/<id>, where
    // $HOME/Library/Keychains does not exist; any keychain read/write from that context
    // raises the GUI "A keychain cannot be found to store '<name>'" SecurityAgent modal on
    // the user's screen (names seen: "antigravity", "x-access-token", "jleechan2015").
    //
    // We do NOT try to detect "headless vs interactive" from terminal env vars
    // (TERM_PROGRAM/COLORTERM/SSH_TTY): AO workers run inside tmux, which sets those vars,
    // so that heuristic misclassified every background worker as interactive and the
    // keychain-bypass path never ran. Guessing execution context from the environment is
    // unreliable — we always symlink to the real keychains, which already contain the
    // needed entries, so reads succeed silently and no modal is shown.
    if (os.platform() === "darwin") {
      const sessionKeychainDir = path.join(sessionHome, "Library", "Keychains");
      const realKeychainDir = path.join(userHome, "Library", "Keychains");
      try {
        let isCorrectSymlink = false;
        try {
          const stat = fs.lstatSync(sessionKeychainDir);
          if (stat.isSymbolicLink()) {
            isCorrectSymlink = fs.readlinkSync(sessionKeychainDir) === realKeychainDir;
            if (!isCorrectSymlink) {
              fs.unlinkSync(sessionKeychainDir);
            }
          } else {
            // A real directory/file left by a prior (broken) run — remove it so we can symlink.
            fs.rmSync(sessionKeychainDir, { recursive: true, force: true });
          }
        } catch {
          // Path does not exist yet — nothing to clean up.
        }

        if (!isCorrectSymlink) {
          fs.mkdirSync(path.join(sessionHome, "Library"), { recursive: true });
          fs.symlinkSync(realKeychainDir, sessionKeychainDir);
        }
      } catch (err) {
        console.debug(`[antigravity] Failed to symlink login keychain: ${(err as Error).message}`);
      }
    }

    const srcGemini = path.join(userHome, ".gemini");
    const destGemini = path.join(sessionHome, ".gemini");
    
    const copyRecursiveSync = (src: string, dest: string) => {
      const exists = fs.existsSync(src);
      const stats = exists ? fs.lstatSync(src) : null;
      if (stats?.isSymbolicLink()) return;
      const isDirectory = stats?.isDirectory() ?? false;
      if (isDirectory) {
        fs.mkdirSync(dest, { recursive: true });
        fs.readdirSync(src).forEach((childItemName: string) => {
          if (
            childItemName === "tmp" ||
            childItemName === "history" ||
            childItemName === "antigravity-browser-profile" ||
            childItemName === "conversations" || // runtime-only; not needed for new sessions
            childItemName === "brain" ||         // runtime-only; not needed for new sessions
            childItemName === "worktrees" ||     // never inherit prior worktrees
            childItemName === "playground" ||    // runtime workspace, 400MB+, starts fresh each session
            childItemName === "antigravity-ide" || // IDE integration data, 400MB+, not needed in CLI sessions
            childItemName === "brain.backup" ||  // backup, not needed per-session
            childItemName === "implicit.backup" || // backup, not needed per-session
            childItemName === "scratch" ||       // runtime scratch space, starts fresh each session
            childItemName === "log"              // runtime logs, not needed for new sessions
          ) {
            return;
          }
          copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
        });
      } else {
        try {
          fs.copyFileSync(src, dest);
        } catch (err) {
          console.debug(`[antigravity] Failed to copy ${src}: ${(err as Error).message}`);
        }
      }
    };
    
    try {
      copyRecursiveSync(srcGemini, destGemini);
    } catch (err) {
      console.debug(`[antigravity] Failed to copy .gemini directory: ${(err as Error).message}`);
    }

    // Redirect conversations and brain to /tmp so they don't persist in the session dir.
    // /tmp is cleaned on reboot; sessions never need cross-session conversation history.
    const tmpBase = path.join(os.tmpdir(), `ao-${launchConfig.sessionId}`);
    for (const appDirName of ["antigravity", "antigravity-cli", "antigravity-ide"]) {
      const agDir = path.join(destGemini, appDirName);
      for (const sub of ["conversations", "brain"]) {
        const sessionSub = path.join(agDir, sub);
        const tmpSub = path.join(tmpBase, appDirName, sub);
        
        let needsSymlink = true;
        try {
          const stat = fs.lstatSync(sessionSub);
          if (stat.isSymbolicLink()) {
            try {
              fs.unlinkSync(sessionSub);
            } catch (err) {
              console.debug(`[antigravity] Failed to unlink dangling symlink ${sessionSub}: ${(err as Error).message}`);
              needsSymlink = false;
            }
          } else {
            // Already a real directory/file, do not overwrite/symlink
            needsSymlink = false;
          }
        } catch {
          // Entry doesn't exist, we can proceed
        }

        if (needsSymlink) {
          try {
            fs.mkdirSync(tmpSub, { recursive: true });
            fs.mkdirSync(path.dirname(sessionSub), { recursive: true });
            fs.symlinkSync(tmpSub, sessionSub);
          } catch (err) {
            console.debug(`[antigravity] Failed to symlink ${sessionSub} to ${tmpSub}: ${(err as Error).message}`);
          }
        }
      }
    }

    // Disable session retention inside settings.json for the session to prevent extra bloat
    const settingsPath = path.join(destGemini, "settings.json");
    if (fs.existsSync(settingsPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const settings = parsed as Record<string, unknown>;
          if (!settings["general"] || typeof settings["general"] !== "object" || Array.isArray(settings["general"])) {
            settings["general"] = {};
          }
          const general = settings["general"] as Record<string, unknown>;
          if (!general["sessionRetention"] || typeof general["sessionRetention"] !== "object" || Array.isArray(general["sessionRetention"])) {
            general["sessionRetention"] = {};
          }
          const sessionRetention = general["sessionRetention"] as Record<string, unknown>;
          sessionRetention["enabled"] = false;
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
        }
      } catch (err) {
        console.debug(`[antigravity] Failed to update settings.json: ${(err as Error).message}`);
      }
    }

    // Automatically trust the project workspace path in the session config AND the global config
    // to completely prevent trust prompt deadlocks when HOME is reset in interactive shells.
    const trustedPaths = [
      path.join(destGemini, "trustedFolders.json"),
      path.join(userHome, ".gemini", "trustedFolders.json"),
    ];

    for (const trustedFoldersPath of trustedPaths) {
      // For the global trustedFolders, use a simple lock file to prevent concurrent races
      const isGlobal = trustedFoldersPath === path.join(userHome, ".gemini", "trustedFolders.json");
      const lockPath = isGlobal ? path.join(userHome, ".gemini", "trustedFolders.lock") : null;
      let releaseLock = () => {};
      let lockAcquired = false;

      if (lockPath) {
        try {
          fs.mkdirSync(path.dirname(lockPath), { recursive: true });
          try {
            fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
            lockAcquired = true;
            releaseLock = () => {
              try {
                if (fs.existsSync(lockPath)) {
                  const content = fs.readFileSync(lockPath, "utf-8").trim();
                  if (content === String(process.pid)) {
                    fs.unlinkSync(lockPath);
                  }
                }
              } catch {
                // ignore
              }
            };
          } catch (err: unknown) {
            const errWithCode = err as { code?: string };
            if (errWithCode.code === "EEXIST") {
              // Lock exists. Check if it's stale (older than 10s)
              try {
                const stat = fs.statSync(lockPath);
                if (Date.now() - stat.mtimeMs > 10000) {
                  try {
                    fs.unlinkSync(lockPath);
                    // Try to acquire one more time
                    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
                    lockAcquired = true;
                    releaseLock = () => {
                      try {
                        if (fs.existsSync(lockPath)) {
                          const content = fs.readFileSync(lockPath, "utf-8").trim();
                          if (content === String(process.pid)) {
                            fs.unlinkSync(lockPath);
                          }
                        }
                      } catch {
                        // ignore
                      }
                    };
                  } catch {
                    // ignore
                  }
                }
              } catch {
                // ignore
              }
            } else {
              throw err;
            }
          }
        } catch (lockErr) {
          console.debug(`[antigravity] Failed to acquire lock for trustedFolders: ${(lockErr as Error).message}`);
        }
      }

      try {
        let trustedFolders: Record<string, string> = {};
        let shouldWrite = true;

        if (lockPath && !lockAcquired) {
          console.debug(`[antigravity] Lock acquisition timed out for ${trustedFoldersPath}, skipping write to avoid clobbering.`);
          shouldWrite = false;
        }

        if (shouldWrite && fs.existsSync(trustedFoldersPath)) {
          try {
            const raw = fs.readFileSync(trustedFoldersPath, "utf-8").trim();
            if (raw) {
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                trustedFolders = parsed as Record<string, string>;
              }
            }
          } catch (e) {
            console.debug(`[antigravity] Failed to parse trustedFolders.json at ${trustedFoldersPath}, skipping write to avoid clobbering: ${(e as Error).message}`);
            shouldWrite = false;
          }
        }
        
        if (shouldWrite) {
          const pathsToTrust = [
            launchConfig.projectConfig.path,
            launchConfig.workspacePath,
            "/tmp",
            "/private/tmp",
            os.tmpdir(),
          ].filter(Boolean) as string[];

          for (let p of pathsToTrust) {
            // Canonical helper expands ~/...; bare ~ is the homedir itself.
            p = p === "~" ? userHome : expandHome(p);
            trustedFolders[p] = "TRUST_FOLDER";
            try {
              const resolvedPath = fs.realpathSync(p);
              trustedFolders[resolvedPath] = "TRUST_FOLDER";
            } catch {
              // ignore if realpath fails
            }
          }
          
          fs.mkdirSync(path.dirname(trustedFoldersPath), { recursive: true });
          fs.writeFileSync(trustedFoldersPath, JSON.stringify(trustedFolders, null, 2), "utf-8");
        }
      } catch (err) {
        console.debug(`[antigravity] Failed to update trustedFolders.json at ${trustedFoldersPath}: ${(err as Error).message}`);
      } finally {
        releaseLock();
      }
    }

    return {
      ...baseEnv,
      HOME: sessionHome,
      // Pin COLIMA_HOME to the user's real home so any subprocess in the worker
      // that calls `colima start` or `docker compose up` reuses the host's main
      // colima VM (or its socket) instead of deriving COLIMA_HOME from the
      // overridden session HOME and bootstrapping a fresh per-worker VM at
      // ~/.ao-sessions/<id>/.colima/ (~2GB each, accumulating to dozens of
      // stale VMs across runs). See PR for the wa-2327 incident.
      //
      // DOCKER_HOST is only pinned on darwin (where colima is the default
      // docker provider). On Linux, the user typically has native Docker with
      // /var/run/docker.sock; pointing DOCKER_HOST at the colima socket would
      // break every docker call.
      //
      // Both env vars use `??` so a value already in baseEnv (caller override
      // or a future field) wins over our default.
      COLIMA_HOME: baseEnv.COLIMA_HOME ?? path.join(userHome, ".colima"),
      DOCKER_HOST:
        baseEnv.DOCKER_HOST
        ?? (os.platform() === "darwin"
          ? `unix://${path.join(userHome, ".colima", "default", "docker.sock")}`
          : undefined),
      // Clear these to prevent the spawned CLI from inheriting parent agent context
      ANTIGRAVITY_PROJECT_ID: "",
      ANTIGRAVITY_TRAJECTORY_ID: "",
    };
  },

  async getRestoreCommand(_session: Session, _project: ProjectConfig): Promise<string | null> {
    return null;
  },

  async getActivityState(
    session: Session,
    _readyThresholdMs?: number,
  ): Promise<ActivityDetection | null> {
    // For Antigravity, we rely on process checking and terminal-output activity classification
    const exitedAt = new Date();
    if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
    const isProcessRunning = this.isProcessRunning;
    if (!isProcessRunning) return null;
    const running = await isProcessRunning(session.runtimeHandle);
    if (!running) return { state: "exited", timestamp: exitedAt };
    
    // We don't parse the binary .pb session files, so we return null to fall back
    // to terminal-output classification in the runner loop.
    return null;
  },
};

export function create(): Agent {
  return createAgentPlugin(antigravityConfig, antigravityOverrides);
}

export function detect(): boolean {
  try {
    // Verify agy is installed and accessible
    execFileSync("agy", ["help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
