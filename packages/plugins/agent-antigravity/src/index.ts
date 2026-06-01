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

    // Symlink the real keychain dir so Security framework can find/store tokens.
    // macOS Security looks at $HOME/Library/Keychains — without this, headless
    // agy workers show "A keychain cannot be found to store 'antigravity.'"
    // NOTE: Symlinking the user's real ~/Library/Keychains into headless background
    // worker sessions causes macOS Security framework to intercept the request and
    // constantly popup GUI Keychain Not Found / login credential authorization prompts.
    // To prevent this, we avoid symlinking the user's real system keychains.
    if (os.platform() === "darwin") {
      const sessionKeychainDir = path.join(sessionHome, "Library", "Keychains");
      try {
        const isTest = typeof process.env.VITEST !== "undefined" || process.env.NODE_ENV === "test";
        const isInteractive =
          process.env.AO_INTERACTIVE === "true" ||
          (!!(
            process.env.TERM_PROGRAM ||
            process.env.COLORTERM ||
            process.env.SSH_TTY
          ) && process.env.AO_HEADLESS !== "true");
        const isHeadless = (process.env.AO_HEADLESS === "true") || (!isTest && !isInteractive);

        let needsSetup = false;
        let isSymlink = false;
        try {
          const stat = fs.lstatSync(sessionKeychainDir);
          isSymlink = stat.isSymbolicLink();
        } catch {
          needsSetup = true;
        }

        if (!needsSetup) {
          if (isHeadless) {
            // In headless Darwin mode, we want the keychain directory to be absent/empty to bypass keychain operations completely.
            // If it currently exists (either as a symlink or directory), we must remove it.
            try {
              if (isSymlink) {
                fs.unlinkSync(sessionKeychainDir);
                isSymlink = false;
              } else {
                fs.rmSync(sessionKeychainDir, { recursive: true, force: true });
              }
              needsSetup = true;
            } catch (err) {
              console.error(`[antigravity] Headless safety check: failed to remove existing keychain path ${sessionKeychainDir}: ${(err as Error).message}`);
              throw new Error(`Headless safety check failed: unable to remove existing keychain path ${sessionKeychainDir}`, { cause: err });
            }
          } else {
            // If we are in interactive mode, we always want it to be a symlink to the user's real keychains.
            // Recreate if it is not a symlink, or if it is a dangling symlink (target missing).
            if (!isSymlink || !fs.existsSync(sessionKeychainDir)) {
              try {
                if (isSymlink) {
                  fs.unlinkSync(sessionKeychainDir);
                } else {
                  fs.rmSync(sessionKeychainDir, { recursive: true, force: true });
                }
              } catch {
                // ignore
              }
              needsSetup = true;
            }
          }
        }

        if (needsSetup) {
          fs.mkdirSync(path.join(sessionHome, "Library"), { recursive: true });
          
          if (isHeadless) {
            // Headless macOS context: we do NOT want to symlink the real login keychain
            // to completely prevent any OS-level interactive prompts or deadlocks.
            // Also, we do NOT create any temporary keychain or mutate the default keychain.
            // Instead, we ensure the sessionKeychainDir is absent or empty.
            if (fs.existsSync(sessionKeychainDir) || isSymlink) {
              try {
                if (isSymlink) {
                  fs.unlinkSync(sessionKeychainDir);
                  isSymlink = false;
                } else {
                  fs.rmSync(sessionKeychainDir, { recursive: true, force: true });
                }
              } catch (unlinkErr) {
                console.error(`[antigravity] Headless safety check: failed to remove existing keychain path ${sessionKeychainDir}: ${(unlinkErr as Error).message}`);
                // Fail-closed as requested: throw to abort launch
                throw new Error(`Headless safety check failed: unable to remove existing keychain path ${sessionKeychainDir}`, { cause: unlinkErr });
              }
            }
          } else {
            // Interactive user GUI session: symlink the real keychain so the agent can read
            // and use the already-saved OAuth token from the real login keychain.
            try {
              if (fs.existsSync(sessionKeychainDir)) {
                fs.rmSync(sessionKeychainDir, { recursive: true, force: true });
              }
              fs.symlinkSync(path.join(userHome, "Library", "Keychains"), sessionKeychainDir);
            } catch (symlinkErr) {
              console.debug(`[antigravity] Failed to symlink login keychain: ${(symlinkErr as Error).message}`);
            }
          }
        }
      } catch (err) {
        if ((err as Error).message.includes("Headless safety check failed")) {
          throw err;
        }
        console.debug(`[antigravity] Failed to setup keychains: ${(err as Error).message}`);
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
            console.debug(`[antigravity] Failed to parse trustedFolders.json at ${trustedFoldersPath}, defaulting to empty to avoid deadlocks: ${(e as Error).message}`);
            trustedFolders = {};
            shouldWrite = true;
          }
        }
        
        if (shouldWrite) {
          const pathsToTrust = [
            launchConfig.projectConfig.path,
            launchConfig.workspacePath,
          ].filter(Boolean) as string[];

          for (const p of pathsToTrust) {
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
